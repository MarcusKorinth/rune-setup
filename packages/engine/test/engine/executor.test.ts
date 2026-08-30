import { describe, expect, it } from 'vitest';

import { CancelToken } from '../../src/engine/cancel.js';
import { createRuntimeContext, hostPlatform } from '../../src/engine/context.js';
import { describePlan, executeRun } from '../../src/engine/executor.js';
import { resolveInputs, type Resolution } from '../../src/engine/inputs.js';
import { buildPlan, type ExecutionPlan } from '../../src/engine/plan.js';
import { SecretRegistry } from '../../src/engine/secrets.js';
import type { RunEvent } from '../../src/engine/events.js';
import type { Runner, SpawnOutcome, SpawnRequest } from '../../src/runners/base.js';
import { parseManifestText } from '../../src/manifest/index.js';

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
  resolution: Resolution;
  secrets: SecretRegistry;
  product: { name: string; version: string };
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
    resolution,
    secrets,
    product: manifest.product,
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
    const { plan, resolution, secrets, product } = setup(TWO_STEPS);
    const events: RunEvent[] = [];

    const result = await executeRun({
      plan,
      resolution,
      product,
      secrets,
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
    const { plan, resolution, secrets, product } = setup(TWO_STEPS);
    const seen: string[] = [];

    await executeRun({
      plan,
      resolution,
      product,
      secrets,
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
    const { plan, resolution, secrets, product } = setup(TWO_STEPS);

    const result = await executeRun({
      plan,
      resolution,
      product,
      secrets,
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
    const { plan, resolution, secrets, product } = setup(TWO_STEPS, { failFast: false });
    let call = 0;

    const result = await executeRun({
      plan,
      resolution,
      product,
      secrets,
      runner: stubRunner(() => ({ kind: 'exited', exitCode: (call += 1) === 1 ? 9 : 0 })),
    });

    expect(result).toMatchObject({ status: 'failed', stepsFailed: 1, stepsSucceeded: 1 });
  });

  it('keeps the masked tail of a failed step, and only of a failed step', async () => {
    const { plan, resolution, secrets, product } = setup(TWO_STEPS, {
      failFast: false,
    });
    secrets.register('super-secret');
    let call = 0;

    const result = await executeRun({
      plan,
      resolution,
      product,
      secrets,
      runner: stubRunner((request) => {
        request.onOutput('stdout', 'the token is super-secret');
        return { kind: 'exited', exitCode: (call += 1) === 1 ? 1 : 0 };
      }),
    });

    expect(result.steps[0]?.outputTail).toEqual([{ stream: 'stdout', line: 'the token is ***' }]);
    expect(result.steps[1]?.outputTail).toBeNull();
  });

  it('honours successExitCodes instead of assuming zero', async () => {
    const { plan, resolution, secrets, product } = setup([
      'steps:',
      '  - id: robocopy-style',
      '    run:',
      '      command: a',
      '      successExitCodes: [0, 1]',
    ]);

    const result = await executeRun({
      plan,
      resolution,
      product,
      secrets,
      runner: stubRunner(() => ({ kind: 'exited', exitCode: 1 })),
    });

    expect(result.status).toBe('succeeded');
  });

  it('treats a command that cannot start as a failed step, not a crash', async () => {
    const { plan, resolution, secrets, product } = setup(TWO_STEPS);

    const result = await executeRun({
      plan,
      resolution,
      product,
      secrets,
      runner: stubRunner(() => ({ kind: 'failedToStart', message: 'spawn a ENOENT' })),
    });

    expect(result.status).toBe('failed');
    expect(result.steps[0]?.outputTail?.[0]?.line).toContain('could not be started');
  });
});

describe('cancellation and timeout', () => {
  it('marks the interrupted step CANCELLED, the rest NOT_RUN, and the run cancelled', async () => {
    const { plan, resolution, secrets, product } = setup(TWO_STEPS);
    const cancel = new CancelToken();

    const result = await executeRun({
      plan,
      resolution,
      product,
      secrets,
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
    const { plan, resolution, secrets, product } = setup([
      'steps:',
      '  - id: slow',
      '    run:',
      '      command: a',
      '      timeoutSeconds: 1',
    ]);
    const lines: string[] = [];

    const result = await executeRun({
      plan,
      resolution,
      product,
      secrets,
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
    const { plan, resolution, secrets, product } = setup(CONDITIONAL);
    const events: RunEvent[] = [];

    const result = await executeRun({
      plan,
      resolution,
      product,
      secrets,
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
    const { plan, resolution, secrets, product } = setup(TWO_STEPS);

    const result = describePlan({ plan, resolution, product, secrets });

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
    const secrets = new SecretRegistry();
    const resolution = resolveInputs({ manifest, context, environment: {}, secrets });
    const plan = buildPlan({ manifest, manifestPath: 'installer.yaml', resolution, context });

    await expect(
      executeRun({ plan, resolution, product: manifest.product, secrets }),
    ).rejects.toThrow(/preview plan/);
  });

  it('masks a secret in the argv a result shows', async () => {
    const { plan, resolution, secrets, product } = setup(
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

    const result = describePlan({ plan, resolution, product, secrets });

    expect(result.steps[0]?.command).toEqual(['a', '--token', '***']);
    expect(JSON.stringify(result)).not.toContain('super-secret-value');
  });

  it('masks registered secret text in every string-shaped input result value', () => {
    const secret = 'overlap-secret-value';
    const { plan, resolution, secrets, product } = setup(
      [
        'inputs:',
        '  token:',
        '    type: secret',
        '  exact:',
        '    type: text',
        '  embedded:',
        '    type: text',
        '  items:',
        '    type: multiselect',
        '    options:',
        '      - safe',
        `      - ${secret}`,
        `      - prefix-${secret}-suffix`,
        '  unchanged:',
        '    type: text',
        '  enabled:',
        '    type: boolean',
        'steps: []',
      ],
      {
        overrides: new Map([
          ['token', secret],
          ['exact', secret],
          ['embedded', `prefix-${secret}-suffix`],
          ['items', JSON.stringify(['safe', secret, `prefix-${secret}-suffix`])],
          ['unchanged', 'ordinary'],
          ['enabled', 'true'],
        ]),
      },
    );

    const result = describePlan({ plan, resolution, product, secrets });
    const values = Object.fromEntries(result.inputs.map((input) => [input.id, input.value]));

    expect(values).toEqual({
      token: null,
      exact: '***',
      embedded: 'prefix-***-suffix',
      items: ['safe', '***', 'prefix-***-suffix'],
      unchanged: 'ordinary',
      enabled: true,
    });
    expect(JSON.stringify(result.inputs)).not.toContain(secret);
  });

  it('never lets a secret reach an observer, not even inside RunStarted', async () => {
    const { plan, resolution, secrets, product } = setup(
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
      resolution,
      product,
      secrets,
      observer: (event) => events.push(event),
      runner: stubRunner(() => ({ kind: 'exited', exitCode: 0 })),
    });

    expect(JSON.stringify(events)).not.toContain('super-secret-value');
    expect(JSON.stringify(result)).not.toContain('super-secret-value');
  });
});

describe('the result run block', () => {
  it('records the run id every child saw', async () => {
    const { plan, resolution, secrets, product } = setup(TWO_STEPS);
    const seen: string[] = [];

    const result = await executeRun({
      plan,
      resolution,
      product,
      secrets,
      runner: stubRunner((request) => {
        seen.push(`${request.extraEnv['RUNE_RUN_ID']}`);
        return { kind: 'exited', exitCode: 0 };
      }),
    });

    expect(result.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(seen).toEqual([result.id, result.id]);
  });

  it('keeps the provenance of a value that was ignored for a disabled input', async () => {
    const { plan, resolution, secrets, product } = setup(
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
      resolution,
      product,
      secrets,
      runner: stubRunner(() => ({ kind: 'exited', exitCode: 0 })),
    });

    const port = result.inputs.find((input) => input.id === 'databasePort');
    expect(port).toMatchObject({ enabled: false, ignored: 'input disabled', source: 'set' });
  });
});
