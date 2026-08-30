import { describe, expect, it } from 'vitest';

import { createRuntimeContext, hostPlatform } from '../../src/engine/context.js';
import { describePlan, executeRun } from '../../src/engine/executor.js';
import { resolveInputs } from '../../src/engine/inputs.js';
import { buildPlan } from '../../src/engine/plan.js';
import { SecretRegistry } from '../../src/engine/secrets.js';
import { parseManifestText } from '../../src/manifest/index.js';
import { resultJsonSchema, runResultSchema } from '../../src/results/schema.js';

type JsonResult = Record<string, unknown> & {
  steps: Record<string, unknown>[];
};

const HASH = 'a'.repeat(64);

async function producerResults(): Promise<{
  live: JsonResult;
  failed: JsonResult;
  planned: JsonResult;
}> {
  const manifest = parseManifestText(
    [
      'schemaVersion: 1',
      'product:',
      '  name: Example',
      '  version: "1.0.0"',
      '  description: More than the identity fields',
      'steps:',
      '  - id: a',
      '    run:',
      '      command: x',
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
  const secrets = new SecretRegistry();
  const resolution = resolveInputs({ manifest, context, environment: {}, secrets });
  const plan = buildPlan({
    manifest,
    manifestPath: 'installer.yaml',
    manifestSha256: HASH,
    resolution,
    context,
  });

  const live = await executeRun({
    plan,
    product: manifest.product,
    secrets,
    runner: { run: async () => ({ kind: 'exited', exitCode: 0 }) },
  });
  const failed = await executeRun({
    plan,
    product: manifest.product,
    secrets,
    runner: { run: async () => ({ kind: 'exited', exitCode: 1 }) },
  });
  const planned = describePlan({
    plan,
    product: manifest.product,
    secrets,
  });

  return {
    live: JSON.parse(JSON.stringify(live)) as JsonResult,
    failed: JSON.parse(JSON.stringify(failed)) as JsonResult,
    planned: JSON.parse(JSON.stringify(planned)) as JsonResult,
  };
}

function failureShell(source: JsonResult, status: string, exitCode: number): JsonResult {
  return {
    ...structuredClone(source),
    status,
    exitCode,
    dryRun: false,
    crossPlatformPreview: false,
    durationMs: 0,
    product: { name: '', version: '' },
    manifest: { path: 'broken.yaml', sha256: null, schemaVersion: null },
    stepsTotal: 0,
    stepsExecuted: 0,
    stepsSucceeded: 0,
    stepsFailed: 0,
    stepsCancelled: 0,
    stepsSkipped: 0,
    stepsNotRun: 0,
    nothingExecuted: true,
    inputs: [],
    steps: [],
  };
}

describe('the result schema', () => {
  it('accepts real live, failed, and dry-run results plus failure shells', async () => {
    const { live, failed, planned } = await producerResults();

    expect(() => runResultSchema.parse(live)).not.toThrow();
    expect(() => runResultSchema.parse(failed)).not.toThrow();
    expect(() => runResultSchema.parse(planned)).not.toThrow();

    const statuses = [
      ['config_error', 3],
      ['input_error', 4],
      ['resolution_error', 5],
      ['cancelled', 6],
      ['internal_error', 70],
    ] as const;
    for (const [status, exitCode] of statuses) {
      expect(() => runResultSchema.parse(failureShell(live, status, exitCode))).not.toThrow();
    }

    // A foreign-platform preview may fail before execution; its shell still records the
    // dry-run invocation and selected platform.
    const previewFailure = failureShell(live, 'config_error', 3);
    previewFailure['dryRun'] = true;
    previewFailure['crossPlatformPreview'] = true;
    previewFailure['platform'] = hostPlatform() === 'windows' ? 'linux' : 'windows';
    expect(() => runResultSchema.parse(previewFailure)).not.toThrow();
  });

  it('rejects impossible status, exit-code, dry-run, and preview combinations', async () => {
    const { live, failed, planned } = await producerResults();

    expect(() => runResultSchema.parse({ ...live, status: 'planned' })).toThrow();
    expect(() => runResultSchema.parse({ ...planned, status: 'succeeded' })).toThrow();
    expect(() => runResultSchema.parse({ ...failed, exitCode: 0 })).toThrow();

    const configError = failureShell(live, 'config_error', 3);
    expect(() => runResultSchema.parse({ ...configError, exitCode: 4 })).toThrow();
    expect(() => runResultSchema.parse({ ...configError, crossPlatformPreview: true })).toThrow();
  });

  it('rejects invalid numeric, identity, platform, timestamp, hash, and version values', async () => {
    const { live } = await producerResults();

    expect(() => runResultSchema.parse({ ...live, durationMs: -1 })).toThrow();
    expect(() => runResultSchema.parse({ ...live, stepsExecuted: -1 })).toThrow();
    expect(() => runResultSchema.parse({ ...live, stepsCancelled: 2 })).toThrow();
    expect(() => runResultSchema.parse({ ...live, platform: 'macos' })).toThrow();
    expect(() => runResultSchema.parse({ ...live, id: 'not-a-uuid' })).toThrow();
    expect(() => runResultSchema.parse({ ...live, startedAt: 'yesterday' })).toThrow();
    expect(() =>
      runResultSchema.parse({
        ...live,
        manifest: { path: 'installer.yaml', sha256: 'A'.repeat(64), schemaVersion: 1 },
      }),
    ).toThrow();
    expect(() =>
      runResultSchema.parse({
        ...live,
        manifest: { path: 'installer.yaml', sha256: HASH, schemaVersion: 2 },
      }),
    ).toThrow();
    expect(() =>
      runResultSchema.parse({
        ...live,
        manifest: { path: 'installer.yaml', sha256: null, schemaVersion: 1 },
      }),
    ).toThrow();
    expect(() =>
      runResultSchema.parse({
        ...live,
        manifest: { path: 'installer.yaml', sha256: HASH, schemaVersion: null },
      }),
    ).toThrow();
  });

  it('pins each final step state to the fields its producer can emit', async () => {
    const { live, failed, planned } = await producerResults();
    const succeededStep = live.steps[0] as Record<string, unknown>;
    const failedStep = failed.steps[0] as Record<string, unknown>;
    const pendingStep = planned.steps[0] as Record<string, unknown>;

    expect(() =>
      runResultSchema.parse({
        ...planned,
        steps: [{ ...pendingStep, state: 'RUNNING' }],
      }),
    ).toThrow();
    expect(() =>
      runResultSchema.parse({
        ...live,
        steps: [{ ...succeededStep, outputTail: [{ stream: 'stdout', line: 'extra' }] }],
      }),
    ).toThrow();
    expect(() =>
      runResultSchema.parse({ ...failed, steps: [{ ...failedStep, outputTail: null }] }),
    ).toThrow();
    expect(() =>
      runResultSchema.parse({
        ...failed,
        steps: [{ ...failedStep, outputTail: [{ stream: 'combined', line: 'bad' }] }],
      }),
    ).toThrow();
    expect(() =>
      runResultSchema.parse({ ...live, steps: [{ ...succeededStep, skipReason: 'no' }] }),
    ).toThrow();
    expect(() =>
      runResultSchema.parse({ ...planned, steps: [{ ...pendingStep, command: null }] }),
    ).toThrow();
    expect(() =>
      runResultSchema.parse({
        ...planned,
        steps: [succeededStep],
        stepsExecuted: 1,
        stepsSucceeded: 1,
        stepsNotRun: 0,
        nothingExecuted: false,
      }),
    ).toThrow();
    expect(() =>
      runResultSchema.parse({ ...live, steps: [{ ...succeededStep, durationMs: -1 }] }),
    ).toThrow();

    const skippedStep = {
      ...pendingStep,
      state: 'SKIPPED',
      command: null,
      skipReason: 'condition false: false',
    };
    const skippedPlan = {
      ...planned,
      stepsSkipped: 1,
      stepsNotRun: 0,
      steps: [skippedStep],
    };
    expect(() => runResultSchema.parse(skippedPlan)).not.toThrow();
    expect(() =>
      runResultSchema.parse({ ...skippedPlan, steps: [{ ...skippedStep, command: ['x'] }] }),
    ).toThrow();
    expect(() =>
      runResultSchema.parse({ ...skippedPlan, steps: [{ ...skippedStep, skipReason: null }] }),
    ).toThrow();

    expect(() =>
      runResultSchema.parse({
        ...live,
        dryRun: false,
        steps: [pendingStep],
        stepsExecuted: 0,
        stepsSucceeded: 0,
        stepsNotRun: 1,
        nothingExecuted: true,
      }),
    ).toThrow();
  });

  it('derives counters exactly from the step states', async () => {
    const { live, planned } = await producerResults();

    expect(() => runResultSchema.parse({ ...live, stepsSkipped: 1 })).toThrow();
    // The arithmetic identity still holds, but the labels contradict the SUCCEEDED step.
    expect(() => runResultSchema.parse({ ...live, stepsSucceeded: 0, stepsFailed: 1 })).toThrow();
    // PENDING contributes to stepsNotRun, not stepsSkipped, even though both totals are one.
    expect(() => runResultSchema.parse({ ...planned, stepsSkipped: 1, stepsNotRun: 0 })).toThrow();
    expect(() => runResultSchema.parse({ ...live, stepsTotal: 2, stepsNotRun: 1 })).toThrow();
    expect(() => runResultSchema.parse({ ...live, nothingExecuted: true })).toThrow();
  });

  it('pins success, failure, and cancellation statuses to safe step-state sets', async () => {
    const { live, failed } = await producerResults();
    const succeededStep = live.steps[0] as Record<string, unknown>;
    const failedStep = failed.steps[0] as Record<string, unknown>;

    expect(() =>
      runResultSchema.parse({
        ...live,
        steps: [failedStep],
        stepsSucceeded: 0,
        stepsFailed: 1,
      }),
    ).toThrow();
    expect(() => runResultSchema.parse({ ...live, status: 'failed', exitCode: 1 })).toThrow();

    const cancelledStep = {
      ...succeededStep,
      state: 'CANCELLED',
      exitCode: null,
    };
    expect(() =>
      runResultSchema.parse({
        ...failed,
        steps: [cancelledStep],
        stepsFailed: 0,
        stepsCancelled: 1,
      }),
    ).toThrow();

    // Cancellation has priority over prior failures and can happen between steps, so no
    // CANCELLED step is required.
    expect(() =>
      runResultSchema.parse({ ...failed, status: 'cancelled', exitCode: 6 }),
    ).not.toThrow();
  });

  it('keeps secret and ignored input projections internally consistent', async () => {
    const { live } = await producerResults();
    const secretInput = {
      id: 'password',
      value: null,
      source: 'set',
      secret: true,
      enabled: true,
      ignored: null,
    };
    const ignoredInput = {
      id: 'optional',
      value: '',
      source: 'values',
      secret: false,
      enabled: false,
      ignored: 'input disabled',
    };

    expect(() =>
      runResultSchema.parse({ ...live, inputs: [secretInput, ignoredInput] }),
    ).not.toThrow();
    expect(() =>
      runResultSchema.parse({ ...live, inputs: [{ ...secretInput, value: 'leaked' }] }),
    ).toThrow();
    expect(() =>
      runResultSchema.parse({ ...live, inputs: [{ ...ignoredInput, enabled: true }] }),
    ).toThrow();
    expect(() =>
      runResultSchema.parse({ ...live, inputs: [{ ...ignoredInput, source: null }] }),
    ).toThrow();
  });

  it('emits all locally representable rules and leaves sibling arithmetic to Zod', () => {
    const schema = resultJsonSchema();
    const serialized = JSON.stringify(schema);

    expect(schema['oneOf']).toHaveLength(8);
    expect(serialized).toContain('"const":"planned"');
    expect(serialized).toContain('"const":70');
    expect(serialized).toContain('"minimum":0');
    expect(serialized).toContain('"maximum":1');
    expect(serialized).toContain('"enum":["windows","linux"]');
    expect(serialized).toContain('"enum":["stdout","stderr"]');
    expect(serialized).toContain('"format":"uuid"');
    expect(serialized).toContain('"format":"date-time"');
    expect(serialized).toContain('"maxItems":50');
    expect(serialized).not.toContain('stepsTotal must equal');
  });
});
