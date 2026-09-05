import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';

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
  '  token:',
  '    type: secret',
  'steps: []',
];

function directoryFixture(): string {
  return mkdtempSync(join(tmpdir(), 'rune-cli-plan-masking-'));
}

/**
 * A log path carrying both characters `JSON.stringify` rewrites. On every host the absolute
 * path holds a quote, and the backslash is a separator on Windows and a literal elsewhere.
 */
function escapableLogPath(directory: string): string {
  return join(directory, 'a"b\\c-1234.log');
}

function writeManifest(directory: string, execution: readonly string[] = []): string {
  const manifestPath = join(directory, 'installer.yaml');
  writeFileSync(manifestPath, [...MANIFEST, ...execution, ''].join('\n'), 'utf8');
  return manifestPath;
}

/** The spelling the plan line used to carry: the same path after JSON escaping. */
function escapedSpelling(path: string): string {
  return JSON.stringify(path).slice(1, -1);
}

describe('dry-run plan rendering and secrets', () => {
  it('masks a --log-file path that a secret input also spells', async () => {
    const directory = directoryFixture();
    const logPath = escapableLogPath(directory);
    const manifestPath = writeManifest(directory);
    const io = capture();

    const code = await run(
      [
        'run',
        manifestPath,
        '--non-interactive',
        '--dry-run',
        '--set',
        `token=${logPath}`,
        '--log-file',
        logPath,
      ],
      io,
    );

    expect(code).toBe(0);
    const stdout = io.out.join('\n');
    expect(stdout).toContain('Execution options: failFast=true, logFile="***"');
    expect(stdout).not.toContain(logPath);
    expect(stdout).not.toContain(escapedSpelling(logPath));
    expect([...io.out, ...io.err].join('\n')).not.toContain(logPath);
  });

  it('masks an execution.logFile path that a secret input also spells', async () => {
    const directory = directoryFixture();
    const logPath = escapableLogPath(directory);
    const manifestPath = writeManifest(directory, [
      'execution:',
      `  logFile: ${JSON.stringify(logPath)}`,
    ]);
    const io = capture();

    const code = await run(
      ['run', manifestPath, '--non-interactive', '--dry-run', '--set', `token=${logPath}`],
      io,
    );

    expect(code).toBe(0);
    const stdout = io.out.join('\n');
    expect(stdout).toContain('Execution options: failFast=true, logFile="***"');
    expect(stdout).not.toContain(logPath);
    expect(stdout).not.toContain(escapedSpelling(logPath));
    expect([...io.out, ...io.err].join('\n')).not.toContain(logPath);
  });

  // The plan carries the anchored log path while the registry holds the spelling the operator
  // typed, so a preview built from the anchored one leaks whenever anchoring rewrote anything.
  it('masks a --log-file spelling that anchoring normalizes away', async () => {
    const directory = directoryFixture();
    // A "." segment is normalized away on every host, so this case is not a Windows quirk.
    const spelled = `${directory}${sep}.${sep}secret-log-1234.log`;
    const manifestPath = writeManifest(directory);
    const io = capture();

    const code = await run(
      [
        'run',
        manifestPath,
        '--non-interactive',
        '--dry-run',
        '--set',
        `token=${spelled}`,
        '--log-file',
        spelled,
      ],
      io,
    );

    expect(code).toBe(0);
    const stdout = io.out.join('\n');
    expect(stdout).toContain('Execution options: failFast=true, logFile="***"');
    expect(stdout).not.toContain(spelled);
    expect(stdout).not.toContain(resolve(spelled));
    expect([...io.out, ...io.err].join('\n')).not.toContain(spelled);
  });

  it('masks a manifest-relative execution.logFile that a secret input spells', async () => {
    const directory = directoryFixture();
    const spelled = 'logs/secret-log-1234.log';
    const manifestPath = writeManifest(directory, [
      'execution:',
      `  logFile: ${JSON.stringify(spelled)}`,
    ]);
    const io = capture();

    const code = await run(
      ['run', manifestPath, '--non-interactive', '--dry-run', '--set', `token=${spelled}`],
      io,
    );

    expect(code).toBe(0);
    const stdout = io.out.join('\n');
    expect(stdout).toContain('Execution options: failFast=true, logFile="***"');
    expect(stdout).not.toContain(spelled);
    expect(stdout).not.toContain(join(directory, 'logs', 'secret-log-1234.log'));
    expect([...io.out, ...io.err].join('\n')).not.toContain(spelled);
  });
});
