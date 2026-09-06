import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { run, type CliIo } from '../src/cli.js';

/**
 * §4.1: for a real run a non-stdout `--result` destination must differ from the effective
 * log-file destination, and each half is refused as soon as its anchored path is knowable.
 * The flag half is an argument-level fact, so it is refused before the session opens; the
 * manifest half is refused inside `Session.open`, as soon as the manifest parses. Neither may
 * wait for the rest of opening or for planning — a run that fails there would otherwise deliver
 * its failure result onto the file the operator named as the log, destroying whatever it held.
 *
 * Each open-failure case below therefore runs twice: once against another destination, to pin
 * that the invocation really does fail inside `open` and with which exit code, and once against
 * the log itself, which must be the usage error instead.
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

/** A second input whose declared options let a supplied value be refused while open resolves. */
const SELECT_INPUT: readonly string[] = [
  '  tool:',
  '    type: select',
  '    options: [git, docker]',
];

interface ManifestOptions {
  readonly logFile?: string | undefined;
  readonly extraStepKey?: string | undefined;
  readonly extraInputs?: readonly string[] | undefined;
}

/** A manifest with one required input, so planning fails unless the value is supplied. */
function fixture(directory: string, extraStepKey?: string): string {
  return writeManifest(join(directory, 'installer.yaml'), { extraStepKey });
}

/** The same manifest, declaring its own log file the way an operator configures one. */
function logFileFixture(
  directory: string,
  logFile: string,
  extraInputs?: readonly string[],
): string {
  return writeManifest(join(directory, 'installer.yaml'), { logFile, extraInputs });
}

function writeManifest(manifest: string, options: ManifestOptions): string {
  writeFileSync(
    manifest,
    [
      'schemaVersion: 1',
      'product:',
      '  name: Example',
      '  version: "1.0.0"',
      ...(options.logFile === undefined ? [] : ['execution:', `  logFile: ${options.logFile}`]),
      'inputs:',
      '  needed:',
      '    type: text',
      ...(options.extraInputs ?? []),
      'steps:',
      '  - id: hello',
      ...(options.extraStepKey === undefined ? [] : [`    ${options.extraStepKey}: 1`]),
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

describe("a --result destination colliding with the manifest's execution.logFile", () => {
  it.each([
    { name: 'a run that would plan successfully', argv: ['--set', 'needed=x'] },
    { name: 'a run whose required input is missing', argv: [] },
  ])('is a usage error before anything is written for $name', async ({ argv }) => {
    const directory = mkdtempSync(join(tmpdir(), 'rune-cli-manifest-collision-'));
    const manifest = logFileFixture(directory, 'run.log');
    const shared = join(directory, 'run.log');
    writeFileSync(shared, PRESERVED, 'utf8');
    const io = capture();

    // Without the check at open this exits 4 for the missing input and replaces the log with
    // the failure result: `writeResult` renames over the destination.
    const code = await run(['run', manifest, '--non-interactive', ...argv, '--result', shared], io);

    expect(code).toBe(2);
    expect(io.out).toEqual([]);
    expect(io.err).toContain(COLLISION);
    expect(readFileSync(shared, 'utf8')).toBe(PRESERVED);
  });

  it.each([
    { name: 'a --set value the input type refuses', argv: () => ['--set', 'tool=podman'] },
    { name: 'an unknown --set key', argv: () => ['--set', 'nosuch=1'] },
    {
      name: 'a missing --values file',
      argv: (directory: string) => ['--values', join(directory, 'nosuch.yaml')],
    },
  ])('is a usage error when open fails on $name', async ({ argv }) => {
    const directory = mkdtempSync(join(tmpdir(), 'rune-cli-open-collision-'));
    const manifest = logFileFixture(directory, 'run.log', SELECT_INPUT);
    const shared = join(directory, 'run.log');
    const invocation = [
      'run',
      manifest,
      '--non-interactive',
      '--set',
      'needed=x',
      '--set',
      'tool=git',
      ...argv(directory),
    ];
    const elsewhere = capture();

    // The failure is inside Session.open, so a check after open returned could never see it:
    // before the fix each of these exited 4 and replaced the log with the failure result.
    expect(
      await run([...invocation, '--result', join(directory, 'elsewhere.json')], elsewhere),
    ).toBe(4);

    writeFileSync(shared, PRESERVED, 'utf8');
    const io = capture();

    expect(await run([...invocation, '--result', shared], io)).toBe(2);
    expect(io.out).toEqual([]);
    expect(io.err).toContain(COLLISION);
    expect(readFileSync(shared, 'utf8')).toBe(PRESERVED);
  });

  it('is a usage error when a duplicate locale overlay stops open', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'rune-cli-overlay-collision-'));
    const manifest = logFileFixture(directory, 'run.log');
    mkdirSync(join(directory, 'locales'));
    // Two files claiming one locale: overlay names are normalized, so both claim `de-DE`
    // (RUNE-104). Discovery runs inside open, after the manifest has parsed.
    for (const name of ['de-DE.yaml', 'de_DE.yaml']) {
      writeFileSync(join(directory, 'locales', name), 'steps.hello.title: Hallo\n', 'utf8');
    }
    const shared = join(directory, 'run.log');
    const invocation = [
      'run',
      manifest,
      '--non-interactive',
      '--set',
      'needed=x',
      '--locale',
      'de-DE',
    ];
    const elsewhere = capture();

    expect(
      await run([...invocation, '--result', join(directory, 'elsewhere.json')], elsewhere),
    ).toBe(3);

    writeFileSync(shared, PRESERVED, 'utf8');
    const io = capture();

    expect(await run([...invocation, '--result', shared], io)).toBe(2);
    expect(io.err).toContain(COLLISION);
    expect(readFileSync(shared, 'utf8')).toBe(PRESERVED);
  });

  it('compares the path the engine anchored, not the spelling', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'rune-cli-manifest-anchored-'));
    mkdirSync(join(directory, 'sub'));
    // §10 anchors a manifest-relative logFile to the manifest's directory, so this names
    // <directory>/sub/run.log and the identically spelled --result below is a different file.
    const manifest = logFileFixture(join(directory, 'sub'), 'run.log');
    const result = join(directory, 'run.log');
    const io = capture();

    const code = await run(
      ['run', manifest, '--non-interactive', '--set', 'needed=x', '--result', result],
      io,
    );

    expect(code).toBe(0);
    expect(io.err).not.toContain(COLLISION);
    expect(readFileSync(result, 'utf8')).toContain('"resultSchemaVersion": 2');
  });
});
