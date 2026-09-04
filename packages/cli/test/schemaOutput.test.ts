import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { run, type CliIo } from '../src/cli.js';

interface Capture extends CliIo {
  readonly out: string[];
  readonly err: string[];
}

function capture(): Capture {
  const out: string[] = [];
  const err: string[] = [];
  return { out, err, stdout: (line) => out.push(line), stderr: (line) => err.push(line) };
}

describe('rune schema --output', () => {
  it('creates the directory the output file lives in', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'rune-cli-schema-output-'));
    const output = join(directory, 'nested', 'deeper', 'schema.json');
    const io = capture();

    expect(await run(['schema', '--output', output], io)).toBe(0);

    expect(io.out).toEqual([]);
    expect(io.err).toEqual([`schema written to ${output}`]);
    expect(JSON.parse(readFileSync(output, 'utf8'))).toMatchObject({ type: 'object' });
  });

  it('reports an existing directory as a usage error naming the path and errno code', async () => {
    const output = mkdtempSync(join(tmpdir(), 'rune-cli-schema-output-'));
    const io = capture();

    expect(await run(['schema', '--result', '--output', output], io)).toBe(2);

    expect(io.out).toEqual([]);
    expect(io.err).toEqual([`cannot write --output "${output}" (EISDIR)`]);
    expect(existsSync(join(output, 'schema.json'))).toBe(false);
  });
});
