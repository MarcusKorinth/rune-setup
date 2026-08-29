import { describe, expect, it } from 'vitest';

import { CancelToken } from '../../src/engine/cancel.js';
import { createRuntimeContext, hostPlatform } from '../../src/engine/context.js';
import { describePlan, executeRun } from '../../src/engine/executor.js';
import { resolveInputs } from '../../src/engine/inputs.js';
import { buildPlan, type ExecutionPlan } from '../../src/engine/plan.js';
import { SecretRegistry } from '../../src/engine/secrets.js';
import type { RunEvent } from '../../src/engine/events.js';
import type { Runner, SpawnOutcome, SpawnRequest } from '../../src/runners/base.js';
import { parseManifestText } from '../../src/manifest/index.js';
import type { CommandSpec, ManifestV1 } from '../../src/manifest/v1/schema.js';

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
): {
  plan: ExecutionPlan;
  secrets: SecretRegistry;
} {
  const failFastLine = options.failFast === false ? ['execution:', '  failFast: false'] : [];
  const manifest = parseManifestText(
    [...HEAD, ...failFastLine, ...lines, ''].join('\n'),
    'installer.yaml',
  );
  const context = createRuntimeContext({
    manifestDir: '/project',
    product: manifest.product,
    platform: hostPlatform(),
    environment: {},
  });
  const secrets = new SecretRegistry();
  const resolution = resolveInputs({
    manifest,
    context,
    environment: {},
    secrets,
    ...(options.overrides === undefined ? {} : { overrides: options.overrides }),
  });
  return {
    plan: buildPlan({ manifest, manifestPath: 'installer.yaml', resolution, context }),
    secrets,
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
    const { plan, secrets } = setup(TWO_STEPS, {
      failFast: false,
    });
    secrets.register('super-secret');
    let call = 0;

    const result = await executeRun({
      plan,
      runner: stubRunner((request) => {
        request.onOutput('stdout', 'the token is super-secret');
        return { kind: 'exited', exitCode: (call += 1) === 1 ? 1 : 0 };
      }),
    });

    expect(result.steps[0]?.outputTail).toEqual([{ stream: 'stdout', line: 'the token is ***' }]);
    expect(result.steps[1]?.outputTail).toBeNull();
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

  it('treats a command that cannot start as a failed step, not a crash', async () => {
    const { plan } = setup(TWO_STEPS);

    const result = await executeRun({
      plan,
      runner: stubRunner(() => ({ kind: 'failedToStart', message: 'spawn a ENOENT' })),
    });

    expect(result.status).toBe('failed');
    expect(result.steps[0]?.outputTail?.[0]?.line).toContain('could not be started');
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
        line: 'step "rejected" could not be started: runner failed before reporting an outcome',
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
    expect(result.steps[0]?.outputTail?.[0]?.line).toContain('process could not be started');
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
    expect(result.steps[0]?.outputTail).toBeNull();
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
        line: 'step "late-output" could not be started: runner failed before reporting an outcome',
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
    expect(lines.at(-1)).toContain('exceeded its timeout of 1 seconds');
  });
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
    expect(result.steps.map((step) => step.state)).toEqual(['PENDING', 'PENDING']);
    expect(result.steps[0]?.command).toEqual(['a']);
  });

  it('refuses to execute a cross-platform preview plan', async () => {
    const manifest = parseManifestText(
      [...HEAD, 'steps:', '  - id: a', '    run:', '      command: a', ''].join('\n'),
      'installer.yaml',
    );
    const foreign = hostPlatform() === 'windows' ? 'linux' : 'windows';
    const context = createRuntimeContext({
      manifestDir: '/project',
      product: manifest.product,
      platform: foreign,
      environment: {},
    });
    const resolution = resolveInputs({ manifest, context, environment: {} });
    const plan = buildPlan({ manifest, manifestPath: 'installer.yaml', resolution, context });

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
});

describe('the plan execution context', () => {
  it('uses the product and input snapshots bound when the plan was built', async () => {
    const manifest = structuredClone(
      parseManifestText(
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
      ),
    ) as ManifestV1;
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
    const plan = buildPlan({ manifest, manifestPath: 'installer.yaml', resolution, context });

    Object.assign(manifest.product, { name: 'Changed', version: '9.9.9' });
    (resolution.inputs[0]?.value as string[]).push('changed');
    Object.assign(resolution.inputs[0] as object, {
      id: 'changed',
      source: 'answer',
      enabled: false,
      ignored: 'set',
    });
    const command = manifest.steps[0]?.run as CommandSpec;
    (command.successExitCodes as number[]).push(1);

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
        ignored: null,
      });
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
    const plan = buildPlan({ manifest, manifestPath: 'installer.yaml', resolution, context });

    const result = await executeRun({
      plan,
      runner: stubRunner((request) => {
        request.onOutput('stderr', 'leaked bound-secret');
        return { kind: 'exited', exitCode: 1 };
      }),
    });

    expect(result.inputs[0]).toMatchObject({ value: null, secret: true });
    expect(result.steps[0]?.outputTail).toEqual([{ stream: 'stderr', line: 'leaked ***' }]);
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
});
