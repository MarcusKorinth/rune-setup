import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import { CancelToken } from '../../src/engine/cancel.js';
import { createRuntimeContext, hostPlatform } from '../../src/engine/context.js';
import { describePlan, executeRun, OUTPUT_TAIL_LINES } from '../../src/engine/executor.js';
import { resolveInputs, resolveInputsWithRegistry } from '../../src/engine/inputs.js';
import { buildPlan, type ExecutionPlan } from '../../src/engine/plan.js';
import { isSecretString, SecretRegistry } from '../../src/engine/secrets.js';
import type { RunEvent } from '../../src/engine/events.js';
import type { Runner, SpawnOutcome, SpawnRequest } from '../../src/runners/base.js';
import {
  MAX_OUTPUT_LINE_BYTES,
  OVERSIZED_OUTPUT_LINE_PLACEHOLDER,
} from '../../src/runners/spawnRunner.js';
import { parseManifest, parseManifestText } from '../../src/manifest/index.js';
import { serializeResult } from '../../src/results/writer.js';

const HEAD = ['schemaVersion: 1', 'product:', '  name: Example', '  version: "1.0.0"'];

/** A runner whose behaviour per step is written into the test, so nothing real is spawned. */
function stubRunner(
  behave: (request: SpawnRequest) => SpawnOutcome | Promise<SpawnOutcome>,
): Runner {
  return { run: async (request) => behave(request) };
}

