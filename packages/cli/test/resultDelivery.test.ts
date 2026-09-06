import { existsSync, mkdirSync, mkdtempSync, readdirSync, writeFileSync } from 'node:fs';
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

const MANIFEST = [
  'schemaVersion: 1',
  'product:',
  '  name: Example',
  '  version: "1.0.0"',
  'inputs:',
  '  greeting:',
  '    type: text',
  'steps:',
  '  - id: hello',
  '    run:',
  '      command: node',
  '      args: ["-e", "console.log(process.argv[1])", "${greeting}"]',
];

function fixture(): { readonly directory: string; readonly manifestPath: string } {
  const directory = mkdtempSync(join(tmpdir(), 'rune-cli-result-delivery-'));
  const manifestPath = join(directory, 'installer.yaml');
  writeFileSync(manifestPath, [...MANIFEST, ''].join('\n'), 'utf8');
  return { directory, manifestPath };
}

function temporaryFiles(directory: string): string[] {
  return readdirSync(directory).filter(
    (name) => name.startsWith('.rune-result-') && name.endsWith('.tmp'),
  );
}

/** Node's system-error text: `<CODE>: <description>, <syscall> '<path>'`. */
const RAW_OS_MESSAGE = /\bE[A-Z]+: |, (?:rename|mkdir|open|write|close) '/u;

/** RUNE-407 names the destination and a fixed errno-derived reason (docs/architecture.md §10). */
function expectDeliveryDiagnostic(io: Capture, action: string, destination: string): void {
  const stderr = io.err.join('\n');
  expect(io.err.at(-1)).toMatch(
    new RegExp(`^could not ${action} result file "[^"]+": [a-z ]+ [(]E[A-Z]+[)]$`, 'u'),
  );
  expect(io.err.at(-1)).toContain(`"${destination}"`);
  expect(stderr).not.toMatch(RAW_OS_MESSAGE);
  expect(stderr).not.toContain('internal error');
  expect(stderr).not.toContain('.rune-result-');
}

describe('result-file delivery failures', () => {
  it('exits 1 with a RUNE-407 diagnostic when --result names an existing directory', async () => {
    const { directory, manifestPath } = fixture();
    const destination = join(directory, 'out');
    mkdirSync(destination);
    const io = capture();

    const code = await run(
      ['run', manifestPath, '--non-interactive', '--set', 'greeting=hi', '--result', destination],
      io,
    );

    expect(code).toBe(1);
    expect(io.err.join('\n')).toContain('SUCCEEDED');
    expectDeliveryDiagnostic(io, 'finalize', destination);
    expect(io.out).toEqual([]);
    expect(readdirSync(destination)).toEqual([]);
    expect(temporaryFiles(directory)).toEqual([]);
  });

  it('exits 1 with a RUNE-407 diagnostic when the parent of --result is a regular file', async () => {
    const { directory, manifestPath } = fixture();
    const blocker = join(directory, 'blocker');
    const destination = join(blocker, 'result.json');
    writeFileSync(blocker, 'occupied', 'utf8');
    const io = capture();

    const code = await run(
      ['run', manifestPath, '--non-interactive', '--set', 'greeting=hi', '--result', destination],
      io,
    );

    expect(code).toBe(1);
    expect(io.err.join('\n')).toContain('SUCCEEDED');
    expectDeliveryDiagnostic(io, 'prepare the directory for', destination);
    expect(io.out).toEqual([]);
    expect(existsSync(destination)).toBe(false);
    expect(temporaryFiles(directory)).toEqual([]);
  });

  it('reports a dry-run delivery failure the same way after the plan', async () => {
    const { directory, manifestPath } = fixture();
    const destination = join(directory, 'out');
    mkdirSync(destination);
    const io = capture();

    const code = await run(
      [
        'run',
        manifestPath,
        '--dry-run',
        '--non-interactive',
        '--set',
        'greeting=hi',
        '--result',
        destination,
      ],
      io,
    );

    expect(code).toBe(1);
    expect(io.out.join('\n')).toContain('Execution plan');
    expectDeliveryDiagnostic(io, 'finalize', destination);
    expect(io.err.join('\n')).not.toContain('planned:');
    expect(readdirSync(destination)).toEqual([]);
    expect(temporaryFiles(directory)).toEqual([]);
  });
});
