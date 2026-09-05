import { mkdtempSync, writeFileSync } from 'node:fs';
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

function manifest(): string {
  const directory = mkdtempSync(join(tmpdir(), 'rune-cli-empty-flag-'));
  const path = join(directory, 'installer.yaml');
  const lines = [
    'schemaVersion: 1',
    'product:',
    '  name: Example',
    '  version: "1.0.0"',
    'steps: []',
    '',
  ];
  writeFileSync(path, lines.join('\n'), 'utf8');
  return path;
}

describe('empty flag values', () => {
  it('rejects an empty --values path with a usage error naming the flag', async () => {
    const io = capture();

    const code = await run(['run', manifest(), '--non-interactive', '--values', ''], io);

    expect(code).toBe(2);
    expect(io.err).toEqual(['--values needs a non-empty path']);
    expect(io.out).toEqual([]);
  });

  it('rejects an empty --values path among named ones', async () => {
    const io = capture();
    const path = manifest();

    const code = await run(
      ['run', path, '--non-interactive', '--values', 'overlay.yaml', '--values', ''],
      io,
    );

    expect(code).toBe(2);
    expect(io.err).toEqual(['--values needs a non-empty path']);
    expect(io.out).toEqual([]);
  });

  it('keeps rejecting an empty --set pair as the malformed pair it is', async () => {
    const io = capture();

    const code = await run(['run', manifest(), '--non-interactive', '--set', ''], io);

    expect(code).toBe(2);
    expect(io.err).toEqual(['--set expects key=value']);
    expect(io.out).toEqual([]);
  });

  it('keeps reading an empty --locale as no locale at all', async () => {
    const io = capture();

    const code = await run(['run', manifest(), '--non-interactive', '--locale', ''], io);

    expect(code).toBe(0);
    expect(io.err.join('\n')).not.toContain('--locale');
    expect(io.out).toEqual([]);
  });
});
