import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import {
  basename,
  dirname,
  join,
  parse as parsePath,
  resolve as resolvePath,
  sep,
} from 'node:path';
import { inspect } from 'node:util';

import { describe, expect, it, vi } from 'vitest';

import { CancelToken } from '../../src/engine/cancel.js';
import { createRuntimeContext, hostPlatform } from '../../src/engine/context.js';
import {
  describePlan as describePlanWithMode,
  executeRun as executeRunWithMode,
  OUTPUT_TAIL_LINES,
  snapshotParentEnvironment,
  type ExecuteOptions,
} from '../../src/engine/executor.js';
import { resolveInputs, resolveInputsWithRegistry } from '../../src/engine/inputs.js';
import {
  buildPlan as buildPlanWithLocale,
  type ExecutionPlan,
  type PlanOptions,
} from '../../src/engine/plan.js';
import {
  isSecretString,
  MASK,
  SecretRegistry,
  secretValuesEqual,
} from '../../src/engine/secrets.js';
import type { EngineObserver, RunEvent, StepFinished } from '../../src/engine/events.js';
import type { Runner, SpawnOutcome, SpawnRequest } from '../../src/runners/base.js';
import {
  MAX_OUTPUT_LINE_BYTES,
  mergeSpawnEnvironment,
  OVERSIZED_OUTPUT_LINE_PLACEHOLDER,
} from '../../src/runners/spawnRunner.js';
import { parseManifest, parseManifestText } from '../../src/manifest/index.js';
import { serializeResult } from '../../src/results/writer.js';
import type { RunMode, RunResult } from '../../src/results/model.js';
import { resultV2Schema } from '../../src/results/schema.js';
import { InputError, InternalError } from '../../src/errors.js';

const HEAD = ['schemaVersion: 1', 'product:', '  name: Example', '  version: "1.0.0"'];
const TEST_LOCALE = 'en';
const TEST_MODE: RunMode = 'non-interactive';
const TEST_MANIFEST_DIR = resolvePath('/project');

const _checkStepFinishedCorrelation = (): void => {
  const identity = { kind: 'stepFinished', stepId: 'step', durationMs: 0 } as const;
  const valid: readonly StepFinished[] = [
    { ...identity, state: 'SUCCEEDED', exitCode: 0 },
    { ...identity, state: 'FAILED', exitCode: 1 },
    { ...identity, state: 'FAILED', exitCode: undefined },
    { ...identity, state: 'SKIPPED', exitCode: undefined },
    { ...identity, state: 'CANCELLED', exitCode: undefined },
    { ...identity, state: 'NOT_RUN', exitCode: undefined },
  ];
  // @ts-expect-error PENDING is never a terminal step event state
  const pending: StepFinished = { ...identity, state: 'PENDING', exitCode: undefined };
  // @ts-expect-error RUNNING is never a terminal step event state
  const running: StepFinished = { ...identity, state: 'RUNNING', exitCode: undefined };
  // @ts-expect-error SUCCEEDED step events require an exit code
  const succeededWithoutExitCode: StepFinished = {
    ...identity,
    state: 'SUCCEEDED',
    exitCode: undefined,
  };
  // @ts-expect-error SKIPPED step events never carry an exit code
  const skippedWithExitCode: StepFinished = { ...identity, state: 'SKIPPED', exitCode: 1 };
  // @ts-expect-error CANCELLED step events never carry an exit code
  const cancelledWithExitCode: StepFinished = {
    ...identity,
    state: 'CANCELLED',
    exitCode: 1,
  };
  // @ts-expect-error NOT_RUN step events never carry an exit code
  const notRunWithExitCode: StepFinished = { ...identity, state: 'NOT_RUN', exitCode: 1 };
  void valid;
  void pending;
  void running;
  void succeededWithoutExitCode;
  void skippedWithExitCode;
  void cancelledWithExitCode;
  void notRunWithExitCode;
};

const _checkObserverReturnContract = (): void => {
  const synchronousObserver: (event: RunEvent) => void = () => undefined;
  const syncObserver: EngineObserver = synchronousObserver;
  const asyncObserver: EngineObserver = async () => undefined;
  void syncObserver;
  void asyncObserver;
};

function executeRun(options: Omit<ExecuteOptions, 'mode'>): Promise<RunResult> {
  return executeRunWithMode({ ...options, mode: TEST_MODE });
}

function describePlan(options: { readonly plan: ExecutionPlan }): RunResult {
  return describePlanWithMode({ ...options, mode: TEST_MODE });
}

function buildPlan(
  options: Omit<PlanOptions, 'locale'> & { readonly locale?: string | undefined },
): ExecutionPlan {
  return buildPlanWithLocale({
    ...options,
    locale: Object.hasOwn(options, 'locale') ? options.locale : TEST_LOCALE,
  });
}

/** A runner whose behaviour per step is written into the test, so nothing real is spawned. */
function stubRunner(
  behave: (request: SpawnRequest) => SpawnOutcome | Promise<SpawnOutcome>,
): Runner {
  return { run: async (request) => behave(request) };
}

function setup(
  lines: readonly string[],
  options: {
    overrides?: ReadonlyMap<string, string>;
    failFast?: boolean;
    environment?: Readonly<Record<string, string | undefined>>;
    locale?: string | undefined;
  } = {},
): { plan: ExecutionPlan } {
  const failFastLine = options.failFast === false ? ['execution:', '  failFast: false'] : [];
  const environment = options.environment ?? {};
  const manifest = parseManifestText(
    [...HEAD, ...failFastLine, ...lines, ''].join('\n'),
    'installer.yaml',
    { manifestDir: TEST_MANIFEST_DIR },
  );
  const context = createRuntimeContext({
    manifestDir: TEST_MANIFEST_DIR,
    product: manifest.product,
    platform: hostPlatform(),
    environment,
  });
  const resolution = resolveInputs({
    manifest,
    context,
    ...(options.overrides === undefined ? {} : { overrides: options.overrides }),
  });
  return {
    plan: buildPlan({
      manifest,
      resolution,
      context,
      locale: Object.hasOwn(options, 'locale') ? options.locale : TEST_LOCALE,
    }),
  };
}

const TWO_STEPS = [
  'steps:',
  '  - id: first',
  '    run:',
  '      command: a',
  '  - id: second',
  '    run:',
  '      command: b',
];

const FROZEN_RESULT_STEP = [
  'inputs:',
  '  setting:',
  '    type: text',
  '    default: value',
  'steps:',
  '  - id: failed',
  '    run:',
  '      command: a',
];

