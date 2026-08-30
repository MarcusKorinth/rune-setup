import { describe, expect, it } from 'vitest';

import { createRuntimeContext, hostPlatform } from '../../src/engine/context.js';
import { describeCancelled, describePlan, executeRun } from '../../src/engine/executor.js';
import { resolveInputs } from '../../src/engine/inputs.js';
import { buildPlan } from '../../src/engine/plan.js';
import { SecretRegistry } from '../../src/engine/secrets.js';
import type { RunMode, RunResult, RunStatus } from '../../src/results/model.js';
import { parseManifestText } from '../../src/manifest/index.js';
import { resultJsonSchema, runResultSchema } from '../../src/results/schema.js';
import type { Runner } from '../../src/runners/base.js';

const okRunner: Runner = { run: async () => ({ kind: 'exited', exitCode: 0 }) };

function setup() {
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
  const plan = buildPlan({ manifest, manifestPath: 'installer.yaml', resolution, context });

  return { plan, resolution, product: manifest.product, secrets };
}

type Setup = ReturnType<typeof setup>;

interface ResultCase {
  readonly name: string;
  readonly mode: RunMode;
  readonly create: (fields: Setup) => RunResult | Promise<RunResult>;
  readonly status: RunStatus;
  readonly dryRun: boolean;
  readonly exitCode: number;
  readonly stepState: string;
}

const resultCases: readonly ResultCase[] = [
  {
    name: 'a GUI execution',
    mode: 'gui',
    create: (fields) => executeRun({ ...fields, mode: 'gui', runner: okRunner }),
    status: 'succeeded',
    dryRun: false,
    exitCode: 0,
    stepState: 'SUCCEEDED',
  },
  {
    name: 'an interactive execution',
    mode: 'interactive',
    create: (fields) => executeRun({ ...fields, mode: 'interactive', runner: okRunner }),
    status: 'succeeded',
    dryRun: false,
    exitCode: 0,
    stepState: 'SUCCEEDED',
  },
  {
    name: 'a non-interactive execution',
    mode: 'non-interactive',
    create: (fields) => executeRun({ ...fields, mode: 'non-interactive', runner: okRunner }),
    status: 'succeeded',
    dryRun: false,
    exitCode: 0,
    stepState: 'SUCCEEDED',
  },
  {
    name: 'an interactive dry run',
    mode: 'interactive',
    create: (fields) => describePlan({ ...fields, mode: 'interactive' }),
    status: 'planned',
    dryRun: true,
    exitCode: 0,
    stepState: 'PENDING',
  },
  {
    name: 'a GUI cancellation before execution',
    mode: 'gui',
    create: (fields) => describeCancelled({ ...fields, mode: 'gui' }),
    status: 'cancelled',
    dryRun: false,
    exitCode: 6,
    stepState: 'NOT_RUN',
  },
];

describe('the result schema', () => {
  it('accepts what a real run produces — the mirror cannot drift from the model', async () => {
    const { plan, resolution, product, secrets } = setup();

    const result = await executeRun({
      plan,
      resolution,
      product,
      secrets,
      runner: okRunner,
    });

    // Through JSON, exactly as a consumer reads the file.
    expect(() => runResultSchema.parse(JSON.parse(JSON.stringify(result)))).not.toThrow();
  });

  it.each(resultCases)('accepts $name after a JSON round-trip', async (scenario) => {
    const result = await scenario.create(setup());

    expect(result.mode).toBe(scenario.mode);
    expect(result.status).toBe(scenario.status);
    expect(result.dryRun).toBe(scenario.dryRun);
    expect(result.exitCode).toBe(scenario.exitCode);
    expect(result.steps.map((step) => step.state)).toEqual([scenario.stepState]);
    expect(() => runResultSchema.parse(JSON.parse(JSON.stringify(result)))).not.toThrow();
  });

  it('emits a JSON Schema document', () => {
    const schema = resultJsonSchema();
    expect(schema['type']).toBe('object');
    expect(JSON.stringify(schema)).toContain('resultSchemaVersion');

    const properties = schema['properties'] as Readonly<
      Record<string, { readonly enum?: readonly unknown[] }>
    >;
    expect(properties['mode']?.enum).toEqual(['gui', 'interactive', 'non-interactive']);
    expect(properties['status']?.enum).toEqual([
      'succeeded',
      'planned',
      'failed',
      'cancelled',
      'config_error',
      'input_error',
      'resolution_error',
      'internal_error',
    ]);
  });
});
