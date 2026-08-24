import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { ManifestError } from '../../src/errors.js';
import { loadYamlFile, loadYamlText, MAX_DOCUMENT_BYTES } from '../../src/manifest/loader.js';

function tempFile(name: string, contents: Buffer | string): string {
  const dir = mkdtempSync(join(tmpdir(), 'rune-loader-'));
  const path = join(dir, name);
  writeFileSync(path, contents);
  return path;
}

describe('loadYamlText', () => {
  it('parses plain YAML into plain data', () => {
    const { value } = loadYamlText('a: 1\nb: [x, y]\nc: { d: true }\n', 'f.yaml');

    expect(value).toEqual({ a: 1, b: ['x', 'y'], c: { d: true } });
  });

  it('reports a syntax error with its position', () => {
    let thrown: unknown;
    try {
      loadYamlText('product:\n\tname: Example\n', 'f.yaml');
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(ManifestError);
    const error = thrown as ManifestError;
    expect(error.code).toBe('RUNE-101');
    expect(error.issues[0]?.location).toMatchObject({ file: 'f.yaml', line: 2 });
    expect(error.message).toMatch(/f\.yaml:2:\d+: .*[Tt]ab/);
  });

  it('rejects duplicate keys instead of silently keeping the last one', () => {
    let thrown: unknown;
    try {
      loadYamlText('a: 1\nb: 2\na: 3\n', 'f.yaml');
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(ManifestError);
    const error = thrown as ManifestError;
    expect(error.code).toBe('RUNE-101');
    expect(error.issues[0]).toMatchObject({
      message: 'duplicate key "a" — first defined at f.yaml:1:1',
      location: { file: 'f.yaml', line: 3, column: 1 },
    });
  });

  it('detects duplicates in nested mappings too', () => {
    expect(() => loadYamlText('product:\n  name: A\n  name: B\n', 'f.yaml')).toThrow(
      /duplicate key "name"/,
    );
  });

  it('parses a large flat mapping without a quadratic slowdown', () => {
    const lines = Array.from({ length: 20_000 }, (_unused, index) => `key${index}: value`);
    const started = Date.now();

    loadYamlText(`${lines.join('\n')}\n`, 'big.yaml');

    // The size cap alone would not bound the cost if duplicate detection scanned every key
    // for every key: that shape used to take tens of seconds at a megabyte.
    expect(Date.now() - started).toBeLessThan(5_000);
  });

  it('does not execute custom tags', () => {
    expect(() => loadYamlText('a: !!js/function "function () {}"\n', 'f.yaml')).toThrow(
      /[Uu]nresolved tag/,
    );
  });

  it('reads plain YAML only: tagged types stay unresolved rather than becoming objects', () => {
    // Without this guard these resolve to a Buffer, a Date and a merged mapping even under
    // the core schema — values a manifest author never wrote.
    expect(() => loadYamlText('a: !!binary aGk=\n', 'f.yaml')).toThrow(/[Uu]nresolved tag/);
    expect(() => loadYamlText('a: !!timestamp 2020-01-01\n', 'f.yaml')).toThrow(
      /[Uu]nresolved tag/,
    );
  });

  it('does not merge mappings: a << key stays an ordinary key the schema then rejects', () => {
    const { value } = loadYamlText('base: &b { x: 1 }\nd:\n  <<: *b\n', 'f.yaml');

    expect(value).toEqual({ base: { x: 1 }, d: { '<<': { x: 1 } } });
  });

  it('caps alias expansion so a small document cannot explode', () => {
    const bomb = [
      'a: &a ["x","x","x","x","x","x","x","x","x"]',
      'b: &b [*a,*a,*a,*a,*a,*a,*a,*a,*a]',
      'c: &c [*b,*b,*b,*b,*b,*b,*b,*b,*b]',
      'd: [*c,*c,*c,*c,*c,*c,*c,*c,*c]',
      '',
    ].join('\n');

    let thrown: unknown;
    try {
      loadYamlText(bomb, 'f.yaml');
    } catch (error) {
      thrown = error;
    }

    expect((thrown as ManifestError).code).toBe('RUNE-101');
    expect((thrown as ManifestError).message).toMatch(/f\.yaml: .*alias/i);
  });

  it('rejects a __proto__ key instead of letting the entry disappear', () => {
    let thrown: unknown;
    try {
      loadYamlText('inputs:\n  __proto__:\n    type: text\n', 'f.yaml');
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(ManifestError);
    const error = thrown as ManifestError;
    expect(error.code).toBe('RUNE-101');
    expect(error.issues[0]).toMatchObject({
      message: '__proto__ is not allowed as a key',
      location: { file: 'f.yaml', line: 2, column: 3 },
    });
  });

  it('does not pollute Object.prototype through document keys', () => {
    expect(() => loadYamlText('__proto__:\n  polluted: true\n', 'f.yaml')).toThrow(ManifestError);
    expect(({} as Record<string, unknown>)['polluted']).toBeUndefined();
  });

  it('rejects a stream of several documents rather than silently taking the first', () => {
    expect(() => loadYamlText('a: 1\n---\nb: 2\n', 'f.yaml')).toThrow(ManifestError);
  });

  it('returns null for an empty document', () => {
    expect(loadYamlText('', 'f.yaml').value).toBeNull();
    expect(loadYamlText('# just a comment\n', 'f.yaml').value).toBeNull();
  });
});

describe('source map', () => {
  const document = loadYamlText(
    ['product:', '  name: Example', 'steps:', '  - id: install', '    title: Install', ''].join(
      '\n',
    ),
    'installer.yaml',
  );

  it('locates mapping keys and their values separately', () => {
    expect(document.sourceMap.keyLocation(['product', 'name'])).toEqual({
      file: 'installer.yaml',
      line: 2,
      column: 3,
    });
    expect(document.sourceMap.location(['product', 'name'])).toEqual({
      file: 'installer.yaml',
      line: 2,
      column: 9,
    });
  });

  it('locates sequence items by index', () => {
    expect(document.sourceMap.location(['steps', 0])).toMatchObject({ line: 4, column: 5 });
    expect(document.sourceMap.keyLocation(['steps', 0, 'title'])).toMatchObject({
      line: 5,
      column: 5,
    });
  });

  it('falls back to the closest ancestor for paths that are not in the document', () => {
    expect(document.sourceMap.location(['steps', 0, 'run'])).toBeUndefined();
    expect(document.sourceMap.best(['steps', 0, 'run', 'windows'])).toMatchObject({
      line: 4,
      column: 5,
    });
  });

  it('keeps sibling paths distinct even when a key contains a dot', () => {
    const dotted = loadYamlText('inputs:\n  "a.b": 1\n  a:\n    b: 2\n', 'f.yaml');

    expect(dotted.sourceMap.location(['inputs', 'a.b'])).toMatchObject({ line: 2, column: 10 });
    expect(dotted.sourceMap.location(['inputs', 'a', 'b'])).toMatchObject({ line: 4, column: 8 });
  });
});

describe('loadYamlFile', () => {
  it('reads a file from disk', () => {
    const path = tempFile('installer.yaml', 'a: 1\n');

    expect(loadYamlFile(path).value).toEqual({ a: 1 });
  });

  it('strips a byte-order mark', () => {
    const path = tempFile('bom.yaml', Buffer.from('\uFEFFa: 1\n', 'utf8'));

    expect(loadYamlFile(path).value).toEqual({ a: 1 });
  });

  it('refuses input that is not valid UTF-8 instead of substituting characters', () => {
    const path = tempFile('latin1.yaml', Buffer.from([0x61, 0x3a, 0x20, 0xff, 0x0a]));

    expect(() => loadYamlFile(path)).toThrow(/not valid UTF-8/);
  });

  it('refuses a file above the size cap', () => {
    const path = tempFile('huge.yaml', 'a: 1\n'.padEnd(MAX_DOCUMENT_BYTES + 1, ' '));

    expect(() => loadYamlFile(path)).toThrow(/larger than/);
  });

  it('refuses a path that is not a file', () => {
    const path = tempFile('installer.yaml', 'a: 1\n');
    const directory = join(path, '..');

    expect(() => loadYamlFile(directory)).toThrow(/is not a file/);
  });

  it('reports a missing file as a manifest error', () => {
    let thrown: unknown;
    try {
      loadYamlFile('does-not-exist.yaml');
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(ManifestError);
    expect((thrown as ManifestError).code).toBe('RUNE-101');
    expect((thrown as ManifestError).message).toMatch(/cannot be read/);
  });

  it('reports the display name the caller passed, not the path on disk', () => {
    const path = tempFile('installer.yaml', 'a: [1,\n');

    expect(() => loadYamlFile('installer.yaml', path)).toThrow(/installer\.yaml:/);
  });
});
