import { describe, expect, it } from 'vitest';

import { manifestJsonSchema } from '../../src/manifest/index.js';
import { INPUT_ID, INPUT_TYPES, STEP_ID } from '../../src/manifest/v1/schema.js';

/**
 * `rune schema` publishes this document so editors can complete and check manifests
 * (docs/architecture.md §4.1). It is generated from the same schemas `validate` enforces,
 * so it cannot drift; what this suite pins is that it describes the *authoring* view and
 * that it is exactly as strict as validation — an editor must never say yes to a manifest
 * the CLI says no to.
 */

/** The parts of a JSON Schema node this suite reads. */
interface SchemaNode {
  readonly const?: unknown;
  readonly pattern?: string;
  readonly minItems?: number;
  readonly items?: SchemaNode;
  readonly properties?: Readonly<Record<string, SchemaNode>>;
  readonly propertyNames?: SchemaNode;
  readonly additionalProperties?: SchemaNode;
  readonly oneOf?: readonly SchemaNode[];
}

describe('manifestJsonSchema', () => {
  const schema = manifestJsonSchema();
  const properties = schema['properties'] as Readonly<Record<string, SchemaNode>>;
  const inputBranches = properties['inputs']?.additionalProperties?.oneOf ?? [];

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

  it('describes exactly the input types INPUT_TYPES names, as alternatives an editor can offer', () => {
    // Both directions at once: the published alternatives are the types the union accepts, and
    // INPUT_TYPES — public API — names exactly those, so an eighth type cannot ship alongside a
    // constant that still claims seven.
    expect(inputBranches.map((branch) => branch.properties?.['type']?.const)).toEqual([
      ...INPUT_TYPES,
    ]);
  });

  it('publishes the identifier shapes and the non-empty option list validation enforces', () => {
    // These live in the schema rather than in the semantic rules for exactly this reason: an
    // editor reading this document must reject what `rune validate` rejects.
    expect(properties['inputs']?.propertyNames?.pattern).toBe(INPUT_ID.source);
    expect(properties['steps']?.items?.properties?.['id']?.pattern).toBe(STEP_ID.source);

    const select = inputBranches.find((branch) => branch.properties?.['type']?.const === 'select');
    expect(select?.properties?.['options']?.minItems).toBe(1);
  });
});
