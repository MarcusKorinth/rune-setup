import { existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { run, type CliIo } from '../src/cli.js';

/**
 * An empty `--log-file` value would resolve to the invocation cwd and fail only at execution
 * setup as RUNE-406. It is CLI misuse, refused before a session is opened (§10, exit 2).
 */
function markerManifest(): { readonly manifestPath: string; readonly marker: string } {
  const directory = mkdtempSync(join(tmpdir(), 'rune-cli-log-file-'));
  const manifestPath = join(directory, 'installer.yaml');
  const marker = join(directory, 'ran');
  writeFileSync(
    manifestPath,
    [
      'schemaVersion: 1',
      'product:',
      '  name: Example',
      '  version: "1.0.0"',
      'steps:',
      '  - id: run',
      '    run:',
      '      command: node',
      `      args: ["-e", "require('node:fs').writeFileSync(process.argv[1], 'ran')", ${JSON.stringify(marker)}]`,
      '',
    ].join('\n'),
    'utf8',
  );
  return { manifestPath, marker };
}

function capture(): CliIo & { readonly out: string[]; readonly err: string[] } {
  const out: string[] = [];
  const err: string[] = [];
  return { out, err, stdout: (line) => out.push(line), stderr: (line) => err.push(line) };
}

describe('rune run --log-file', () => {
  it('refuses an empty path as a usage error before any session output', async () => {
    const { manifestPath, marker } = markerManifest();
    const io = capture();

    const code = await run(['run', manifestPath, '--non-interactive', '--log-file', ''], io);

    expect(code).toBe(2);
    expect(io.err).toEqual(['--log-file needs a non-empty path']);
    expect(io.out).toEqual([]);
    expect(existsSync(marker)).toBe(false);
  });

  it('refuses an empty path for a dry run as well', async () => {
    const { manifestPath } = markerManifest();
    const io = capture();

    expect(await run(['run', manifestPath, '--dry-run', '--log-file', ''], io)).toBe(2);
    expect(io.err).toEqual(['--log-file needs a non-empty path']);
    expect(io.out).toEqual([]);
  });
});