describe('a run that succeeds', () => {
  it('walks every step, emits the event bracket, and counts what happened', async () => {
    const { plan } = setup(TWO_STEPS);
    const events: RunEvent[] = [];

    const result = await executeRun({
      plan,
      observer: (event) => events.push(event),
      runner: stubRunner((request) => {
        request.onOutput('stdout', `running ${request.command.argv[0]}`);
        return { kind: 'exited', exitCode: 0 };
      }),
    });

    expect(result).toMatchObject({
      status: 'succeeded',
      exitCode: 0,
      error: null,
      stepsTotal: 2,
      stepsExecuted: 2,
      stepsSucceeded: 2,
      nothingExecuted: false,
    });
    expect(resultV2Schema.safeParse(result).success).toBe(true);
    expect(events[0]?.kind).toBe('runStarted');
    expect(events.at(-1)?.kind).toBe('runFinished');
    expect(events.map((event) => event.kind)).toEqual([
      'runStarted',
      'stepStarted',
      'stepOutput',
      'stepFinished',
      'stepStarted',
      'stepOutput',
      'stepFinished',
      'runFinished',
    ]);
    expect(
      events
        .filter((event): event is StepFinished => event.kind === 'stepFinished')
        .map(({ state, exitCode }) => ({ state, exitCode })),
    ).toEqual([
      { state: 'SUCCEEDED', exitCode: 0 },
      { state: 'SUCCEEDED', exitCode: 0 },
    ]);
  });

  it('contains a rejected Promise observer without waiting for it', async () => {
    const { plan } = setup(['steps: []']);
    let rejectObserver!: (reason?: unknown) => void;
    const returned = new Promise<never>((_resolve, reject) => {
      rejectObserver = reject;
    });
    const then = vi.spyOn(returned, 'then');
    const observed: RunEvent[] = [];
    const observe = (event: RunEvent): Promise<never> => {
      observed.push(event);
      return returned;
    };

    const result = await executeRun({
      plan,
      observer: observe,
    });

    expect(result.status).toBe('succeeded');
    expect(observed.map((event) => event.kind)).toEqual(['runStarted', 'runFinished']);
    expect(then).toHaveBeenCalledTimes(2);
    expect(then.mock.calls.every(([, onRejected]) => typeof onRejected === 'function')).toBe(true);

    rejectObserver(new Error('observer rejection'));
    await Promise.resolve();
  });

  it('does not inspect a foreign then method returned by an observer', async () => {
    const { plan } = setup(['steps: []']);
    const then = vi.fn();
    const observed: RunEvent[] = [];
    const observe = (event: RunEvent) => {
      observed.push(event);
      return { then };
    };
    const observer: EngineObserver = observe;

    const result = await executeRun({ plan, observer });

    expect(result.status).toBe('succeeded');
    expect(observed.map((event) => event.kind)).toEqual(['runStarted', 'runFinished']);
    expect(then).not.toHaveBeenCalled();
  });

  it('hands every child the run and step ids', async () => {
    const { plan } = setup(TWO_STEPS);
    const seen: string[] = [];

    await executeRun({
      plan,
      runner: stubRunner((request) => {
        seen.push(`${request.extraEnv['RUNE_STEP_ID']}`);
        expect(request.extraEnv['RUNE_RUN_ID']).toBeTruthy();
        return { kind: 'exited', exitCode: 0 };
      }),
    });

    expect(seen).toEqual(['first', 'second']);
  });

  it('keeps elapsed durations non-negative when the wall clock moves backwards', async () => {
    const { plan } = setup(['steps:', '  - id: first', '    run:', '      command: a']);
    const events: RunEvent[] = [];
    const startedAt = new Date('2030-01-01T00:00:00.000Z');
    const finishedAt = new Date('2029-12-31T23:59:00.000Z');
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(startedAt);

    try {
      const result = await executeRun({
        plan,
        observer: (event) => events.push(event),
        runner: stubRunner(() => {
          vi.setSystemTime(finishedAt);
          return { kind: 'exited', exitCode: 0 };
        }),
      });
      const stepFinished = events.find((event) => event.kind === 'stepFinished');

      expect(result.startedAt).toBe(startedAt.toISOString());
      expect(result.finishedAt).toBe(finishedAt.toISOString());
      expect(result.durationMs).toBeGreaterThanOrEqual(0);
      expect(result.steps[0]?.durationMs).toBeGreaterThanOrEqual(0);
      expect(stepFinished).toMatchObject({
        kind: 'stepFinished',
        durationMs: result.steps[0]?.durationMs,
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it('shares one frozen parent-environment snapshot across the complete run', async () => {
    const { plan } = setup(TWO_STEPS);
    const environmentName = 'RUNE_EXECUTOR_PARENT_ENV_SNAPSHOT_TEST';
    const snapshotValue = 'captured-before-run-started';
    const previousValue = process.env[environmentName];
    const events: RunEvent[] = [];
    const parentEnvironments: SpawnRequest['parentEnv'][] = [];
    process.env[environmentName] = snapshotValue;

    try {
      const result = await executeRun({
        plan,
        observer: (event) => {
          events.push(event);
          if (event.kind === 'runStarted') {
            process.env[environmentName] = 'changed-by-observer';
          }
        },
        runner: stubRunner((request) => {
          parentEnvironments.push(request.parentEnv);
          expect(Object.isFrozen(request.parentEnv)).toBe(true);
          expect(request.parentEnv[environmentName]).toBe(snapshotValue);
          expect(() => {
            (request.parentEnv as Record<string, string | undefined>)[environmentName] =
              'changed-by-runner';
          }).toThrow(TypeError);
          process.env[environmentName] = `changed-between-steps-${parentEnvironments.length}`;
          return { kind: 'exited', exitCode: 0 };
        }),
      });

      expect(parentEnvironments).toHaveLength(2);
      expect(parentEnvironments[1]).toBe(parentEnvironments[0]);
      expect(process.env[environmentName]).toBe('changed-between-steps-2');
      expect(JSON.stringify({ events, result })).not.toContain(snapshotValue);
    } finally {
      if (previousValue === undefined) {
        delete process.env[environmentName];
      } else {
        process.env[environmentName] = previousValue;
      }
    }
  });

  it('keeps manifest-relative execution stable when RunStarted changes cwd', async () => {
    const root = mkdtempSync(join(tmpdir(), 'rune-executor-manifest-anchor-'));
    const callerA = join(root, 'caller-a');
    const callerB = join(root, 'caller-b');
    const expectedManifestDir = join(callerA, 'manifest-root');
    const previousCwd = process.cwd();
    mkdirSync(callerA);
    mkdirSync(callerB);

    try {
      process.chdir(callerA);
      const manifest = parseManifestText(
        [
          ...HEAD,
          'steps:',
          '  - id: anchored',
          '    run:',
          '      command: scripts/tool',
          '      args: ["${manifestDir}"]',
          '',
        ].join('\n'),
        'installer.yaml',
        { manifestDir: 'manifest-root' },
      );
      const context = createRuntimeContext({
        manifestDir: expectedManifestDir,
        product: manifest.product,
        platform: hostPlatform(),
        environment: {},
      });
      const resolution = resolveInputs({ manifest, context });
      const plan = buildPlan({ manifest, resolution, context });

      const result = await executeRun({
        plan,
        observer: (event) => {
          if (event.kind === 'runStarted') {
            process.chdir(callerB);
          }
        },
        runner: stubRunner((request) => {
          expect(request.command.argv).toEqual([
            resolvePath(expectedManifestDir, 'scripts', 'tool'),
            expectedManifestDir,
          ]);
          expect(request.command.cwd).toBe(expectedManifestDir);
          return { kind: 'exited', exitCode: 0 };
        }),
      });

      expect(result.status).toBe('succeeded');
      expect(process.cwd()).toBe(callerB);
    } finally {
      process.chdir(previousCwd);
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('removes only declared input controls with Windows name semantics', () => {
    const parentEnv = snapshotParentEnvironment(
      {
        RUNE_INPUT_TOKEN: 'discarded-token',
        rune_input_install_dir: 'discarded-directory',
        RUNE_INPUT_UNDECLARED: 'keep-control',
        KEEP_ME: 'keep-value',
      },
      ['token', 'install-dir'],
      'win32',
    );

    expect(parentEnv).toEqual({
      RUNE_INPUT_UNDECLARED: 'keep-control',
      KEEP_ME: 'keep-value',
    });
    expect(Object.isFrozen(parentEnv)).toBe(true);

    const spawnEnv = mergeSpawnEnvironment(
      parentEnv,
      { rune_input_token: 'explicit-command-value' },
      {},
      'win32',
    );
    expect(spawnEnv).toEqual({
      RUNE_INPUT_UNDECLARED: 'keep-control',
      KEEP_ME: 'keep-value',
      rune_input_token: 'explicit-command-value',
    });
  });

  it('keeps a disabled environment secret out of the runner parent and every sink', async () => {
    const variable = 'RUNE_INPUT_TOKEN';
    const secret = 'discarded-environment-secret';
    const previousValue = process.env[variable];
    process.env[variable] = secret;

    try {
      const { plan } = setup(
        [
          'inputs:',
          '  enabled:',
          '    type: boolean',
          '    default: false',
          '  token:',
          '    type: secret',
          '    when: "${enabled}"',
          'steps:',
          '  - id: inspect',
          '    run:',
          '      command: a',
        ],
        { environment: { [variable]: secret } },
      );
      const events: RunEvent[] = [];

      const result = await executeRun({
        plan,
        observer: (event) => events.push(event),
        runner: stubRunner((request) => {
          expect(request.parentEnv[variable]).toBeUndefined();
          expect(
            Object.keys(request.parentEnv).some(
              (name) => name.toUpperCase() === variable.toUpperCase(),
            ),
          ).toBe(false);
          request.onOutput('stderr', `discarded value: ${secret}`);
          return { kind: 'exited', exitCode: 1 };
        }),
      });

      expect(result.inputs.find((input) => input.id === 'token')).toMatchObject({
        value: null,
        source: 'environment',
        secret: true,
        enabled: false,
        ignored: 'input disabled',
      });
      expect(events.find((event) => event.kind === 'stepOutput')).toMatchObject({
        line: 'discarded value: ***',
      });
      expect(result.steps[0]?.outputTail?.[0]).toEqual({
        stream: 'stderr',
        line: 'discarded value: ***',
      });
      expect(JSON.stringify({ events, result })).not.toContain(secret);
    } finally {
      if (previousValue === undefined) {
        delete process.env[variable];
      } else {
        process.env[variable] = previousValue;
      }
    }
  });

  it('projects real output into both the event and failed-step tail JSON fields', async () => {
    const quoted = '""';
    const { plan } = setup(
      [
        'inputs:',
        '  token:',
        '    type: secret',
        'steps:',
        '  - id: output',
        '    run:',
        '      command: a',
      ],
      { overrides: new Map([['token', String.raw`\"\"`]]) },
    );
    const events: RunEvent[] = [];

    const result = await executeRun({
      plan,
      observer: (event) => events.push(event),
      runner: stubRunner((request) => {
        request.onOutput('stdout', quoted);
        return { kind: 'exited', exitCode: 1 };
      }),
    });

    expect(events.find((event) => event.kind === 'stepOutput')).toMatchObject({
      stepId: 'output',
      stream: 'stdout',
      line: MASK,
    });
    expect(result.steps[0]?.outputTail?.[0]).toEqual({ stream: 'stdout', line: MASK });
  });

  it('projects a synthetic output diagnostic before publishing and retaining it', async () => {
    const diagnostic = 'RUNE-403 step "start" command was not found';
    const encodedDiagnostic = JSON.stringify(diagnostic).slice(1, -1);
    const { plan } = setup(
      [
        'inputs:',
        '  token:',
        '    type: secret',
        'steps:',
        '  - id: start',
        '    run:',
        '      command: absent',
      ],
      { overrides: new Map([['token', encodedDiagnostic]]) },
    );
    const events: RunEvent[] = [];

    const result = await executeRun({
      plan,
      observer: (event) => events.push(event),
      runner: stubRunner(() => ({ kind: 'failedToStart', reason: 'commandNotFound' })),
    });

    expect(events.filter((event) => event.kind === 'stepOutput')).toEqual([
      { kind: 'stepOutput', stepId: 'start', stream: 'stderr', line: MASK },
    ]);
    expect(result.steps[0]?.outputTail).toEqual([{ stream: 'stderr', line: MASK }]);
  });

  it('freezes every event and the complete returned result graph', async () => {
    const { plan } = setup(FROZEN_RESULT_STEP);
    const events: RunEvent[] = [];

    const result = await executeRun({
      plan,
      observer: (event) => events.push(event),
      runner: stubRunner((request) => {
        request.onOutput('stderr', 'failure details');
        return { kind: 'exited', exitCode: 1 };
      }),
    });

    expect(events.map((event) => Object.isFrozen(event))).toEqual([
      true,
      true,
      true,
      true,
      true,
      true,
    ]);
    expect(events[0]?.kind === 'runStarted' && Object.isFrozen(events[0].plan)).toBe(true);
    const finishedEvent = events.at(-1);
    expect(finishedEvent?.kind === 'runFinished' && Object.isFrozen(finishedEvent.result)).toBe(
      true,
    );

    const step = result.steps[0];
    const input = result.inputs[0];
    expect(step).toBeDefined();
    expect(input).toBeDefined();
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.product)).toBe(true);
    expect(Object.isFrozen(result.manifest)).toBe(true);
    expect(Object.isFrozen(result.inputs)).toBe(true);
    expect(Object.isFrozen(input)).toBe(true);
    expect(Object.isFrozen(result.steps)).toBe(true);
    expect(Object.isFrozen(step)).toBe(true);
    expect(Object.isFrozen(step?.command)).toBe(true);
    expect(Object.isFrozen(step?.outputTail)).toBe(true);
    expect(Object.isFrozen(step?.outputTail?.[0])).toBe(true);
  });

  it('prevents a RunFinished observer from mutating its returned result', async () => {
    const { plan } = setup(FROZEN_RESULT_STEP);
    const events: RunEvent[] = [];
    let mutationWasSwallowed = false;

    const result = await executeRun({
      plan,
      observer: (event) => {
        events.push(event);
        if (event.kind === 'runFinished') {
          mutationWasSwallowed = true;
          (event.result as unknown as { status: string }).status = 'succeeded';
        }
      },
      runner: stubRunner((request) => {
        request.onOutput('stderr', 'failure details');
        return { kind: 'exited', exitCode: 1 };
      }),
    });

    expect(mutationWasSwallowed).toBe(true);
    expect(events.map((event) => event.kind)).toEqual([
      'runStarted',
      'stepStarted',
      'stepOutput',
      'stepOutput',
      'stepFinished',
      'runFinished',
    ]);
    expect(result).toMatchObject({ status: 'failed', exitCode: 1, stepsFailed: 1 });
  });

  it('does not expose mutable aliases for a RunFinished result', async () => {
    const { plan } = setup(FROZEN_RESULT_STEP);
    const attempts: boolean[] = [];
    const events: RunEvent[] = [];

    const result = await executeRun({
      plan,
      observer: (event) => {
        events.push(event);
        if (event.kind !== 'runFinished') {
          return;
        }
        const mutable = event.result as unknown as {
          status: string;
          exitCode: number;
          stepsFailed: number;
          product: { name: string };
          inputs: Array<{ id: string }>;
          steps: Array<{
            state: string;
            outputTail?: Array<{ line: string }>;
          }>;
        };
        const attempt = (change: () => void): void => {
          try {
            change();
          } catch {
            attempts.push(true);
          }
        };

        attempt(() => {
          mutable.status = 'succeeded';
        });
        attempt(() => {
          mutable.exitCode = 0;
        });
        attempt(() => {
          mutable.stepsFailed = 0;
        });
        attempt(() => {
          mutable.product.name = 'Changed';
        });
        attempt(() => {
          mutable.inputs[0]!.id = 'changed';
        });
        attempt(() => {
          mutable.steps[0]!.state = 'SUCCEEDED';
        });
        attempt(() => {
          mutable.steps[0]!.outputTail?.push({ line: 'changed' });
        });
        attempt(() => {
          mutable.steps[0]!.outputTail![0]!.line = 'changed';
        });
      },
      runner: stubRunner((request) => {
        request.onOutput('stderr', 'failure details');
        return { kind: 'exited', exitCode: 1 };
      }),
    });

    expect(attempts).toHaveLength(8);
    expect(result).toMatchObject({ status: 'failed', exitCode: 1, stepsFailed: 1 });
    expect(result.product).toEqual({ name: 'Example', version: '1.0.0' });
    expect(result.inputs[0]?.id).toBe('setting');
    expect(result.steps[0]).toMatchObject({ state: 'FAILED' });
    expect(result.steps[0]?.outputTail).toEqual([
      { stream: 'stderr', line: 'failure details' },
      {
        stream: 'stderr',
        line: 'RUNE-401 step "failed" exited with code 1; expected one of [0]',
      },
    ]);
    expect(
      events
        .filter((event): event is StepFinished => event.kind === 'stepFinished')
        .map(({ state, exitCode }) => ({ state, exitCode })),
    ).toEqual([{ state: 'FAILED', exitCode: 1 }]);
  });
});

describe('a run that fails', () => {
  it('stops at the first failure under failFast and marks the rest NOT_RUN', async () => {
    const { plan } = setup(TWO_STEPS);

    const result = await executeRun({
      plan,
      runner: stubRunner((request) => {
        request.onOutput('stderr', 'boom');
        return { kind: 'exited', exitCode: 3 };
      }),
    });

    expect(result).toMatchObject({
      status: 'failed',
      exitCode: 1,
      dryRun: false,
      error: null,
      stepsFailed: 1,
      stepsNotRun: 1,
    });
    expect(resultV2Schema.safeParse(result).success).toBe(true);
    expect(result.steps[0]?.state).toBe('FAILED');
    expect(result.steps[0]?.exitCode).toBe(3);
    expect(result.steps[1]?.state).toBe('NOT_RUN');
  });

  it('keeps walking without failFast, and the run still ends failed', async () => {
    const { plan } = setup(TWO_STEPS, { failFast: false });
    let call = 0;

    const result = await executeRun({
      plan,
      runner: stubRunner(() => ({ kind: 'exited', exitCode: (call += 1) === 1 ? 9 : 0 })),
    });

    expect(result).toMatchObject({ status: 'failed', stepsFailed: 1, stepsSucceeded: 1 });
  });

  it('keeps the masked tail of a failed step, and only of a failed step', async () => {
    const { plan } = setup(['inputs:', '  token:', '    type: secret', ...TWO_STEPS], {
      failFast: false,
      overrides: new Map([['token', 'super-secret']]),
    });
    let call = 0;

    const result = await executeRun({
      plan,
      runner: stubRunner((request) => {
        request.onOutput('stdout', 'the token is super-secret');
        return { kind: 'exited', exitCode: (call += 1) === 1 ? 1 : 0 };
      }),
    });

    expect(result.steps[0]?.outputTail).toEqual([
      { stream: 'stdout', line: 'the token is ***' },
      {
        stream: 'stderr',
        line: 'RUNE-401 step "first" exited with code 1; expected one of [0]',
      },
    ]);
    expect(result.steps[1]).not.toHaveProperty('outputTail');
  });

  it('keeps exactly the newest output tail lines in combined stream order', async () => {
    const { plan } = setup(['steps:', '  - id: noisy', '    run:', '      command: a']);
    const lines = Array.from({ length: OUTPUT_TAIL_LINES + 1 }, (_, index) => ({
      stream: index % 2 === 0 ? ('stdout' as const) : ('stderr' as const),
      line: `line-${index}`,
    }));

    const result = await executeRun({
      plan,
      runner: stubRunner((request) => {
        for (const { stream, line } of lines) {
          request.onOutput(stream, line);
        }
        return { kind: 'exited', exitCode: 1 };
      }),
    });

    expect(result.steps[0]?.outputTail).toEqual([
      ...lines.slice(2),
      {
        stream: 'stderr',
        line: 'RUNE-401 step "noisy" exited with code 1; expected one of [0]',
      },
    ]);
    expect(result.steps[0]?.outputTail).toHaveLength(OUTPUT_TAIL_LINES);
  });

  it.each([
    ['ASCII exactly at the limit', 'a'.repeat(MAX_OUTPUT_LINE_BYTES), false],
    ['ASCII one byte over the limit', 'a'.repeat(MAX_OUTPUT_LINE_BYTES + 1), true],
    ['multibyte UTF-8 exactly at the limit', 'é'.repeat(MAX_OUTPUT_LINE_BYTES / 2), false],
    ['multibyte UTF-8 one byte over the limit', `${'é'.repeat(MAX_OUTPUT_LINE_BYTES / 2)}x`, true],
  ])('bounds an injected runner output line: %s', async (_name, rawLine, omitted) => {
    const { plan } = setup(['steps:', '  - id: bounded', '    run:', '      command: a']);
    const events: RunEvent[] = [];

    const result = await executeRun({
      plan,
      observer: (event) => events.push(event),
      runner: stubRunner((request) => {
        request.onOutput('stdout', rawLine);
        return { kind: 'exited', exitCode: 0 };
      }),
    });

    expect(Buffer.byteLength(rawLine, 'utf8')).toBe(
      omitted ? MAX_OUTPUT_LINE_BYTES + 1 : MAX_OUTPUT_LINE_BYTES,
    );
    expect(events.filter((event) => event.kind === 'stepOutput')).toEqual([
      expect.objectContaining({
        stream: 'stdout',
        line: omitted ? OVERSIZED_OUTPUT_LINE_PLACEHOLDER : rawLine,
      }),
    ]);
    expect(result).toMatchObject({ status: 'succeeded', stepsSucceeded: 1 });
  });

  it('omits an oversized default-runner line before masking can split its secret', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'rune-bounded-output-'));
    try {
      const firstSecretHalf = 'recognizable-left-half-1234';
      const secondSecretHalf = 'recognizable-right-half-5678';
      const secret = firstSecretHalf + secondSecretHalf;
      const childScript =
        'const token = process.env.TOKEN ?? "";' +
        `process.stdout.write("x".repeat(${MAX_OUTPUT_LINE_BYTES - firstSecretHalf.length}) + ` +
        'token + "\\n");' +
        'process.stdout.write("follow " + token + "\\n");' +
        'process.exitCode = 9;';
      const manifest = parseManifestText(
        [
          ...HEAD,
          'inputs:',
          '  token:',
          '    type: secret',
          'steps:',
          '  - id: bounded',
          '    run:',
          `      command: ${JSON.stringify(process.execPath)}`,
          '      args:',
          '        - -e',
          `        - ${JSON.stringify(childScript)}`,
          '      env:',
          '        TOKEN: "${token}"',
          '',
        ].join('\n'),
        join(directory, 'installer.yaml'),
      );
      const context = createRuntimeContext({
        manifestDir: directory,
        product: manifest.product,
        platform: hostPlatform(),
        environment: {},
      });
      const resolution = resolveInputs({
        manifest,
        context,
        overrides: new Map([['token', secret]]),
      });
      const plan = buildPlan({ manifest, resolution, context });
      const events: RunEvent[] = [];

      const result = await executeRun({
        plan,
        observer: (event) => events.push(event),
      });

      const outputEvents = events.filter((event) => event.kind === 'stepOutput');
      expect(outputEvents.map((event) => event.line)).toEqual([
        OVERSIZED_OUTPUT_LINE_PLACEHOLDER,
        'follow ***',
        'RUNE-401 step "bounded" exited with code 9; expected one of [0]',
      ]);
      expect(result).toMatchObject({ status: 'failed', exitCode: 1, stepsFailed: 1 });
      expect(result.steps[0]?.outputTail).toEqual([
        { stream: 'stdout', line: OVERSIZED_OUTPUT_LINE_PLACEHOLDER },
        { stream: 'stdout', line: 'follow ***' },
        {
          stream: 'stderr',
          line: 'RUNE-401 step "bounded" exited with code 9; expected one of [0]',
        },
      ]);

      const serializedSinks = JSON.stringify({ events, result, tail: result.steps[0]?.outputTail });
      expect(serializedSinks).not.toContain(secret);
      expect(serializedSinks).not.toContain(firstSecretHalf);
      expect(serializedSinks).not.toContain(secondSecretHalf);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('masks a normalized secret cwd emitted by the default runner in every sink', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'rune-secret-cwd-'));
    const effectiveCwd = join(directory, 'effective-secret-cwd');
    const secretCwd = `discarded-segment${sep}..${sep}effective-secret-cwd`;
    mkdirSync(effectiveCwd);

    try {
      const childScript = 'process.stdout.write(process.cwd() + "\\n"); process.exitCode = 9;';
      const manifest = parseManifestText(
        [
          ...HEAD,
          'inputs:',
          '  workingDirectory:',
          '    type: secret',
          'steps:',
          '  - id: normalized-cwd',
          '    run:',
          `      command: ${JSON.stringify(process.execPath)}`,
          '      args:',
          '        - -e',
          `        - ${JSON.stringify(childScript)}`,
          '      cwd: "${workingDirectory}"',
          '',
        ].join('\n'),
        join(directory, 'installer.yaml'),
      );
      const context = createRuntimeContext({
        manifestDir: directory,
        product: manifest.product,
        platform: hostPlatform(),
        environment: {},
      });
      const resolution = resolveInputs({
        manifest,
        context,
        overrides: new Map([['workingDirectory', secretCwd]]),
      });
      const plan = buildPlan({ manifest, resolution, context });
      const events: RunEvent[] = [];

      const result = await executeRun({
        plan,
        observer: (event) => events.push(event),
      });

      expect(events.filter((event) => event.kind === 'stepOutput')).toEqual([
        {
          kind: 'stepOutput',
          stepId: 'normalized-cwd',
          stream: 'stdout',
          line: MASK,
        },
        {
          kind: 'stepOutput',
          stepId: 'normalized-cwd',
          stream: 'stderr',
          line: 'RUNE-401 step "normalized-cwd" exited with code 9; expected one of [0]',
        },
      ]);
      expect(result.steps[0]?.outputTail).toEqual([
        { stream: 'stdout', line: MASK },
        {
          stream: 'stderr',
          line: 'RUNE-401 step "normalized-cwd" exited with code 9; expected one of [0]',
        },
      ]);

      for (const serialized of [
        JSON.stringify(events),
        JSON.stringify(result),
        serializeResult(result),
      ]) {
        expect(serialized).not.toContain(effectiveCwd);
        expect(serialized).not.toContain(secretCwd);
      }
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('rejects a secret cwd that normalizes to the host root before starting the runner', async () => {
    const root = parsePath(tmpdir()).root;
    const manifestDir = join(root, 'base');
    const sentinel = 'F062A-DISCARDED-SEGMENT';
    const secretCwd = `${sentinel}${sep}..${sep}..`;
    const manifest = parseManifestText(
      [
        ...HEAD,
        'inputs:',
        '  workingDirectory:',
        '    type: secret',
        'steps:',
        '  - id: root-cwd',
        '    run:',
        `      command: ${JSON.stringify(process.execPath)}`,
        '      cwd: "${workingDirectory}"',
        '',
      ].join('\n'),
      join(manifestDir, 'installer.yaml'),
    );
    const context = createRuntimeContext({
      manifestDir,
      product: manifest.product,
      platform: hostPlatform(),
      environment: {},
    });
    const resolution = resolveInputs({
      manifest,
      context,
      overrides: new Map([['workingDirectory', secretCwd]]),
    });
    const run = vi.fn(() => ({ kind: 'exited', exitCode: 0 }) as const);
    const runner = stubRunner(run);

    expect(resolution.warnings).toEqual([]);

    let thrown: unknown;
    try {
      const plan = buildPlan({ manifest, resolution, context });
      await executeRun({ plan, runner });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(InputError);
    const error = thrown as InputError;
    expect(error.code).toBe('RUNE-202');
    expect(error.message).toBe('a derived secret value cannot be masked safely');
    expect(error.issues).toEqual([
      {
        code: 'RUNE-202',
        message: 'a derived secret value cannot be masked safely',
        location: undefined,
      },
    ]);
    expect(error.cause).toBeUndefined();
    const diagnostic = JSON.stringify(error);
    expect(diagnostic).not.toContain(sentinel);
    expect(diagnostic).not.toContain(secretCwd);
    expect(diagnostic).not.toContain(manifestDir);
    expect(diagnostic).not.toContain(root);
    expect(run).not.toHaveBeenCalled();
  });

  it('masks a normalized secret command path emitted by the default runner', async () => {
    const manifestDir = dirname(process.execPath);
    const secretCommand = `discarded-segment${sep}..${sep}${basename(process.execPath)}`;
    const childScript = 'process.stdout.write(process.execPath + "\\n"); process.exitCode = 9;';
    const manifest = parseManifestText(
      [
        ...HEAD,
        'inputs:',
        '  executable:',
        '    type: secret',
        'steps:',
        '  - id: normalized-command',
        '    run:',
        '      command: "${executable}"',
        '      args:',
        '        - -e',
        `        - ${JSON.stringify(childScript)}`,
        '',
      ].join('\n'),
      join(manifestDir, 'installer.yaml'),
    );
    const context = createRuntimeContext({
      manifestDir,
      product: manifest.product,
      platform: hostPlatform(),
      environment: {},
    });
    const resolution = resolveInputs({
      manifest,
      context,
      overrides: new Map([['executable', secretCommand]]),
    });
    const plan = buildPlan({ manifest, resolution, context });
    const events: RunEvent[] = [];

    const result = await executeRun({
      plan,
      observer: (event) => events.push(event),
    });

    expect(events.filter((event) => event.kind === 'stepOutput')).toEqual([
      {
        kind: 'stepOutput',
        stepId: 'normalized-command',
        stream: 'stdout',
        line: MASK,
      },
      {
        kind: 'stepOutput',
        stepId: 'normalized-command',
        stream: 'stderr',
        line: 'RUNE-401 step "normalized-command" exited with code 9; expected one of [0]',
      },
    ]);
    expect(result.steps[0]?.outputTail).toEqual([
      { stream: 'stdout', line: MASK },
      {
        stream: 'stderr',
        line: 'RUNE-401 step "normalized-command" exited with code 9; expected one of [0]',
      },
    ]);

    for (const serialized of [
      JSON.stringify(events),
      JSON.stringify(result),
      serializeResult(result),
    ]) {
      expect(serialized).not.toContain(process.execPath);
      expect(serialized).not.toContain(secretCommand);
    }
  });

  it('honours successExitCodes instead of assuming zero', async () => {
    const { plan } = setup([
      'steps:',
      '  - id: robocopy-style',
      '    run:',
      '      command: a',
      '      successExitCodes: [0, 1]',
    ]);

    const result = await executeRun({
      plan,
      runner: stubRunner(() => ({ kind: 'exited', exitCode: 1 })),
    });

    expect(result.status).toBe('succeeded');
  });

  it('fails and masks a signalled process without applying successExitCodes or inventing an exit code', async () => {
    const { plan } = setup(
      [
        'inputs:',
        '  token:',
        '    type: secret',
        'steps:',
        '  - id: signal-crash',
        '    run:',
        '      command: a',
        '      successExitCodes: [1]',
      ],
      { overrides: new Map([['token', 'signal-crash']]) },
    );

    const events: RunEvent[] = [];
    const result = await executeRun({
      plan,
      observer: (event) => events.push(event),
      runner: stubRunner(() => ({ kind: 'signalled' })),
    });

    expect(result).toMatchObject({ status: 'failed', exitCode: 1, stepsFailed: 1 });
    expect(result.steps[0]).toMatchObject({ state: 'FAILED', exitCode: null });
    expect(result.steps[0]?.outputTail).toEqual([
      {
        stream: 'stderr',
        line: 'RUNE-401 step "***" terminated by a signal',
      },
    ]);
    expect(
      events
        .filter((event): event is StepFinished => event.kind === 'stepFinished')
        .map(({ state, exitCode }) => ({ state, exitCode })),
    ).toEqual([{ state: 'FAILED', exitCode: undefined }]);
  });

  it('reports an exact non-success exit diagnostic with the configured success codes', async () => {
    const { plan } = setup([
      'steps:',
      '  - id: custom-codes',
      '    run:',
      '      command: a',
      '      successExitCodes: [0, 2, 4]',
    ]);

    const result = await executeRun({
      plan,
      runner: stubRunner(() => ({ kind: 'exited', exitCode: 3 })),
    });

    expect(result.steps[0]?.outputTail).toEqual([
      {
        stream: 'stderr',
        line: 'RUNE-401 step "custom-codes" exited with code 3; expected one of [0, 2, 4]',
      },
    ]);
  });

  it('replaces an oversized synthetic diagnostic in events and the output tail', async () => {
    const stepId = 'a'.repeat(MAX_OUTPUT_LINE_BYTES);
    const { plan } = setup(['steps:', `  - id: ${stepId}`, '    run:', '      command: a']);
    const events: RunEvent[] = [];

    const result = await executeRun({
      plan,
      observer: (event) => events.push(event),
      runner: stubRunner(() => ({ kind: 'exited', exitCode: 1 })),
    });

    const outputEvents = events.filter((event) => event.kind === 'stepOutput');
    expect(outputEvents).toEqual([
      {
        kind: 'stepOutput',
        stepId,
        stream: 'stderr',
        line: OVERSIZED_OUTPUT_LINE_PLACEHOLDER,
      },
    ]);
    expect(Buffer.byteLength(outputEvents[0]!.line, 'utf8')).toBeLessThanOrEqual(
      MAX_OUTPUT_LINE_BYTES,
    );
    expect(result.steps[0]?.outputTail).toEqual([
      { stream: 'stderr', line: OVERSIZED_OUTPUT_LINE_PLACEHOLDER },
    ]);
  });

  it.each([
    ['commandNotFound', 'RUNE-403 step "classified" command was not found'],
    ['invalidCwd', 'RUNE-404 step "classified" working directory is invalid'],
    ['shellRequired', 'RUNE-405 step "classified" requires an explicit command interpreter'],
    ['other', 'RUNE-401 step "classified" runner failed while starting the process'],
  ] as const)('reports failedToStart reason %s with a stable diagnostic', async (reason, line) => {
    const { plan } = setup(['steps:', '  - id: classified', '    run:', '      command: a']);

    const result = await executeRun({
      plan,
      runner: stubRunner(() => ({ kind: 'failedToStart', reason })),
    });

    expect(result.status).toBe('failed');
    expect(result.steps[0]?.outputTail).toEqual([{ stream: 'stderr', line }]);
  });

  it('masks secret collisions only after constructing the complete diagnostic', async () => {
    const secret = 'private-step\ncommand was not found';
    const { plan } = setup(
      [
        'inputs:',
        '  token:',
        '    type: secret',
        'steps:',
        '  - id: private-step',
        '    run:',
        '      command: a',
      ],
      { overrides: new Map([['token', secret]]) },
    );

    const result = await executeRun({
      plan,
      runner: stubRunner(() => ({ kind: 'failedToStart', reason: 'commandNotFound' })),
    });
    const line = result.steps[0]?.outputTail?.[0]?.line;

    expect(result.steps[0]?.outputTail).toEqual([
      { stream: 'stderr', line: 'RUNE-403 step "***" ***' },
    ]);
    expect(line).not.toContain('private-step');
    expect(line).not.toContain('command was not found');
  });

  it.each(['stdout', 'stderr'] as const)(
    'reports an exact value-free %s stream failure and preserves event order',
    async (stream) => {
      const { plan } = setup(['steps:', '  - id: unreadable', '    run:', '      command: a']);
      const events: RunEvent[] = [];

      const result = await executeRun({
        plan,
        observer: (event) => events.push(event),
        runner: stubRunner(() => ({ kind: 'streamFailed', stream })),
      });

      expect(result).toMatchObject({ status: 'failed', stepsFailed: 1 });
      expect(result.steps[0]?.outputTail).toEqual([
        {
          stream: 'stderr',
          line: `RUNE-401 step "unreadable" ${stream} stream could not be read`,
        },
      ]);
      expect(events.map((event) => event.kind)).toEqual([
        'runStarted',
        'stepStarted',
        'stepOutput',
        'stepFinished',
        'runFinished',
      ]);
    },
  );

  it('masks step-id and diagnostic-fragment collisions in a stream failure', async () => {
    const secret = 'private-stream-step\nstdout stream could not be read';
    const { plan } = setup(
      [
        'inputs:',
        '  token:',
        '    type: secret',
        'steps:',
        '  - id: private-stream-step',
        '    run:',
        '      command: a',
      ],
      { overrides: new Map([['token', secret]]) },
    );

    const result = await executeRun({
      plan,
      runner: stubRunner(() => ({ kind: 'streamFailed', stream: 'stdout' })),
    });
    const line = result.steps[0]?.outputTail?.[0]?.line;

    expect(line).toBe('RUNE-401 step "***" ***');
    expect(line).not.toContain('private-stream-step');
    expect(line).not.toContain('stdout stream could not be read');
  });

  it.each([
    { name: 'null', outcome: null, forbidden: undefined },
    {
      name: 'unknown kind',
      outcome: { kind: 'privateUnknownKind' },
      forbidden: 'privateUnknownKind',
    },
    {
      name: 'non-finite exit code',
      outcome: { kind: 'exited', exitCode: Number.NaN },
      forbidden: undefined,
    },
    {
      name: 'fractional exit code',
      outcome: { kind: 'exited', exitCode: 1.5 },
      forbidden: undefined,
    },
    {
      name: 'exit code above the safe integer range',
      outcome: { kind: 'exited', exitCode: Number.MAX_SAFE_INTEGER + 1 },
      forbidden: String(Number.MAX_SAFE_INTEGER + 1),
    },
    {
      name: 'exit code below the safe integer range',
      outcome: { kind: 'exited', exitCode: Number.MIN_SAFE_INTEGER - 1 },
      forbidden: String(Number.MIN_SAFE_INTEGER - 1),
    },
    {
      name: 'invalid stream',
      outcome: { kind: 'streamFailed', stream: 'privateStream' },
      forbidden: 'privateStream',
    },
    {
      name: 'invalid start reason',
      outcome: { kind: 'failedToStart', reason: 'privateReason' },
      forbidden: 'privateReason',
    },
  ])(
    'contains a malformed runner outcome ($name) as an internal contract failure',
    async ({ outcome, forbidden }) => {
      const { plan } = setup(TWO_STEPS, { failFast: false });
      const events: RunEvent[] = [];
      const runner: Runner = { run: async () => outcome as SpawnOutcome };

      let thrown: unknown;
      try {
        await executeRun({
          plan,
          observer: (event) => events.push(event),
          runner,
        });
      } catch (error) {
        thrown = error;
      }

      expect(thrown).toBeInstanceOf(InternalError);
      expect(thrown).toMatchObject({ code: 'RUNE-500' });
      expect(events.map((event) => event.kind)).toEqual([
        'runStarted',
        'stepStarted',
        'stepOutput',
        'stepFinished',
        'stepFinished',
        'runFinished',
      ]);
      expect(events.filter((event) => event.kind === 'runStarted')).toHaveLength(1);
      expect(events.filter((event) => event.kind === 'runFinished')).toHaveLength(1);

      const terminal = events.at(-1);
      expect(terminal?.kind).toBe('runFinished');
      const result = terminal?.kind === 'runFinished' ? terminal.result : undefined;
      expect(result).toMatchObject({
        status: 'internal_error',
        exitCode: 70,
        error: { code: 'RUNE-500' },
        stepsFailed: 1,
        stepsNotRun: 1,
        steps: [
          { state: 'FAILED', exitCode: null },
          { state: 'NOT_RUN', exitCode: null },
        ],
      });
      expect(resultV2Schema.safeParse(result).success).toBe(true);
      expect(result?.steps[0]?.outputTail).toEqual([
        {
          stream: 'stderr',
          line: 'RUNE-500 runner returned an invalid outcome for step "first"',
        },
      ]);
      if (forbidden !== undefined) {
        expect(JSON.stringify({ thrown, events, result })).not.toContain(forbidden);
        expect((thrown as Error).message).not.toContain(forbidden);
      }

      const settledEventCount = events.length;
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(events).toHaveLength(settledEventCount);
    },
  );

  it.each(['invalid stream', 'non-string line', 'embedded LF'])(
    'contains an injected runner %s as a value-free internal contract failure',
    async (invalidPayload) => {
      const { plan } = setup(TWO_STEPS, { failFast: false });
      const events: RunEvent[] = [];
      const privateObject = {
        marker: 'private-object-payload',
        toString: vi.fn(() => 'private-stringified-payload'),
      };
      const emitUnsafe = (request: SpawnRequest, stream: unknown, line: unknown): void => {
        (request.onOutput as unknown as (unsafeStream: unknown, unsafeLine: unknown) => void)(
          stream,
          line,
        );
      };
      const runner = stubRunner((request) => {
        if (invalidPayload === 'invalid stream') {
          emitUnsafe(request, 'private-stream-payload', 'private-line-payload');
        } else if (invalidPayload === 'non-string line') {
          emitUnsafe(request, 'stdout', privateObject);
        } else {
          emitUnsafe(request, 'stdout', 'private-line-payload\nprivate-injected-record');
        }
        emitUnsafe(request, 'private-second-stream', privateObject);
        request.onOutput('stderr', 'private-output-after-contract-failure');
        return { kind: 'exited', exitCode: 0 };
      });

      let thrown: unknown;
      try {
        await executeRun({
          plan,
          observer: (event) => events.push(event),
          runner,
        });
      } catch (error) {
        thrown = error;
      }

      expect(thrown).toBeInstanceOf(InternalError);
      expect(thrown).toMatchObject({ code: 'RUNE-500' });
      expect((thrown as Error).message).toContain(
        'runner emitted an invalid output payload for step "first"',
      );
      expect(privateObject.toString).not.toHaveBeenCalled();
      expect(events.map((event) => event.kind)).toEqual([
        'runStarted',
        'stepStarted',
        'stepOutput',
        'stepFinished',
        'stepFinished',
        'runFinished',
      ]);
      expect(events.filter((event) => event.kind === 'stepOutput')).toEqual([
        expect.objectContaining({
          stepId: 'first',
          stream: 'stderr',
          line: 'RUNE-500 runner emitted an invalid output payload for step "first"',
        }),
      ]);

      const terminal = events.at(-1);
      expect(terminal?.kind).toBe('runFinished');
      const result = terminal?.kind === 'runFinished' ? terminal.result : undefined;
      expect(result).toMatchObject({
        status: 'internal_error',
        exitCode: 70,
        error: {
          code: 'RUNE-500',
          message: expect.stringContaining(
            'runner emitted an invalid output payload for step "first"',
          ),
        },
        stepsFailed: 1,
        stepsNotRun: 1,
        steps: [
          {
            state: 'FAILED',
            outputTail: [
              {
                stream: 'stderr',
                line: 'RUNE-500 runner emitted an invalid output payload for step "first"',
              },
            ],
          },
          { state: 'NOT_RUN' },
        ],
      });
      expect(resultV2Schema.safeParse(result).success).toBe(true);

      const serializedSinks = JSON.stringify({ events, result });
      for (const forbidden of [
        'private-stream-payload',
        'private-line-payload',
        'private-injected-record',
        'private-object-payload',
        'private-stringified-payload',
        'private-second-stream',
        'private-output-after-contract-failure',
      ]) {
        expect(serializedSinks).not.toContain(forbidden);
        expect((thrown as Error).message).not.toContain(forbidden);
      }

      const settledEventCount = events.length;
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(events).toHaveLength(settledEventCount);
    },
  );

  it('contains a rejecting runner and completes the event bracket', async () => {
    const { plan } = setup(['steps:', '  - id: rejected', '    run:', '      command: a']);
    const events: RunEvent[] = [];

    const result = await executeRun({
      plan,
      observer: (event) => events.push(event),
      runner: stubRunner(() => {
        throw new Error('exception text must stay private');
      }),
    });

    expect(result.status).toBe('failed');
    expect(result.steps[0]?.outputTail).toEqual([
      {
        stream: 'stderr',
        line: 'RUNE-401 step "rejected" runner failed while starting the process',
      },
    ]);
    expect(events.map((event) => event.kind)).toEqual([
      'runStarted',
      'stepStarted',
      'stepOutput',
      'stepFinished',
      'runFinished',
    ]);
    expect(JSON.stringify({ events, result })).not.toContain('exception text');
  });

  it('contains a secret NUL startup failure without exposing raw or escaped fragments', async () => {
    const secret = 'needle-before\0needle-after';
    const { plan } = setup(
      [
        'inputs:',
        '  token:',
        '    type: secret',
        'steps:',
        '  - id: invalid-argument',
        '    run:',
        `      command: ${JSON.stringify(process.execPath)}`,
        '      args: ["${token}"]',
      ],
      { overrides: new Map([['token', secret]]) },
    );
    const events: RunEvent[] = [];

    const result = await executeRun({
      plan,
      observer: (event) => events.push(event),
    });
    const serialized = JSON.stringify({ events, result });

    expect(result.status).toBe('failed');
    expect(events.map((event) => event.kind)).toEqual([
      'runStarted',
      'stepStarted',
      'stepOutput',
      'stepFinished',
      'runFinished',
    ]);
    expect(result.steps[0]?.outputTail).toEqual([
      {
        stream: 'stderr',
        line: 'RUNE-401 step "invalid-argument" runner failed while starting the process',
      },
    ]);
    expect(serialized).not.toContain('needle-before');
    expect(serialized).not.toContain('needle-after');
    expect(serialized).not.toContain('\\u0000');
  });

  it('drops output queued after a runner resolves', async () => {
    const { plan } = setup(['steps:', '  - id: late-output', '    run:', '      command: a']);
    const events: RunEvent[] = [];
    const runner: Runner = {
      run: (request) =>
        new Promise((resolve) => {
          resolve({ kind: 'exited', exitCode: 0 });
          queueMicrotask(() => request.onOutput('stdout', 'late microtask'));
          setTimeout(() => request.onOutput('stderr', 'late timer'), 0);
        }),
    };

    const result = await executeRun({
      plan,
      observer: (event) => events.push(event),
      runner,
    });
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(result.status).toBe('succeeded');
    expect(result.steps[0]).not.toHaveProperty('outputTail');
    expect(events.map((event) => event.kind)).toEqual([
      'runStarted',
      'stepStarted',
      'stepFinished',
      'runFinished',
    ]);
  });

  it('drops output queued after a runner rejects', async () => {
    const { plan } = setup(['steps:', '  - id: late-output', '    run:', '      command: a']);
    const events: RunEvent[] = [];
    const runner: Runner = {
      run: (request) =>
        new Promise((_resolve, reject) => {
          reject(new Error('private rejection'));
          queueMicrotask(() => request.onOutput('stdout', 'late microtask'));
          setTimeout(() => request.onOutput('stderr', 'late timer'), 0);
        }),
    };

    const result = await executeRun({
      plan,
      observer: (event) => events.push(event),
      runner,
    });
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(result.status).toBe('failed');
    expect(result.steps[0]?.outputTail).toEqual([
      {
        stream: 'stderr',
        line: 'RUNE-401 step "late-output" runner failed while starting the process',
      },
    ]);
    expect(events.map((event) => event.kind)).toEqual([
      'runStarted',
      'stepStarted',
      'stepOutput',
      'stepFinished',
      'runFinished',
    ]);
    expect(JSON.stringify({ events, result })).not.toContain('private rejection');
  });
});

describe('cancellation and timeout', () => {
  it('reports a pre-cancelled empty plan as cancelled', async () => {
    const { plan } = setup(['steps: []']);
    const cancel = new CancelToken();
    const events: RunEvent[] = [];
    let calls = 0;
    cancel.cancel();

    const result = await executeRun({
      plan,
      cancel,
      observer: (event) => events.push(event),
      runner: stubRunner(() => {
        calls += 1;
        return { kind: 'exited', exitCode: 0 };
      }),
    });

    expect(calls).toBe(0);
    expect(result).toMatchObject({
      status: 'cancelled',
      exitCode: 6,
      error: { code: 'RUNE-601', message: 'the run was cancelled', location: null },
      stepsTotal: 0,
      stepsExecuted: 0,
      stepsSkipped: 0,
      stepsNotRun: 0,
      nothingExecuted: true,
    });
    expect(resultV2Schema.safeParse(result).success).toBe(true);
    expect(events.map((event) => event.kind)).toEqual(['runStarted', 'runFinished']);
  });

  it('reports a pre-cancelled all-skipped plan as cancelled without running anything', async () => {
    const { plan } = setup([
      'inputs:',
      '  enabled:',
      '    type: boolean',
      '    default: false',
      'steps:',
      '  - id: first',
      '    when: "${enabled}"',
      '    run:',
      '      command: a',
      '  - id: second',
      '    when: "${enabled}"',
      '    run:',
      '      command: b',
    ]);
    const cancel = new CancelToken();
    const events: RunEvent[] = [];
    let calls = 0;
    cancel.cancel();

    const result = await executeRun({
      plan,
      cancel,
      observer: (event) => events.push(event),
      runner: stubRunner(() => {
        calls += 1;
        return { kind: 'exited', exitCode: 0 };
      }),
    });

    expect(calls).toBe(0);
    expect(result).toMatchObject({
      status: 'cancelled',
      exitCode: 6,
      stepsExecuted: 0,
      stepsSkipped: 2,
      stepsNotRun: 0,
      nothingExecuted: true,
    });
    expect(result.steps.map((step) => step.state)).toEqual(['SKIPPED', 'SKIPPED']);
    expect(events.map((event) => event.kind)).toEqual([
      'runStarted',
      'stepFinished',
      'stepFinished',
      'runFinished',
    ]);
  });

  it('captures cancellation from RunStarted for an all-skipped plan', async () => {
    const { plan } = setup([
      'inputs:',
      '  enabled:',
      '    type: boolean',
      '    default: false',
      'steps:',
      '  - id: skipped',
      '    when: "${enabled}"',
      '    run:',
      '      command: a',
    ]);
    const cancel = new CancelToken();
    const events: RunEvent[] = [];
    let calls = 0;

    const result = await executeRun({
      plan,
      cancel,
      observer: (event) => {
        events.push(event);
        if (event.kind === 'runStarted') {
          cancel.cancel();
        }
      },
      runner: stubRunner(() => {
        calls += 1;
        return { kind: 'exited', exitCode: 0 };
      }),
    });

    expect(calls).toBe(0);
    expect(result).toMatchObject({
      status: 'cancelled',
      exitCode: 6,
      stepsExecuted: 0,
      stepsSkipped: 1,
      stepsNotRun: 0,
      nothingExecuted: true,
    });
    expect(events.map((event) => event.kind)).toEqual([
      'runStarted',
      'stepFinished',
      'runFinished',
    ]);
  });

  it('marks the interrupted step CANCELLED, the rest NOT_RUN, and the run cancelled', async () => {
    const { plan } = setup(TWO_STEPS);
    const cancel = new CancelToken();

    const result = await executeRun({
      plan,
      cancel,
      runner: stubRunner(() => {
        cancel.cancel();
        return { kind: 'cancelled' };
      }),
    });

    expect(result).toMatchObject({ status: 'cancelled', exitCode: 6, stepsCancelled: 1 });
    expect(result.steps.map((step) => step.state)).toEqual(['CANCELLED', 'NOT_RUN']);
  });

  it('stops after a runner reports cancellation without changing the shared token', async () => {
    const { plan } = setup(TWO_STEPS);
    let calls = 0;
    const events: RunEvent[] = [];

    const result = await executeRun({
      plan,
      observer: (event) => events.push(event),
      runner: stubRunner(() => {
        calls += 1;
        return { kind: 'cancelled' };
      }),
    });

    expect(calls).toBe(1);
    expect(result).toMatchObject({
      status: 'cancelled',
      exitCode: 6,
      stepsExecuted: 1,
      stepsCancelled: 1,
      stepsNotRun: 1,
    });
    expect(result.steps.map((step) => step.state)).toEqual(['CANCELLED', 'NOT_RUN']);
    expect(events.map((event) => event.kind)).toEqual([
      'runStarted',
      'stepStarted',
      'stepFinished',
      'stepFinished',
      'runFinished',
    ]);
  });

  it('fails safely and abandons pending work when tree termination is unconfirmed', async () => {
    const { plan } = setup(['inputs:', '  token:', '    type: secret', ...TWO_STEPS], {
      failFast: false,
      overrides: new Map([['token', 'termination-secret']]),
    });
    const cancel = new CancelToken();
    const events: RunEvent[] = [];
    let calls = 0;

    const result = await executeRun({
      plan,
      cancel,
      observer: (event) => events.push(event),
      runner: stubRunner((request) => {
        calls += 1;
        request.onOutput('stderr', 'before termination-secret after');
        cancel.cancel();
        return { kind: 'terminationFailed' };
      }),
    });

    expect(calls).toBe(1);
    expect(result).toMatchObject({
      status: 'failed',
      exitCode: 1,
      stepsTotal: 2,
      stepsExecuted: 1,
      stepsSucceeded: 0,
      stepsFailed: 1,
      stepsCancelled: 0,
      stepsSkipped: 0,
      stepsNotRun: 1,
      nothingExecuted: false,
    });
    expect(result.steps.map((step) => step.state)).toEqual(['FAILED', 'NOT_RUN']);
    expect(result.steps[0]?.exitCode).toBeNull();
    expect(result.steps[0]?.outputTail).toEqual([
      { stream: 'stderr', line: 'before *** after' },
      {
        stream: 'stderr',
        line: 'RUNE-401 step "first" process-tree termination could not be confirmed',
      },
    ]);
    expect(events.map((event) => event.kind)).toEqual([
      'runStarted',
      'stepStarted',
      'stepOutput',
      'stepOutput',
      'stepFinished',
      'stepFinished',
      'runFinished',
    ]);
    const runFinished = events.at(-1);
    expect(runFinished?.kind).toBe('runFinished');
    if (runFinished?.kind === 'runFinished') {
      expect(runFinished.result).toBe(result);
      expect(Object.isFrozen(runFinished.result)).toBe(true);
      expect(Object.isFrozen(runFinished.result.steps)).toBe(true);
      expect(Object.isFrozen(runFinished.result.steps[0]?.outputTail)).toBe(true);
    }
  });

  it('consumes cancellation at RunStarted before the first pending step', async () => {
    const { plan } = setup(TWO_STEPS);
    const cancel = new CancelToken();
    let calls = 0;
    const events: RunEvent[] = [];

    const result = await executeRun({
      plan,
      cancel,
      observer: (event) => {
        events.push(event);
        if (event.kind === 'runStarted') {
          cancel.cancel();
        }
      },
      runner: stubRunner(() => {
        calls += 1;
        return { kind: 'exited', exitCode: 0 };
      }),
    });

    expect(calls).toBe(0);
    expect(result).toMatchObject({
      status: 'cancelled',
      exitCode: 6,
      stepsExecuted: 0,
      stepsNotRun: 2,
      nothingExecuted: true,
    });
    expect(result.steps.map((step) => step.state)).toEqual(['NOT_RUN', 'NOT_RUN']);
    expect(events.map((event) => event.kind)).toEqual([
      'runStarted',
      'stepFinished',
      'stepFinished',
      'runFinished',
    ]);
    expect(
      events
        .filter((event): event is StepFinished => event.kind === 'stepFinished')
        .map(({ state, exitCode }) => ({ state, exitCode })),
    ).toEqual([
      { state: 'NOT_RUN', exitCode: undefined },
      { state: 'NOT_RUN', exitCode: undefined },
    ]);
  });

  it('passes cancellation from StepStarted to the running step', async () => {
    const { plan } = setup(TWO_STEPS);
    const cancel = new CancelToken();
    let calls = 0;
    const events: RunEvent[] = [];

    const result = await executeRun({
      plan,
      cancel,
      observer: (event) => {
        events.push(event);
        if (event.kind === 'stepStarted') {
          cancel.cancel();
        }
      },
      runner: stubRunner((request) => {
        calls += 1;
        expect(request.cancel.isCancelled).toBe(true);
        return { kind: 'cancelled' };
      }),
    });

    expect(calls).toBe(1);
    expect(result).toMatchObject({ status: 'cancelled', exitCode: 6, stepsCancelled: 1 });
    expect(result.steps.map((step) => step.state)).toEqual(['CANCELLED', 'NOT_RUN']);
    expect(
      events
        .filter((event): event is StepFinished => event.kind === 'stepFinished')
        .map(({ state, exitCode }) => ({ state, exitCode })),
    ).toEqual([
      { state: 'CANCELLED', exitCode: undefined },
      { state: 'NOT_RUN', exitCode: undefined },
    ]);
  });

  it('consumes cancellation at a middle StepFinished before later pending work', async () => {
    const { plan } = setup([
      'steps:',
      '  - id: first',
      '    run:',
      '      command: a',
      '  - id: middle',
      '    run:',
      '      command: b',
      '  - id: last',
      '    run:',
      '      command: c',
    ]);
    const cancel = new CancelToken();
    let calls = 0;

    const result = await executeRun({
      plan,
      cancel,
      observer: (event) => {
        if (event.kind === 'stepFinished' && event.stepId === 'middle') {
          cancel.cancel();
        }
      },
      runner: stubRunner(() => {
        calls += 1;
        return { kind: 'exited', exitCode: 0 };
      }),
    });

    expect(calls).toBe(2);
    expect(result).toMatchObject({
      status: 'cancelled',
      exitCode: 6,
      stepsSucceeded: 2,
      stepsNotRun: 1,
    });
    expect(result.steps.map((step) => step.state)).toEqual(['SUCCEEDED', 'SUCCEEDED', 'NOT_RUN']);
  });

  it('does not turn a completed run into cancellation at the last StepFinished', async () => {
    const { plan } = setup(TWO_STEPS);
    const cancel = new CancelToken();

    const result = await executeRun({
      plan,
      cancel,
      observer: (event) => {
        if (event.kind === 'stepFinished' && event.stepId === 'second') {
          cancel.cancel();
        }
      },
      runner: stubRunner(() => ({ kind: 'exited', exitCode: 0 })),
    });

    expect(cancel.isCancelled).toBe(true);
    expect(result).toMatchObject({
      status: 'succeeded',
      exitCode: 0,
      stepsSucceeded: 2,
      stepsNotRun: 0,
    });
    expect(result.steps.map((step) => step.state)).toEqual(['SUCCEEDED', 'SUCCEEDED']);
  });

  it('keeps fail-fast failure ahead of a later cancellation request', async () => {
    const { plan } = setup(TWO_STEPS);
    const cancel = new CancelToken();

    const result = await executeRun({
      plan,
      cancel,
      observer: (event) => {
        if (event.kind === 'stepFinished' && event.stepId === 'first') {
          cancel.cancel();
        }
      },
      runner: stubRunner(() => ({ kind: 'exited', exitCode: 1 })),
    });

    expect(cancel.isCancelled).toBe(true);
    expect(result).toMatchObject({
      status: 'failed',
      exitCode: 1,
      stepsFailed: 1,
      stepsNotRun: 1,
    });
    expect(result.steps.map((step) => step.state)).toEqual(['FAILED', 'NOT_RUN']);
  });

  it('keeps a failure ahead of between-step cancellation when fail-fast is disabled', async () => {
    const { plan } = setup(TWO_STEPS, { failFast: false });
    const cancel = new CancelToken();

    const result = await executeRun({
      plan,
      cancel,
      observer: (event) => {
        if (event.kind === 'stepFinished' && event.stepId === 'first') {
          cancel.cancel();
        }
      },
      runner: stubRunner(() => ({ kind: 'exited', exitCode: 1 })),
    });

    expect(result).toMatchObject({
      status: 'failed',
      exitCode: 1,
      stepsFailed: 1,
      stepsNotRun: 1,
      error: null,
    });
    expect(result.steps.map((step) => step.state)).toEqual(['FAILED', 'NOT_RUN']);
  });

  it('keeps a failure when a later running step is cancelled', async () => {
    const { plan } = setup(
      [
        'steps:',
        '  - id: failed',
        '    run:',
        '      command: a',
        '  - id: cancelled',
        '    run:',
        '      command: b',
        '  - id: pending',
        '    run:',
        '      command: c',
      ],
      { failFast: false },
    );
    const cancel = new CancelToken();
    let calls = 0;

    const result = await executeRun({
      plan,
      cancel,
      runner: stubRunner(() => {
        calls += 1;
        if (calls === 1) {
          return { kind: 'exited', exitCode: 1 };
        }
        cancel.cancel();
        return { kind: 'cancelled' };
      }),
    });

    expect(calls).toBe(2);
    expect(result).toMatchObject({
      status: 'failed',
      exitCode: 1,
      error: null,
      stepsTotal: 3,
      stepsExecuted: 2,
      stepsSucceeded: 0,
      stepsFailed: 1,
      stepsCancelled: 1,
      stepsSkipped: 0,
      stepsNotRun: 1,
      nothingExecuted: false,
    });
    expect(result.steps.map((step) => step.state)).toEqual(['FAILED', 'CANCELLED', 'NOT_RUN']);
  });

  it('leaves skipped steps skipped while cancellation prevents pending work', async () => {
    const { plan } = setup([
      'inputs:',
      '  enabled:',
      '    type: boolean',
      '    default: false',
      'steps:',
      '  - id: skipped',
      '    when: "${enabled}"',
      '    run:',
      '      command: a',
      '  - id: pending',
      '    run:',
      '      command: b',
    ]);
    const cancel = new CancelToken();

    const result = await executeRun({
      plan,
      cancel,
      observer: (event) => {
        if (event.kind === 'runStarted') {
          cancel.cancel();
        }
      },
      runner: stubRunner(() => ({ kind: 'exited', exitCode: 0 })),
    });

    expect(result).toMatchObject({
      status: 'cancelled',
      exitCode: 6,
      stepsSkipped: 1,
      stepsNotRun: 1,
      nothingExecuted: true,
    });
    expect(result.steps.map((step) => step.state)).toEqual(['SKIPPED', 'NOT_RUN']);
  });

  it('treats a timeout as a step failure, with the timeout named in the output', async () => {
    const { plan } = setup([
      'steps:',
      '  - id: slow',
      '    run:',
      '      command: a',
      '      timeoutSeconds: 1',
    ]);
    const lines: string[] = [];

    const result = await executeRun({
      plan,
      observer: (event) => {
        if (event.kind === 'stepOutput') {
          lines.push(event.line);
        }
      },
      runner: stubRunner(() => ({ kind: 'timedOut' })),
    });

    expect(result.status).toBe('failed');
    expect(lines.at(-1)).toBe('RUNE-402 step "slow" exceeded its timeout of 1 seconds');
  });

  it.each([
    {
      outcome: { kind: 'timedOut' as const },
      expected: 'RUNE-402 step "outcome" exceeded its timeout of 1 seconds',
    },
    {
      outcome: { kind: 'failedToStart' as const, reason: 'commandNotFound' as const },
      expected: 'RUNE-403 step "outcome" command was not found',
    },
    {
      outcome: { kind: 'exited' as const, exitCode: 7 },
      expected: 'RUNE-401 step "outcome" exited with code 7; expected one of [0]',
    },
    {
      outcome: { kind: 'streamFailed' as const, stream: 'stdout' as const },
      expected: 'RUNE-401 step "outcome" stdout stream could not be read',
    },
  ])(
    'keeps the synthetic $outcome.kind line as the newest tail entry',
    async ({ outcome, expected }) => {
      const { plan } = setup([
        'steps:',
        '  - id: outcome',
        '    run:',
        '      command: a',
        '      timeoutSeconds: 1',
      ]);

      const result = await executeRun({
        plan,
        runner: stubRunner((request) => {
          for (let index = 0; index < OUTPUT_TAIL_LINES; index += 1) {
            request.onOutput('stdout', `normal-${index}`);
          }
          return outcome;
        }),
      });

      const tail = result.steps[0]?.outputTail;
      expect(tail).toHaveLength(OUTPUT_TAIL_LINES);
      expect(tail?.map(({ stream, line }) => ({ stream, line }))).toEqual([
        ...Array.from({ length: OUTPUT_TAIL_LINES - 1 }, (_, index) => ({
          stream: 'stdout' as const,
          line: `normal-${index + 1}`,
        })),
        { stream: 'stderr', line: expected },
      ]);
    },
  );
});

describe('skipped steps and the dry run', () => {
  const CONDITIONAL = [
    'inputs:',
    '  enabled:',
    '    type: boolean',
    '    default: false',
    'steps:',
    '  - id: off',
    '    when: "${enabled}"',
    '    run:',
    '      command: a',
  ];

  it('emits one StepFinished for a skipped step and nothing else', async () => {
    const { plan } = setup(CONDITIONAL);
    const events: RunEvent[] = [];

    const result = await executeRun({
      plan,
      observer: (event) => events.push(event),
      runner: stubRunner(() => ({ kind: 'exited', exitCode: 0 })),
    });

    expect(events.map((event) => event.kind)).toEqual([
      'runStarted',
      'stepFinished',
      'runFinished',
    ]);
    expect(
      events
        .filter((event): event is StepFinished => event.kind === 'stepFinished')
        .map(({ state, exitCode }) => ({ state, exitCode })),
    ).toEqual([{ state: 'SKIPPED', exitCode: undefined }]);
    expect(result).toMatchObject({ status: 'succeeded', nothingExecuted: true, stepsSkipped: 1 });
  });

  it('describes a plan without executing anything', () => {
    const { plan } = setup(TWO_STEPS);

    const result = describePlan({ plan });

    expect(result).toMatchObject({ status: 'planned', exitCode: 0, dryRun: true, error: null });
    expect(resultV2Schema.safeParse(result).success).toBe(true);
    expect(result.startedAt).toBe(result.finishedAt);
    expect(result.durationMs).toBe(0);
    expect(result.steps.every((step) => step.durationMs === 0)).toBe(true);
    expect(result.steps.map((step) => step.state)).toEqual(['PENDING', 'PENDING']);
    expect(result.steps[0]?.command).toEqual(['a']);
  });

  it.each<RunMode>(['gui', 'interactive', 'non-interactive'])(
    'records the explicit %s mode and the plan locale in dry-run and execution results',
    async (mode) => {
      const { plan } = setup(['steps: []'], { locale: 'de-DE' });

      const described = describePlanWithMode({ plan, mode });
      const executed = await executeRunWithMode({ plan, mode });

      expect(described).toMatchObject({ mode, locale: 'de-DE' });
      expect(executed).toMatchObject({ mode, locale: 'de-DE' });
    },
  );

  it('records the built-in defaults as null in dry-run and execution results', async () => {
    const { plan } = setup(['steps: []'], { locale: undefined });

    const described = describePlan({ plan });
    const executed = await executeRun({ plan });

    expect(plan.locale).toBeNull();
    expect(described.locale).toBeNull();
    expect(executed.locale).toBeNull();
    expect(resultV2Schema.safeParse(described).success).toBe(true);
    expect(resultV2Schema.safeParse(executed).success).toBe(true);
  });

  it('returns a deeply frozen dry-run result', () => {
    const { plan } = setup([
      'inputs:',
      '  setting:',
      '    type: text',
      '    default: value',
      'steps:',
      '  - id: a',
      '    run:',
      '      command: a',
    ]);

    const result = describePlan({ plan });

    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.product)).toBe(true);
    expect(Object.isFrozen(result.manifest)).toBe(true);
    expect(Object.isFrozen(result.inputs)).toBe(true);
    expect(Object.isFrozen(result.inputs[0])).toBe(true);
    expect(Object.isFrozen(result.steps)).toBe(true);
    expect(Object.isFrozen(result.steps[0])).toBe(true);
    expect(Object.isFrozen(result.steps[0]?.command)).toBe(true);
  });

  it('refuses to execute a cross-platform preview plan', async () => {
    const manifest = parseManifestText(
      [...HEAD, 'steps:', '  - id: a', '    run:', '      command: a', ''].join('\n'),
      'installer.yaml',
      { manifestDir: TEST_MANIFEST_DIR },
    );
    const foreign = hostPlatform() === 'windows' ? 'linux' : 'windows';
    const context = createRuntimeContext({
      manifestDir: TEST_MANIFEST_DIR,
      product: manifest.product,
      platform: foreign,
      environment: {},
    });
    const resolution = resolveInputs({ manifest, context });
    const plan = buildPlan({ manifest, resolution, context });

    await expect(executeRun({ plan })).rejects.toThrow(/preview plan/);
  });

  it('masks a secret in the argv a result shows', async () => {
    const { plan } = setup(
      [
        'inputs:',
        '  token:',
        '    type: secret',
        'steps:',
        '  - id: use',
        '    run:',
        '      command: a',
        '      args: ["--token", "${token}"]',
      ],
      { overrides: new Map([['token', 'super-secret-value']]) },
    );

    const result = describePlan({ plan });

    expect(result.steps[0]?.command).toEqual(['a', '--token', '***']);
    expect(JSON.stringify(result)).not.toContain('super-secret-value');
  });

  it('keeps byte-colliding public inputs masked while a custom runner receives wrappers', async () => {
    const secret = 'credential-value';
    const substring = `prefix-${secret}-suffix`;
    const { plan } = setup(
      [
        'inputs:',
        '  token:',
        '    type: secret',
        '  mirror:',
        '    type: text',
        'steps:',
        '  - id: use',
        `    title: "Use ${substring}"`,
        '    run:',
        '      command: "${mirror}"',
        '      args: ["${mirror}"]',
        '      env:',
        '        MIRROR: "${mirror}"',
      ],
      {
        overrides: new Map([
          ['token', secret],
          ['mirror', substring],
        ]),
      },
    );
    const events: RunEvent[] = [];

    const result = await executeRun({
      plan,
      observer: (event) => events.push(event),
      runner: stubRunner((request) => {
        for (const value of [
          request.command.argv[0],
          request.command.argv[1],
          request.command.env['MIRROR'],
        ]) {
          expect(isSecretString(value)).toBe(true);
          expect(secretValuesEqual(value, substring)).toBe(true);
        }
        return { kind: 'exited', exitCode: 0 };
      }),
    });

    const started = events.find((event) => event.kind === 'runStarted');
    expect(started?.kind).toBe('runStarted');
    if (started?.kind !== 'runStarted') {
      throw new Error('runStarted event was not emitted');
    }
    expect(started.plan).toBe(plan);
    expect(started.plan.resolvedInputs).toMatchObject([
      { id: 'token', secret: true },
      { id: 'mirror', value: 'prefix-***-suffix', secret: false },
    ]);
    expect(started.plan.steps[0]?.title).toBe('Use prefix-***-suffix');
    expect(JSON.stringify(started.plan)).not.toContain(secret);
    expect(inspect(started.plan)).not.toContain(secret);
    expect(result.inputs).toMatchObject([
      { id: 'token', value: null, secret: true },
      { id: 'mirror', value: 'prefix-***-suffix', secret: false },
    ]);
    expect(result.steps[0]).toMatchObject({
      title: 'Use prefix-***-suffix',
      command: ['***', '***'],
    });
    expect(JSON.stringify(result)).not.toContain(secret);
  });

  it('masks normalized public path collisions at every execution surface', async () => {
    const executable = process.platform === 'win32' ? 'secret-tool.exe' : 'secret-tool';
    const collision = `.\\private/../${executable}`;
    const derived = resolvePath(TEST_MANIFEST_DIR, executable);
    const { plan } = setup(
      [
        'inputs:',
        '  token:',
        '    type: secret',
        '  mirror:',
        '    type: text',
        'steps:',
        '  - id: use',
        '    run:',
        '      command: "${mirror}"',
        '      cwd: "${mirror}"',
      ],
      {
        overrides: new Map([
          ['token', collision],
          ['mirror', collision],
        ]),
      },
    );
    const step = plan.steps[0];
    if (step?.state !== 'PENDING') {
      throw new Error('expected a pending step');
    }

    expect(isSecretString(step.command.argv[0])).toBe(true);
    expect(secretValuesEqual(step.command.argv[0], derived)).toBe(true);
    expect(isSecretString(step.command.cwd)).toBe(true);
    expect(secretValuesEqual(step.command.cwd, derived)).toBe(true);
    expect(describePlan({ plan }).steps[0]?.command).toEqual([MASK]);

    const events: RunEvent[] = [];
    const result = await executeRun({
      plan,
      observer: (event) => events.push(event),
      runner: stubRunner(async (request) => {
        expect(isSecretString(request.command.argv[0])).toBe(true);
        expect(secretValuesEqual(request.command.argv[0], derived)).toBe(true);
        expect(isSecretString(request.command.cwd)).toBe(true);
        expect(secretValuesEqual(request.command.cwd, derived)).toBe(true);
        request.onOutput('stdout', derived);
        await Promise.resolve();
        return { kind: 'exited', exitCode: 9 };
      }),
    });

    expect(
      events.find((event) => event.kind === 'stepOutput' && event.stream === 'stdout'),
    ).toEqual({
      kind: 'stepOutput',
      stepId: 'use',
      stream: 'stdout',
      line: MASK,
    });
    expect(result.steps[0]?.outputTail?.[0]).toEqual({ stream: 'stdout', line: MASK });
    expect(JSON.stringify({ plan, events, result })).not.toContain(collision);
  });

  it('reveals colliding command, argv, cwd and env bytes only to a real spawned process', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'rune-plan-collision-'));
    const payload = 'credential-value';
    const script =
      'process.exit(process.argv[1] === process.env.EXPECTED_PAYLOAD && process.cwd() === process.env.EXPECTED_CWD ? 0 : 9)';
    try {
      const { plan } = setup(
        [
          'inputs:',
          '  secretCommand:',
          '    type: secret',
          '  mirrorCommand:',
          '    type: text',
          '  secretCwd:',
          '    type: secret',
          '  mirrorCwd:',
          '    type: directory',
          '  secretPayload:',
          '    type: secret',
          '  mirrorPayload:',
          '    type: text',
          'steps:',
          '  - id: use',
          '    run:',
          '      command: "${mirrorCommand}"',
          `      args: ["-e", ${JSON.stringify(script)}, "\${mirrorPayload}"]`,
          '      cwd: "${mirrorCwd}"',
          '      env:',
          '        EXPECTED_PAYLOAD: "${mirrorPayload}"',
          '        EXPECTED_CWD: "${mirrorCwd}"',
        ],
        {
          overrides: new Map([
            ['secretCommand', process.execPath],
            ['mirrorCommand', process.execPath],
            ['secretCwd', directory],
            ['mirrorCwd', directory],
            ['secretPayload', payload],
            ['mirrorPayload', payload],
          ]),
        },
      );
      const step = plan.steps[0];
      if (step?.state !== 'PENDING') {
        throw new Error('expected a pending step');
      }
      expect(isSecretString(step.command.argv[0])).toBe(true);
      expect(isSecretString(step.command.argv[3])).toBe(true);
      expect(isSecretString(step.command.cwd)).toBe(true);
      expect(isSecretString(step.command.env['EXPECTED_PAYLOAD'])).toBe(true);
      expect(isSecretString(step.command.env['EXPECTED_CWD'])).toBe(true);

      const result = await executeRun({ plan });

      expect(result.status).toBe('succeeded');
      expect(result.steps[0]?.exitCode).toBe(0);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('keeps product and run-status identities byte-exact when they collide with secrets', async () => {
    const { plan } = setup(
      [
        'inputs:',
        '  productIdentity:',
        '    type: secret',
        '  statusIdentity:',
        '    type: secret',
        'steps: []',
      ],
      {
        overrides: new Map([
          ['productIdentity', 'Example'],
          ['statusIdentity', 'succeeded'],
        ]),
      },
    );

    const result = await executeRun({ plan });

    expect(result.product).toMatchObject({ name: 'Example' });
    expect(result.status).toBe('succeeded');
  });

  it('keeps sink masking fixed after its retained registry later changes', async () => {
    const original = 'resolved-secret';
    const later = 'later-secret';
    const manifest = parseManifestText(
      [
        ...HEAD,
        'inputs:',
        '  token:',
        '    type: secret',
        '  note:',
        '    type: text',
        `    default: ${later}`,
        'steps:',
        '  - id: use',
        `    title: "${original} ${later}"`,
        '    run:',
        `      command: ${original}`,
        `      args: [${later}]`,
        '',
      ].join('\n'),
      'installer.yaml',
      { manifestDir: TEST_MANIFEST_DIR },
    );
    const context = createRuntimeContext({
      manifestDir: TEST_MANIFEST_DIR,
      product: manifest.product,
      platform: hostPlatform(),
      environment: {},
    });
    const secrets = new SecretRegistry();
    const resolution = resolveInputsWithRegistry(
      {
        manifest,
        context,
        overrides: new Map([['token', original]]),
      },
      secrets,
    );
    const plan = buildPlan({ manifest, resolution, context });

    secrets.register(later);

    const described = describePlan({ plan });
    expect(described.inputs.find((input) => input.id === 'note')?.value).toBe(later);
    expect(described.steps[0]).toMatchObject({
      title: `*** ${later}`,
      command: ['***', later],
    });

    const events: RunEvent[] = [];
    const result = await executeRun({
      plan,
      observer: (event) => events.push(event),
      runner: stubRunner((request) => {
        request.onOutput('stderr', `${original} ${later}`);
        return { kind: 'exited', exitCode: 1 };
      }),
    });

    const started = events.find((event) => event.kind === 'runStarted');
    expect(started?.kind).toBe('runStarted');
    if (started?.kind !== 'runStarted') {
      throw new Error('runStarted event was not emitted');
    }
    expect(started.plan).toBe(plan);
    expect(started.plan.resolvedInputs.find((input) => input.id === 'note')?.value).toBe(later);
    expect(started.plan.steps[0]).toMatchObject({ title: `*** ${later}` });
    const startedStep = started.plan.steps[0];
    expect(startedStep?.state).toBe('PENDING');
    expect(startedStep?.state === 'PENDING' && isSecretString(startedStep.command.argv[0])).toBe(
      true,
    );
    expect(
      startedStep?.state === 'PENDING' && secretValuesEqual(startedStep.command.argv[0], original),
    ).toBe(true);
    expect(startedStep?.state === 'PENDING' && startedStep.command.argv[1]).toBe(later);
    expect(events.find((event) => event.kind === 'stepOutput')).toMatchObject({
      line: `*** ${later}`,
    });
    expect(result.inputs.find((input) => input.id === 'note')?.value).toBe(later);
    expect(result.steps[0]).toMatchObject({
      title: `*** ${later}`,
      command: ['***', later],
      outputTail: [
        { stream: 'stderr', line: `*** ${later}` },
        {
          stream: 'stderr',
          line: 'RUNE-401 step "use" exited with code 1; expected one of [0]',
        },
      ],
    });
  });

  it('serializes the manifest identity bound before the source file changes', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'rune-result-identity-'));
    try {
      const manifestPath = join(directory, 'installer.yaml');
      writeFileSync(manifestPath, [...HEAD, 'steps: []', ''].join('\n'));
      const manifest = parseManifest(manifestPath);
      const context = createRuntimeContext({
        manifestDir: directory,
        product: manifest.product,
        platform: hostPlatform(),
        environment: {},
      });
      const resolution = resolveInputs({ manifest, context });
      const plan = buildPlan({ manifest, resolution, context });

      writeFileSync(manifestPath, 'changed bytes');

      const described = describePlan({ plan });
      const executed = await executeRun({ plan });
      const expectedManifest = {
        path: manifestPath,
        sha256: 'a743ebaa08d1272d09f6052fb0327eeb5bf69d75138922d5261e765166bcf8ff',
        schemaVersion: 1,
      };

      for (const result of [described, executed]) {
        expect(result.manifest).toEqual(expectedManifest);
        expect(result).not.toHaveProperty('manifestPath');
        expect(result.product).toEqual({ name: 'Example', version: '1.0.0' });
        expect(serializeResult(result)).toContain('"manifest": {');
        expect(serializeResult(result)).not.toContain('"manifestPath"');
      }
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('emits the exact opaque plan while keeping its secret values safe to render', async () => {
    const secret = 'opaque-secret-value';
    const { plan } = setup(
      [
        'inputs:',
        '  token:',
        '    type: secret',
        'steps:',
        '  - id: use',
        '    run:',
        '      command: a',
        '      args: ["${token}", "prefix-${token}-suffix"]',
        '      cwd: "${token}"',
        '      env:',
        '        OPAQUE_SECRET: "${token}"',
        '        COMPOSED_SECRET: "prefix-${token}-suffix"',
      ],
      { overrides: new Map([['token', secret]]) },
    );
    const events: RunEvent[] = [];
    let runnerSawOpaqueValues = false;

    const result = await executeRun({
      plan,
      observer: (event) => events.push(event),
      runner: stubRunner((request) => {
        runnerSawOpaqueValues = [
          request.command.argv[1],
          request.command.argv[2],
          request.command.cwd,
          request.command.env['OPAQUE_SECRET'],
          request.command.env['COMPOSED_SECRET'],
        ].every(isSecretString);
        return { kind: 'exited', exitCode: 0 };
      }),
    });

    const started = events.find((event) => event.kind === 'runStarted');
    expect(started?.kind).toBe('runStarted');
    if (started?.kind !== 'runStarted') {
      throw new Error('runStarted event was not emitted');
    }
    const isDeeplyFrozen = (value: unknown): boolean =>
      typeof value !== 'object' ||
      value === null ||
      (Object.isFrozen(value) && Object.values(value).every(isDeeplyFrozen));
    const pendingStep = started.plan.steps[0];
    if (pendingStep?.state !== 'PENDING') {
      throw new Error('expected a pending step');
    }
    const opaqueValues = [
      started.plan.resolvedInputs[0]?.value,
      pendingStep.command.argv[1],
      pendingStep.command.argv[2],
      pendingStep.command.cwd,
      pendingStep.command.env['OPAQUE_SECRET'],
      pendingStep.command.env['COMPOSED_SECRET'],
    ];

    expect(started.plan).toBe(plan);
    expect(isDeeplyFrozen(started.plan)).toBe(true);
    expect(() => describePlan({ plan: started.plan })).not.toThrow();
    expect(opaqueValues.every(isSecretString)).toBe(true);
    for (const value of opaqueValues) {
      expect(String(value)).toBe('***');
      expect(JSON.stringify(value)).toBe('"***"');
      expect(inspect(value)).toBe('***');
    }
    expect(JSON.stringify(started.plan)).not.toContain(secret);
    expect(inspect(started.plan)).not.toContain(secret);
    expect(runnerSawOpaqueValues).toBe(true);
    expect(result.inputs[0]?.value).toBeNull();
    expect(result.steps[0]?.command).toEqual(['a', '***', '***']);
  });
});

describe('the plan execution context', () => {
  it('uses the product and input snapshots bound when the plan was built', async () => {
    const manifest = parseManifestText(
      [
        ...HEAD,
        'inputs:',
        '  tools:',
        '    type: multiselect',
        '    options: [git, docker]',
        'steps:',
        '  - id: use',
        '    run:',
        '      command: a',
        '      successExitCodes: [0]',
        '',
      ].join('\n'),
      'installer.yaml',
      { manifestDir: TEST_MANIFEST_DIR },
    );
    const context = createRuntimeContext({
      manifestDir: TEST_MANIFEST_DIR,
      product: manifest.product,
      platform: hostPlatform(),
      environment: {},
    });
    const resolution = resolveInputs({
      manifest,
      context,
      overrides: new Map([['tools', 'git,docker']]),
    });
    const plan = buildPlan({ manifest, resolution, context });

    expect(() => (resolution.inputs[0]?.value as string[]).push('changed')).toThrow(TypeError);
    expect(() =>
      Object.assign(resolution.inputs[0] as object, {
        id: 'changed',
        source: 'answer',
        enabled: false,
        ignored: 'set',
      }),
    ).toThrow(TypeError);
    const described = describePlan({ plan });
    const executed = await executeRun({
      plan,
      runner: stubRunner(() => ({ kind: 'exited', exitCode: 1 })),
    });

    for (const result of [described, executed]) {
      expect(result.product).toEqual({ name: 'Example', version: '1.0.0' });
      expect(result.inputs[0]).toMatchObject({
        id: 'tools',
        value: ['git', 'docker'],
        source: 'set',
        enabled: true,
      });
      expect(result.inputs[0]).not.toHaveProperty('ignored');
    }
    expect(executed.status).toBe('failed');
  });

  it('uses the registry created by resolution to mask child and result output', async () => {
    const manifest = parseManifestText(
      [
        ...HEAD,
        'inputs:',
        '  token:',
        '    type: secret',
        'steps:',
        '  - id: use',
        '    run:',
        '      command: a',
        '',
      ].join('\n'),
      'installer.yaml',
      { manifestDir: TEST_MANIFEST_DIR },
    );
    const context = createRuntimeContext({
      manifestDir: TEST_MANIFEST_DIR,
      product: manifest.product,
      platform: hostPlatform(),
      environment: {},
    });
    const resolution = resolveInputs({
      manifest,
      context,
      overrides: new Map([['token', 'bound-secret']]),
    });
    const plan = buildPlan({ manifest, resolution, context });

    const result = await executeRun({
      plan,
      runner: stubRunner((request) => {
        request.onOutput('stderr', 'leaked bound-secret');
        return { kind: 'exited', exitCode: 1 };
      }),
    });

    expect(result.inputs[0]).toMatchObject({ value: null, secret: true });
    expect(result.steps[0]?.outputTail).toEqual([
      { stream: 'stderr', line: 'leaked ***' },
      {
        stream: 'stderr',
        line: 'RUNE-401 step "use" exited with code 1; expected one of [0]',
      },
    ]);
    expect(JSON.stringify(result)).not.toContain('bound-secret');
  });

  it('rejects copied or forged plan instances before running anything', async () => {
    const { plan } = setup(TWO_STEPS);
    const copiedPlan = { ...plan } as ExecutionPlan;
    let runs = 0;

    expect(() => describePlan({ plan: copiedPlan })).toThrow(/not created by buildPlan/);
    await expect(
      executeRun({
        plan: copiedPlan,
        runner: stubRunner(() => {
          runs += 1;
          return { kind: 'exited', exitCode: 0 };
        }),
      }),
    ).rejects.toThrow(/not created by buildPlan/);
    expect(runs).toBe(0);
  });
});

describe('the result run block', () => {
  it('records the run id every child saw', async () => {
    const { plan } = setup(TWO_STEPS);
    const seen: string[] = [];

    const result = await executeRun({
      plan,
      runner: stubRunner((request) => {
        seen.push(`${request.extraEnv['RUNE_RUN_ID']}`);
        return { kind: 'exited', exitCode: 0 };
      }),
    });

    expect(result.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(seen).toEqual([result.id, result.id]);
  });

  it('keeps the provenance of a value that was ignored for a disabled input', async () => {
    const { plan } = setup(
      [
        'inputs:',
        '  installDatabase:',
        '    type: boolean',
        '    default: false',
        '  databasePort:',
        '    type: text',
        '    when: "${installDatabase}"',
        'steps:',
        '  - id: a',
        '    run:',
        '      command: a',
      ],
      { overrides: new Map([['databasePort', '9999']]) },
    );

    const result = await executeRun({
      plan,
      runner: stubRunner(() => ({ kind: 'exited', exitCode: 0 })),
    });

    const port = result.inputs.find((input) => input.id === 'databasePort');
    expect(port).toMatchObject({ enabled: false, ignored: 'input disabled', source: 'set' });
  });

  it('serializes ignored only for values discarded from disabled inputs', () => {
    const { plan } = setup(
      [
        'inputs:',
        '  enabled:',
        '    type: boolean',
        '    default: false',
        '  normal:',
        '    type: text',
        '    default: value',
        '  disabledWithoutValue:',
        '    type: text',
        '    when: "${enabled}"',
        '  disabledWithValue:',
        '    type: text',
        '    when: "${enabled}"',
        'steps: []',
      ],
      { overrides: new Map([['disabledWithValue', 'ignored']]) },
    );

    const result = describePlan({ plan });
    const serialized = JSON.parse(serializeResult(result)) as {
      inputs: Array<Record<string, unknown>>;
    };
    const input = (id: string): Record<string, unknown> =>
      serialized.inputs.find((entry) => entry['id'] === id)!;

    expect(
      Object.hasOwn(
        result.inputs.find((entry) => entry.id === 'normal')!,
        'ignored',
      ),
    ).toBe(false);
    expect(
      Object.hasOwn(
        result.inputs.find((entry) => entry.id === 'disabledWithoutValue')!,
        'ignored',
      ),
    ).toBe(false);
    expect(
      Object.hasOwn(
        result.inputs.find((entry) => entry.id === 'disabledWithValue')!,
        'ignored',
      ),
    ).toBe(true);
    expect(Object.hasOwn(input('normal'), 'ignored')).toBe(false);
    expect(Object.hasOwn(input('disabledWithoutValue'), 'ignored')).toBe(false);
    expect(Object.hasOwn(input('disabledWithValue'), 'ignored')).toBe(true);
    expect(input('disabledWithValue')).toMatchObject({ ignored: 'input disabled', source: 'set' });
    expect(input('disabledWithoutValue')).toMatchObject({ enabled: false, source: null });
  });

  it('serializes outputTail only for failed steps', async () => {
    const pending = describePlan({ plan: setup(TWO_STEPS).plan });
    const succeeded = await executeRun({
      plan: setup(TWO_STEPS).plan,
      runner: stubRunner(() => ({ kind: 'exited', exitCode: 0 })),
    });
    const skipped = await executeRun({
      plan: setup([
        'inputs:',
        '  enabled:',
        '    type: boolean',
        '    default: false',
        'steps:',
        '  - id: skipped',
        '    when: "${enabled}"',
        '    run:',
        '      command: a',
      ]).plan,
    });
    const cancelled = await executeRun({
      plan: setup(TWO_STEPS).plan,
      runner: stubRunner(() => ({ kind: 'cancelled' })),
    });
    const failedWithoutOutput = await executeRun({
      plan: setup(TWO_STEPS).plan,
      runner: stubRunner(() => ({ kind: 'exited', exitCode: 1 })),
    });
    const failedWithTail = await executeRun({
      plan: setup(TWO_STEPS).plan,
      runner: stubRunner((request) => {
        request.onOutput('stderr', 'failure details');
        return { kind: 'exited', exitCode: 1 };
      }),
    });
    const absent = [
      { result: pending, index: 0 },
      { result: skipped, index: 0 },
      { result: succeeded, index: 0 },
      { result: cancelled, index: 0 },
      { result: failedWithoutOutput, index: 1 },
    ];

    for (const { result, index } of absent) {
      const step = result.steps[index]!;
      expect(Object.hasOwn(step, 'outputTail')).toBe(false);
      const serialized = JSON.parse(serializeResult(result)) as {
        steps: Array<Record<string, unknown>>;
      };
      expect(Object.hasOwn(serialized.steps[index]!, 'outputTail')).toBe(false);
    }
    const failureDiagnostic = {
      stream: 'stderr' as const,
      line: 'RUNE-401 step "first" exited with code 1; expected one of [0]',
    };
    expect(failedWithoutOutput.steps[0]?.outputTail).toEqual([failureDiagnostic]);
    expect(Object.hasOwn(failedWithoutOutput.steps[0]!, 'outputTail')).toBe(true);
    const serializedFailedWithoutOutput = JSON.parse(serializeResult(failedWithoutOutput)) as {
      steps: Array<Record<string, unknown>>;
    };
    expect(Object.hasOwn(serializedFailedWithoutOutput.steps[0]!, 'outputTail')).toBe(true);
    expect(serializedFailedWithoutOutput.steps[0]).toMatchObject({
      outputTail: [failureDiagnostic],
    });
    expect(failedWithTail.steps[0]?.outputTail).toEqual([
      { stream: 'stderr', line: 'failure details' },
      failureDiagnostic,
    ]);
    const serializedFailedWithTail = JSON.parse(serializeResult(failedWithTail)) as {
      steps: Array<Record<string, unknown>>;
    };
    expect(Object.hasOwn(serializedFailedWithTail.steps[0]!, 'outputTail')).toBe(true);
    expect(serializedFailedWithTail.steps[0]).toMatchObject({
      outputTail: [{ stream: 'stderr', line: 'failure details' }, failureDiagnostic],
    });
  });
});