function setup(
  lines: readonly string[],
  options: { overrides?: ReadonlyMap<string, string>; failFast?: boolean } = {},
): { plan: ExecutionPlan } {
  const failFastLine = options.failFast === false ? ['execution:', '  failFast: false'] : [];
  const manifest = parseManifestText(
    [...HEAD, ...failFastLine, ...lines, ''].join('\n'),
    'installer.yaml',
    { manifestDir: '/project' },
  );
  const context = createRuntimeContext({
    manifestDir: '/project',
    product: manifest.product,
    platform: hostPlatform(),
    environment: {},
  });
  const resolution = resolveInputs({
    manifest,
    context,
    environment: {},
    ...(options.overrides === undefined ? {} : { overrides: options.overrides }),
  });
  return {
    plan: buildPlan({ manifest, resolution, context }),
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
      stepsTotal: 2,
      stepsExecuted: 2,
      stepsSucceeded: 2,
      nothingExecuted: false,
    });
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

    const result = await executeRun({
      plan,
      observer: (event) => {
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

    expect(result).toMatchObject({ status: 'failed', exitCode: 1, stepsFailed: 1, stepsNotRun: 1 });
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

  it('omits an oversized default-runner line before masking can split its secret', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'rune-bounded-output-'));
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
      environment: {},
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

    const result = await executeRun({
      plan,
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
      stepsTotal: 0,
      stepsExecuted: 0,
      stepsSkipped: 0,
      stepsNotRun: 0,
      nothingExecuted: true,
    });
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
  });

  it('passes cancellation from StepStarted to the running step', async () => {
    const { plan } = setup(TWO_STEPS);
    const cancel = new CancelToken();
    let calls = 0;

    const result = await executeRun({
      plan,
      cancel,
      observer: (event) => {
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

  it('consumes cancellation after a failure when fail-fast is disabled', async () => {
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
      status: 'cancelled',
      exitCode: 6,
      stepsFailed: 1,
      stepsNotRun: 1,
    });
    expect(result.steps.map((step) => step.state)).toEqual(['FAILED', 'NOT_RUN']);
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
    expect(result).toMatchObject({ status: 'succeeded', nothingExecuted: true, stepsSkipped: 1 });
  });

  it('describes a plan without executing anything', () => {
    const { plan } = setup(TWO_STEPS);

    const result = describePlan({ plan });

    expect(result).toMatchObject({ status: 'planned', exitCode: 0, dryRun: true });
    expect(result.startedAt).toBe(result.finishedAt);
    expect(result.durationMs).toBe(0);
    expect(result.steps.every((step) => step.durationMs === 0)).toBe(true);
    expect(result.steps.map((step) => step.state)).toEqual(['PENDING', 'PENDING']);
    expect(result.steps[0]?.command).toEqual(['a']);
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
      { manifestDir: '/project' },
    );
    const foreign = hostPlatform() === 'windows' ? 'linux' : 'windows';
    const context = createRuntimeContext({
      manifestDir: '/project',
      product: manifest.product,
      platform: foreign,
      environment: {},
    });
    const resolution = resolveInputs({ manifest, context, environment: {} });
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

  it('keeps plan masking fixed after its retained registry later changes', async () => {
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
      { manifestDir: '/project' },
    );
    const context = createRuntimeContext({
      manifestDir: '/project',
      product: manifest.product,
      platform: hostPlatform(),
      environment: {},
    });
    const secrets = new SecretRegistry();
    const resolution = resolveInputsWithRegistry(
      {
        manifest,
        context,
        environment: {},
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
    expect(started.plan.resolvedInputs.find((input) => input.id === 'note')?.value).toBe(later);
    expect(started.plan.steps[0]).toMatchObject({
      title: `*** ${later}`,
      command: { argv: ['***', later] },
    });
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
    const manifestPath = join(directory, 'installer.yaml');
    writeFileSync(manifestPath, [...HEAD, 'steps: []', ''].join('\n'));
    const manifest = parseManifest(manifestPath);
    const context = createRuntimeContext({
      manifestDir: directory,
      product: manifest.product,
      platform: hostPlatform(),
      environment: {},
    });
    const resolution = resolveInputs({ manifest, context, environment: {} });
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
  });

  it('never lets a secret reach an observer, not even inside RunStarted', async () => {
    const { plan } = setup(
      [
        'inputs:',
        '  token:',
        '    type: secret',
        'steps:',
        '  - id: use',
        '    run:',
        '      command: a',
        '      args: ["${token}"]',
      ],
      { overrides: new Map([['token', 'super-secret-value']]) },
    );
    const events: RunEvent[] = [];

    const result = await executeRun({
      plan,
      observer: (event) => events.push(event),
      runner: stubRunner(() => ({ kind: 'exited', exitCode: 0 })),
    });

    expect(JSON.stringify(events)).not.toContain('super-secret-value');
    expect(JSON.stringify(result)).not.toContain('super-secret-value');
  });

  it('projects an opaque plan into clone-safe masked event and result sinks', async () => {
    const secret = 'sink-secret-value';
    const { plan } = setup(
      [
        'inputs:',
        '  token:',
        '    type: secret',
        '  note:',
        '    type: text',
        `    default: "prefix ${secret} suffix"`,
        '  selections:',
        '    type: multiselect',
        `    options: [${secret}, other]`,
        `    default: [${secret}, other]`,
        'steps:',
        '  - id: skipped',
        `    title: "Skip ${secret}"`,
        `    when: "\${token} != '${secret}'"`,
        '    run:',
        '      command: never',
        '  - id: use',
        `    title: "Use ${secret}"`,
        '    run:',
        '      command: a',
        `      args: ["\${token}", "prefix ${secret} suffix"]`,
        `      cwd: "./${secret}"`,
        '      env:',
        `        PUBLIC_COPY: "prefix ${secret} suffix"`,
        '        OPAQUE_SECRET: "${token}"',
      ],
      { overrides: new Map([['token', secret]]) },
    );
    const events: RunEvent[] = [];
    let runnerSawSecret = false;

    const result = await executeRun({
      plan,
      observer: (event) => events.push(event),
      runner: stubRunner((request) => {
        const value = request.command.argv[1];
        expect(isSecretString(value)).toBe(true);
        runnerSawSecret = isSecretString(value);
        return { kind: 'exited', exitCode: 0 };
      }),
    });

    const started = events.find((event) => event.kind === 'runStarted');
    expect(started?.kind).toBe('runStarted');
    if (started?.kind !== 'runStarted') {
      throw new Error('runStarted event was not emitted');
    }
    const projection = started.plan;
    const clonedProjection = structuredClone(projection);
    const containsSecretString = (value: unknown): boolean => {
      if (isSecretString(value)) {
        return true;
      }
      return (
        typeof value === 'object' &&
        value !== null &&
        Object.values(value).some(containsSecretString)
      );
    };
    const isDeeplyFrozen = (value: unknown): boolean =>
      typeof value !== 'object' ||
      value === null ||
      (Object.isFrozen(value) && Object.values(value).every(isDeeplyFrozen));

    expect(projection).not.toBe(plan);
    expect(Object.keys(projection)).toEqual(Object.keys(plan));
    expect(projection.planSchemaVersion).toBe(1);
    expect(projection.manifestPath).toBe(plan.manifestPath);
    expect(projection.manifestSha256).toBe(plan.manifestSha256);
    expect(projection.executionOptions).toEqual(plan.executionOptions);
    expect(projection.resolvedInputs).toMatchObject([
      { id: 'token', value: '***', source: 'set', secret: true, enabled: true },
      {
        id: 'note',
        value: 'prefix *** suffix',
        source: 'default',
        secret: false,
        enabled: true,
      },
      {
        id: 'selections',
        value: ['***', 'other'],
        source: 'default',
        secret: false,
        enabled: true,
      },
    ]);
    expect(projection.resolvedInputs.map(({ value: _value, ...metadata }) => metadata)).toEqual(
      plan.resolvedInputs.map(({ value: _value, ...metadata }) => metadata),
    );
    expect(containsSecretString(projection)).toBe(false);
    expect(isDeeplyFrozen(projection)).toBe(true);
    expect(clonedProjection).toEqual(projection);
    expect(() => describePlan({ plan: projection })).toThrow(/not created by buildPlan/);
    expect(runnerSawSecret).toBe(true);

    expect(projection.steps).toMatchObject([
      {
        id: 'skipped',
        title: 'Skip ***',
        skipReason: "condition false: ${token} != '***'",
      },
      {
        id: 'use',
        title: 'Use ***',
        command: {
          argv: ['a', '***', 'prefix *** suffix'],
          env: { PUBLIC_COPY: 'prefix *** suffix', OPAQUE_SECRET: '***' },
        },
      },
    ]);
    expect(JSON.stringify(projection.steps[1])).not.toContain(secret);

    const startedStep = events.find((event) => event.kind === 'stepStarted');
    expect(startedStep).toMatchObject({ stepId: 'use', title: 'Use ***' });
    expect(result.steps).toMatchObject([
      {
        id: 'skipped',
        title: 'Skip ***',
        skipReason: "condition false: ${token} != '***'",
      },
      { id: 'use', title: 'Use ***' },
    ]);
    expect(result.inputs.find((input) => input.id === 'note')?.value).toBe('prefix *** suffix');
    expect(result.inputs.find((input) => input.id === 'selections')?.value).toEqual([
      '***',
      'other',
    ]);
    expect(result.inputs.find((input) => input.id === 'token')?.value).toBeNull();

    const preview = describePlan({ plan });
    expect(JSON.stringify({ events, result, preview })).not.toContain(secret);
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
      { manifestDir: '/project' },
    );
    const context = createRuntimeContext({
      manifestDir: '/project',
      product: manifest.product,
      platform: hostPlatform(),
      environment: {},
    });
    const resolution = resolveInputs({
      manifest,
      context,
      environment: {},
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
      { manifestDir: '/project' },
    );
    const context = createRuntimeContext({
      manifestDir: '/project',
      product: manifest.product,
      platform: hostPlatform(),
      environment: {},
    });
    const resolution = resolveInputs({
      manifest,
      context,
      environment: {},
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
      pending.steps[0]!,
      skipped.steps[0]!,
      succeeded.steps[0]!,
      cancelled.steps[0]!,
      failedWithoutOutput.steps[1]!,
    ];

    for (const step of absent) {
      expect(Object.hasOwn(step, 'outputTail')).toBe(false);
      const serialized = JSON.parse(serializeResult({ ...pending, steps: [step] })) as {
        steps: Array<Record<string, unknown>>;
      };
      expect(Object.hasOwn(serialized.steps[0]!, 'outputTail')).toBe(false);
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
