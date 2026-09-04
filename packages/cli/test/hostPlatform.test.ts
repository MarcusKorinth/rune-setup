import { existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

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

function fixture(): string {
  const dir = mkdtempSync(join(tmpdir(), 'rune-cli-host-'));
  const path = join(dir, 'installer.yaml');
  writeFileSync(
    path,
    [
      'schemaVersion: 1',
      'product:',
      '  name: Example',
      '  version: "1.0.0"',
      'steps:',
      '  - id: hello',
      '    run:',
      '      command: node',
      '      args: ["-e", "process.exit(0)"]',
      '',
    ].join('\n'),
    'utf8',
  );
  return path;
}

// The engine reads process.platform when a session opens (hostPlatform()), so an unsupported
// host is simulated by redefining the property for one test and restoring it afterwards.
const platformDescriptor = Object.getOwnPropertyDescriptor(process, 'platform')!;

function stubHostPlatform(platform: NodeJS.Platform): void {
  Object.defineProperty(process, 'platform', { ...platformDescriptor, value: platform });
}

afterEach(() => {
  Object.defineProperty(process, 'platform', platformDescriptor);
});

const UNSUPPORTED_HOST_DIAGNOSTIC =
  'host platform "darwin" is not supported; supported Node platforms are win32 and linux';

describe('rune on an unsupported host platform', () => {
  it('exits 2 with the RUNE-002 diagnostic and writes no result file for rune run', async () => {
    const path = fixture();
    const resultPath = join(path, '..', 'result.json');
    const io = capture();
    stubHostPlatform('darwin');

    const code = await run(['run', path, '--non-interactive', '--result', resultPath], io);

    expect(code).toBe(2);
    expect(io.err).toEqual([UNSUPPORTED_HOST_DIAGNOSTIC]);
    expect(io.out).toEqual([]);
    expect(existsSync(resultPath)).toBe(false);
  });

  it('delivers no result on stdout for a dry-run preview of a supported platform either', async () => {
    const path = fixture();
    const io = capture();
    stubHostPlatform('darwin');

    const code = await run(
      ['run', path, '--dry-run', '--non-interactive', '--platform', 'linux', '--result', '-'],
      io,
    );

    expect(code).toBe(2);
    expect(io.err).toEqual([UNSUPPORTED_HOST_DIAGNOSTIC]);
    expect(io.out).toEqual([]);
  });

  it('still validates a manifest, because validate performs stages 1-2 without a host', async () => {
    const path = fixture();
    const io = capture();
    stubHostPlatform('darwin');

    expect(await run(['validate', path], io)).toBe(0);

    expect(io.out[0]).toContain('is valid (schemaVersion 1, product Example 1.0.0)');
    expect(io.err).toEqual([]);
  });

  it('still prints the manifest schema, which does not depend on the host', async () => {
    const io = capture();
    stubHostPlatform('darwin');

    expect(await run(['schema'], io)).toBe(0);

    expect(JSON.parse(io.out.join('\n'))).toMatchObject({ type: 'object' });
    expect(io.err).toEqual([]);
  });
});
