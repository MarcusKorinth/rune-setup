import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { run, type CliIo } from '../src/cli.js';

/**
 * §4.1: for a real run a non-stdout `--result` destination must differ from the effective
 * log-file destination. The flag half is an argument-level fact, so it is refused before the
 * session opens — otherwise a run that fails while opening or planning delivers its failure
 * result onto the file the operator named as the log, destroying whatever it held.
 */

interface Capture extends CliIo {
  readonly out: string[];
  readonly err: string[];
}

function capture(): Capture {
  const out: string[] = [];
  const err: string[] = [];
  return { out, err, stdout: (line) => out.push(line), stderr: (line) => err.push(line) };
}

const PRESERVED = 'PRE-EXISTING LOG';
const COLLISION = '--result and the effective log file must use different paths for a real run';

/** A manifest with one required input, so planning fails unless the value is supplied. */
function fixture(directory: string, extraStepKey?: string): string {
  const manifest = join(directory, 'installer.yaml');
  writeFileSync(
    manifest,
    [
      'schemaVersion: 1',
      'product:',
      '  name: Example',
      '  version: "1.0.0"',
      'inputs:',
      '  needed:',
      '    type: text',
      'steps:',
      '  - id: hello',
      ...(extraStepKey === undefined ? [] : [`    ${extraStepKey}: 1`]),
      '    run:',
      '      command: node',
      '      args: ["-e", "0"]',
    ].join('\n'),
    'utf8',
  );
  return manifest;
}

describe('a --result destination colliding with the --log-file flag', () => {
  it.each([
    { name: 'a run that would plan successfully', argv: ['--set', 'needed=x'], preserved: true },
    { name: 'a run whose required input is missing', argv: [], preserved: true },
  ])('is a usage error before anything is written for $name', async ({ argv, preserved }) => {
    const directory = mkdtempSync(join(tmpdir(), 'rune-cli-collision-'));
    const manifest = fixture(directory);
    const shared = join(directory, 'run.log');
    writeFileSync(shared, PRESERVED, 'utf8');
    const io = capture();

    const code = await run(
      ['run', manifest, '--non-interactive', ...argv, '--result', shared, '--log-file', shared],
      io,
    );

    expect(code).toBe(2);
    expect(io.out).toEqual([]);
    expect(io.err).toContain(COLLISION);
    // The usage error is refused before either sink opens, so the file is untouched (§10:
    // a usage error writes no result file).
    expect(readFileSync(shared, 'utf8')).toBe(preserved ? PRESERVED : '');
  });

  it('is refused before an invalid manifest can be reported', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'rune-cli-collision-invalid-'));
    const manifest = fixture(directory, 'nosuchkey');
    const shared = join(directory, 'run.log');
    writeFileSync(shared, PRESERVED, 'utf8');
    const io = capture();

    // Without the invocation-level check this exits 3 and overwrites the log with the
    // config_error result, because the manifest never parses and no plan ever exists.
    expect(
      await run(
        ['run', manifest, '--non-interactive', '--result', shared, '--log-file', shared],
        io,
      ),
    ).toBe(2);

    expect(io.err).toContain(COLLISION);
    expect(readFileSync(shared, 'utf8')).toBe(PRESERVED);
  });

  it('leaves a dry run and a stdout result alone', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'rune-cli-collision-allowed-'));
    const manifest = fixture(directory);
    const shared = join(directory, 'run.log');
    const dry = capture();
    const stdout = capture();

    // §4.1: dry-run may write its result to the configured log path because it never opens
    // the log, and `--result -` remains valid.
    expect(
      await run(
        [
          'run',
          manifest,
          '--non-interactive',
          '--set',
          'needed=x',
          '--dry-run',
          '--result',
          shared,
          '--log-file',
          shared,
        ],
        dry,
      ),
    ).toBe(0);
    expect(
      await run(
        [
          'run',
          manifest,
          '--non-interactive',
          '--set',
          'needed=x',
          '--result',
          '-',
          '--log-file',
          shared,
        ],
        stdout,
      ),
    ).toBe(0);

    expect(dry.err).not.toContain(COLLISION);
    expect(stdout.err).not.toContain(COLLISION);
  });
});
