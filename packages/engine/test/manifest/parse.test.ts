import { describe, expect, it } from 'vitest';

import type { ManifestError } from '../../src/errors.js';
import { parseManifestText, SUPPORTED_SCHEMA_VERSIONS } from '../../src/manifest/index.js';
import { isCommandSpec, optionLabel, optionValue } from '../../src/manifest/v1/schema.js';

const HEAD = ['schemaVersion: 1', 'product:', '  name: Example', '  version: 1.0.0'];
const MINIMAL = [...HEAD, 'steps: []', ''].join('\n');

function parse(text: string) {
  return parseManifestText(text, 'installer.yaml');
}

describe('parseManifestText', () => {
  it('accepts a minimal manifest and applies the documented defaults', () => {
    const manifest = parse(MINIMAL);

    expect(manifest.schemaVersion).toBe(1);
    expect(manifest.product).toEqual({ name: 'Example', version: '1.0.0' });
    expect(manifest.inputs).toEqual({});
    expect(manifest.steps).toEqual([]);
    expect(manifest.execution.failFast).toBe(true);
    expect(manifest.gui).toBeUndefined();
  });

  it('fills in command defaults so the planner never sees a half-specified command', () => {
    const manifest = parse(
      [...HEAD, 'steps:', '  - id: install', '    run:', '      command: pwsh', ''].join('\n'),
    );

    const step = manifest.steps[0];
    expect(step?.id).toBe('install');
    expect(step && isCommandSpec(step.run) && step.run).toMatchObject({
      command: 'pwsh',
      args: [],
      env: {},
      timeoutSeconds: null,
      successExitCodes: [0],
    });
  });

  it('accepts both run forms: one command, or a mapping of platforms', () => {
    const manifest = parse(
      [
        'schemaVersion: 1',
        'product:',
        '  name: Example',
        '  version: 1.0.0',
        'steps:',
        '  - id: everywhere',
        '    run:',
        '      command: node',
        '      args: [--version]',
        '  - id: per-platform',
        '    run:',
        '      windows:',
        '        command: pwsh',
        '      linux:',
        '        command: bash',
        '',
      ].join('\n'),
    );

    const [everywhere, perPlatform] = manifest.steps;
    expect(everywhere && isCommandSpec(everywhere.run)).toBe(true);
    expect(perPlatform && isCommandSpec(perPlatform.run)).toBe(false);
    expect(perPlatform && !isCommandSpec(perPlatform.run) && perPlatform.run.windows?.command).toBe(
      'pwsh',
    );
  });

  it('defaults inputs to required and keeps their declaration order', () => {
    const manifest = parse(
      [
        'schemaVersion: 1',
        'product:',
        '  name: Example',
        '  version: 1.0.0',
        'inputs:',
        '  zulu:',
        '    type: text',
        '  alpha:',
        '    type: boolean',
        '    required: false',
        '  mike:',
        '    type: secret',
        'steps: []',
        '',
      ].join('\n'),
    );

    // Declaration order is evaluation and prompting order (docs/architecture.md §4.2).
    expect(Object.keys(manifest.inputs)).toEqual(['zulu', 'alpha', 'mike']);
    expect(manifest.inputs['zulu']?.required).toBe(true);
    expect(manifest.inputs['alpha']?.required).toBe(false);
  });

  it('keeps option labels and values apart', () => {
    const manifest = parse(
      [
        'schemaVersion: 1',
        'product:',
        '  name: Example',
        '  version: 1.0.0',
        'inputs:',
        '  environment:',
        '    type: select',
        '    options:',
        '      - development',
        '      - value: production',
        '        label: Produktivumgebung',
        '    default: production',
        'steps: []',
        '',
      ].join('\n'),
    );

    const input = manifest.inputs['environment'];
    expect(input?.type).toBe('select');
    expect(input && 'options' in input && input.options).toEqual([
      'development',
      { value: 'production', label: 'Produktivumgebung' },
    ]);
  });

  it('reads the value and the label of an option the way every frontend must', () => {
    expect(optionValue('development')).toBe('development');
    expect(optionLabel('development')).toBe('development');
    expect(optionValue({ value: 'production', label: 'Produktivumgebung' })).toBe('production');
    expect(optionLabel({ value: 'production', label: 'Produktivumgebung' })).toBe(
      'Produktivumgebung',
    );
  });

  it('hands out a manifest that cannot be changed under another reader', () => {
    const manifest = parse(MINIMAL);

    expect(Object.isFrozen(manifest)).toBe(true);
    expect(Object.isFrozen(manifest.product)).toBe(true);
    expect(Object.isFrozen(manifest.steps)).toBe(true);
  });
});

describe('schemaVersion dispatch', () => {
  it('supports exactly the documented versions', () => {
    expect(SUPPORTED_SCHEMA_VERSIONS).toEqual([1]);
  });

  it('requires schemaVersion before anything else is validated', () => {
    let thrown: unknown;
    try {
      parse('product:\n  name: Example\n');
    } catch (error) {
      thrown = error;
    }

    expect((thrown as ManifestError).code).toBe('RUNE-102');
    expect((thrown as ManifestError).message).toMatch(/schemaVersion is required \(supported: 1\)/);
  });

  it('rejects a non-integer schemaVersion', () => {
    expect(() => parse('schemaVersion: "1"\n')).toThrow(/schemaVersion must be an integer/);
  });

  it('points a future schemaVersion at an upgrade instead of a wall of schema errors', () => {
    let thrown: unknown;
    try {
      parse('schemaVersion: 2\nnewKeyFromTheFuture: true\n');
    } catch (error) {
      thrown = error;
    }

    const error = thrown as ManifestError;
    expect(error.code).toBe('RUNE-102');
    expect(error.message).toMatch(/schemaVersion 2 is not supported/);
    expect(error.message).toMatch(/upgrade RUNE/);
    expect(error.issues).toHaveLength(1);
    expect(error.issues[0]?.location).toMatchObject({ line: 1, column: 1 });
  });

  it('rejects documents that are not a mapping', () => {
    expect(() => parse('- a\n- b\n')).toThrow(/must contain a mapping at the top level/);
    expect(() => parse('')).toThrow(/is empty/);
  });
});
