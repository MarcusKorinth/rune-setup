import { describe, expect, it } from 'vitest';

import { createRuntimeContext, hostPlatform } from '../../src/engine/context.js';
import { executeRun } from '../../src/engine/executor.js';
import { resolveInputs } from '../../src/engine/inputs.js';
import { buildPlan } from '../../src/engine/plan.js';
import { SecretRegistry } from '../../src/engine/secrets.js';
import { parseManifestText } from '../../src/manifest/index.js';
import { resultJsonSchema, runResultSchema } from '../../src/results/schema.js';

describe('the result schema', () => {
  it('accepts what a real run produces — the mirror cannot drift from the model', async () => {
    const manifest = parseManifestText(
      [
        'schemaVersion: 1',
        'product:',
        '  name: Example',
        '  version: "1.0.0"',
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

    const result = await executeRun({
      plan,
      resolution,
      product: manifest.product,
      secrets,
      runner: { run: async () => ({ kind: 'exited', exitCode: 0 }) },
    });

    // Through JSON, exactly as a consumer reads the file.
    expect(() => runResultSchema.parse(JSON.parse(JSON.stringify(result)))).not.toThrow();
  });

  it('emits a JSON Schema document', () => {
    const schema = resultJsonSchema();
    expect(schema['type']).toBe('object');
    expect(JSON.stringify(schema)).toContain('resultSchemaVersion');
  });
});
