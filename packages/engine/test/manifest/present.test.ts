import { describe, expect, it } from 'vitest';

import type { ManifestError } from '../../src/errors.js';
import { parseManifestText } from '../../src/manifest/index.js';

const HEAD = ['schemaVersion: 1', 'product:', '  name: Example', '  version: "1.0.0"'];

/** The single message a manifest is rejected with, for cases that have exactly one problem. */
function messageOf(lines: readonly string[]): string {
  try {
    parseManifestText([...HEAD, ...lines, ''].join('\n'), 'installer.yaml');
  } catch (error) {
    const issues = (error as ManifestError).issues;
    expect(issues).toHaveLength(1);
    return issues[0]?.message ?? '';
  }
  throw new Error('expected the manifest to be rejected');
}

describe('type problems', () => {
  it('names the accepted input types when the type is wrong', () => {
    expect(messageOf(['inputs:', '  a:', '    type: colour', 'steps: []'])).toBe(
      'inputs.a.type must be one of: "text", "secret", "boolean", "select", "multiselect", "file", "directory"',
    );
  });

  it('names the accepted input types when the type is missing', () => {
    expect(messageOf(['inputs:', '  a:', '    title: X', 'steps: []'])).toBe(
      'inputs.a.type is required (one of: "text", "secret", "boolean", "select", "multiselect", "file", "directory")',
    );
  });

  it('speaks about mappings and lists, not about the vocabulary of the schema library', () => {
    expect(messageOf(['inputs:', '  - a', 'steps: []'])).toBe('inputs must be a mapping');
    expect(messageOf(['steps: not-a-list'])).toBe('steps must be a list');
  });

  it('offers both alternatives when a value could be either shape', () => {
    expect(
      messageOf(['inputs:', '  a:', '    type: select', '    options: [123]', 'steps: []']),
    ).toBe('inputs.a.options[0] must be a string or a mapping');
  });

  it('distinguishes a missing key from a key of the wrong type', () => {
    expect(messageOf(['steps:', '  - run:', '      command: x'])).toBe('steps[0].id is required');
    expect(messageOf(['steps:', '  - id: 7', '    run:', '      command: x'])).toBe(
      'steps[0].id must be a string',
    );
  });
});

describe('unknown keys', () => {
  it('suggests the key the author probably meant', () => {
    expect(messageOf(['steps:', '  - id: a', '    titel: A', '    run:', '      command: x'])).toBe(
      'unknown key steps[0].titel — did you mean "title"?',
    );
  });

  it('says nothing about a key that resembles nothing', () => {
    expect(
      messageOf(['steps:', '  - id: a', '    zzzzzzz: 1', '    run:', '      command: x']),
    ).toBe('unknown key steps[0].zzzzzzz');
  });

  it('explains that a reserved key belongs to a later schema version', () => {
    expect(messageOf(['license: LICENSE.txt', 'steps: []'])).toBe(
      'license is reserved; accepted in a later schemaVersion',
    );
    expect(
      messageOf(['steps:', '  - id: a', '    dependsOn: [b]', '    run:', '      command: x']),
    ).toBe('steps[0].dependsOn is reserved; accepted in a later schemaVersion');
  });

  it('refuses a shell option outright instead of reserving it', () => {
    const message = messageOf([
      'steps:',
      '  - id: a',
      '    run:',
      '      command: x',
      '      shell: false',
    ]);

    expect(message).toContain('steps[0].run.shell is not allowed');
    expect(message).toContain('argv arrays only');
  });

  it('explains why a secret carries neither a default nor a pattern', () => {
    expect(
      messageOf(['inputs:', '  token:', '    type: secret', '    default: hunter2', 'steps: []']),
    ).toContain('a secret must not be written into the manifest');
    expect(
      messageOf(['inputs:', '  token:', '    type: secret', '    pattern: ".+"', 'steps: []']),
    ).toContain('the mismatch message would describe the secret');
  });

  it('does not echo the secret it rejects', () => {
    expect(
      messageOf(['inputs:', '  token:', '    type: secret', '    default: hunter2', 'steps: []']),
    ).not.toContain('hunter2');
  });
});

describe('run blocks', () => {
  it('reports the command form when the author clearly wrote a command', () => {
    expect(
      messageOf(['steps:', '  - id: a', '    run:', '      command: x', '      args: nope']),
    ).toBe('steps[0].run.args must be a list');
  });

  it('reports the platform form when the author clearly wrote platforms', () => {
    expect(
      messageOf([
        'steps:',
        '  - id: a',
        '    run:',
        '      windows:',
        '        command: x',
        '      linnux:',
        '        command: y',
      ]),
    ).toBe('unknown key steps[0].run.linnux — did you mean "linux"?');
  });

  it('tells the author that macOS is not supported yet, by either of its names', () => {
    expect(
      messageOf(['steps:', '  - id: a', '    run:', '      macos:', '        command: x']),
    ).toBe('steps[0].run.macos is reserved; accepted in a later schemaVersion');
    expect(
      messageOf(['steps:', '  - id: a', '    run:', '      darwin:', '        command: x']),
    ).toBe('steps[0].run.darwin is reserved; accepted in a later schemaVersion');
  });
});
