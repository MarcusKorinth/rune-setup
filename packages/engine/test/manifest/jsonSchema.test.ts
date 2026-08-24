import { describe, expect, it } from 'vitest';

import { manifestJsonSchema } from '../../src/manifest/index.js';

/**
 * `rune schema` publishes this document so editors can complete and check manifests
 * (docs/architecture.md §4.1). It is generated from the same schemas `validate` enforces,
 * so it cannot drift; what this suite pins is that it describes the *authoring* view.
 */
describe('manifestJsonSchema', () => {
  const schema = manifestJsonSchema();
  const properties = schema['properties'] as Record<string, Record<string, unknown>>;

  it('is a JSON Schema describing the manifest mapping', () => {
    expect(schema['$schema']).toMatch(/json-schema\.org/);
    expect(schema['type']).toBe('object');
    expect(schema['additionalProperties']).toBe(false);
    expect(Object.keys(properties).sort()).toEqual([
      'execution',
      'gui',
      'inputs',
      'product',
      'schemaVersion',
      'steps',
    ]);
  });

  it('requires only what an author must actually write', () => {
    // `inputs` and `execution` have defaults, so the authoring view keeps them optional.
    expect(schema['required']).toEqual(['schemaVersion', 'product', 'steps']);
  });

  it('pins the schema version it describes', () => {
    expect(properties['schemaVersion']).toMatchObject({ const: 1 });
  });

  it('describes the seven input types as alternatives an editor can offer', () => {
    const inputs = properties['inputs'] as { additionalProperties?: { oneOf?: unknown[] } };
    expect(inputs.additionalProperties?.oneOf).toHaveLength(7);
  });
});
