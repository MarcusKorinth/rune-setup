import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
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

function fixture(lines: readonly string[]): string {
  const dir = mkdtempSync(join(tmpdir(), 'rune-cli-'));
  const path = join(dir, 'installer.yaml');
  writeFileSync(path, [...lines, ''].join('\n'), 'utf8');
  return path;
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

describe('rune schema', () => {
  it('prints the manifest JSON Schema on stdout', async () => {
    const io = capture();
    expect(await run(['schema'], io)).toBe(0);
    const schema = JSON.parse(io.out.join('\n')) as Record<string, unknown>;
    expect(schema['type']).toBe('object');
    expect(io.err).toEqual([]);
  });

  it('prints the result schema with --result', async () => {
    const io = capture();
    expect(await run(['schema', '--result'], io)).toBe(0);
    const schema = JSON.parse(io.out.join('\n')) as {
      readonly properties: Readonly<Record<string, { readonly const?: unknown }>>;
      readonly required: readonly string[];
    };
    expect(schema.properties['resultSchemaVersion']?.const).toBe(2);
    expect(schema.required).toContain('mode');
  });
});

describe('rune validate', () => {
  it('reports a valid manifest and what it reads', async () => {
    const path = fixture(MANIFEST);
    const io = capture();
    expect(await run(['validate', path], io)).toBe(0);
    expect(io.out[0]).toContain('is valid');
    expect(io.out.join('\n')).toContain('locales: none');
  });

  it('exits 3 for an invalid manifest', async () => {
    const path = fixture(['schemaVersion: 1', 'product:', '  name: X']);
    const io = capture();
    expect(await run(['validate', path], io)).toBe(3);
    expect(io.err.join('\n')).toContain('product');
  });

  it('rejects an invalid summary token in every overlay', async () => {
    const path = fixture(MANIFEST);
    const overlayPath = join(path, '..', 'locales', 'de.yaml');
    mkdirSync(join(path, '..', 'locales'));
    writeFileSync(overlayPath, 'rune.summary.proceedToken: c\n', 'utf8');
    const io = capture();

    expect(await run(['validate', path, '--locale', 'fr'], io)).toBe(3);
    expect(io.err.join('\n')).toContain(
      `${overlayPath}:1:1: rune.summary.proceedToken must differ from rune.summary.cancelToken`,
    );
  });
});

describe('rune run', () => {
  it('rejects invalid summary tokens in the selected overlay before execution', async () => {
    const path = fixture(MANIFEST);
    const overlayPath = join(path, '..', 'locales', 'de.yaml');
    mkdirSync(join(path, '..', 'locales'));
    writeFileSync(overlayPath, 'rune.summary.cancelToken: p\n', 'utf8');
    const io = capture();

    const code = await run(
      ['run', path, '--non-interactive', '--locale', 'de', '--set', 'greeting=hello'],
      io,
    );

    expect(code).toBe(3);
    expect(io.err.join('\n')).toContain(
      `${overlayPath}:1:1: rune.summary.cancelToken must differ from rune.summary.proceedToken`,
    );
    expect(io.err.join('\n')).not.toContain('Step 1');
  });

  it('runs to success and honours --result -', async () => {
    const path = fixture(MANIFEST);
    const io = capture();

    const code = await run(
      ['run', path, '--non-interactive', '--set', 'greeting=hello', '--result', '-'],
      io,
    );

    expect(code).toBe(0);
    const result = JSON.parse(io.out.join('\n')) as Record<string, unknown>;
    expect(result['resultSchemaVersion']).toBe(2);
    expect(result['status']).toBe('succeeded');
    expect(result['mode']).toBe('non-interactive');
    expect(io.err.join('\n')).toContain('hello');
  });

  it('renders the plan under --dry-run and executes nothing', async () => {
    const path = fixture(MANIFEST);
    const io = capture();

    const code = await run(
      ['run', path, '--dry-run', '--non-interactive', '--set', 'greeting=hi'],
      io,
    );

    expect(code).toBe(0);
    expect(io.out[0]).toContain('Plan for Example 1.0.0');
    expect(io.out.join('\n')).toContain('node -e');
  });

  it('uses locale chrome for the dry-run plan', async () => {
    const previewPlatform = process.platform === 'win32' ? 'linux' : 'windows';
    const unavailablePlatform = previewPlatform === 'windows' ? 'linux' : 'windows';
    const path = fixture([
      'schemaVersion: 1',
      'product:',
      '  name: Example',
      '  version: "1.0.0"',
      'steps:',
      '  - id: hello',
      '    run:',
      '      command: node',
      '      args: ["-e", "0"]',
      '  - id: skipped',
      '    run:',
      `      ${unavailablePlatform}:`,
      '        command: node',
    ]);
    const localesDirectory = join(path, '..', 'locales');
    mkdirSync(localesDirectory);
    writeFileSync(
      join(localesDirectory, 'de.yaml'),
      [
        'rune.plan.heading: PLAN::{product}::{version}::{path}::{platform}{preview}',
        'rune.plan.crossPlatformPreview: ::VORSCHAU',
        'rune.plan.step: SCHRITT::{number}::{title}',
        'rune.plan.skipped: UEBERSPRUNGEN::{number}::{title}::{state}::{reason}',
        'rune.plan.command: BEFEHL::{command}',
        'rune.result.planned: GEPLANT',
        'rune.result.summary: BILANZ::{succeeded}::{failed}::{skipped}::{notrun}::{exit}',
        '',
      ].join('\n'),
      'utf8',
    );
    const io = capture();

    expect(
      await run(
        [
          'run',
          path,
          '--dry-run',
          '--non-interactive',
          '--locale',
          'de',
          '--platform',
          previewPlatform,
        ],
        io,
      ),
    ).toBe(0);
    expect(io.out.join('\n')).toContain('PLAN::Example::1.0.0');
    expect(io.out.join('\n')).toContain(`::${previewPlatform}::VORSCHAU`);
    expect(io.out.join('\n')).toContain('SCHRITT::1. ::hello');
    expect(io.out.join('\n')).toContain('BEFEHL::node -e 0');
    expect(io.out.join('\n')).toContain('UEBERSPRUNGEN::2. ::skipped::SKIPPED::');
    expect(io.err.join('\n')).toContain('GEPLANT');
    expect(io.err.join('\n')).toContain('BILANZ::0::0::1::1::0');
    expect(io.out.join('\n')).not.toContain('Plan for');
    expect(io.err.join('\n')).not.toContain('Dry run: nothing was executed.');
  });

  it('uses locale chrome for progress, outcome, and result delivery', async () => {
    const path = fixture([
      'schemaVersion: 1',
      'product:',
      '  name: Example',
      '  version: "1.0.0"',
      'steps: []',
    ]);
    const resultPath = join(path, '..', 'result.json');
    const localesDirectory = join(path, '..', 'locales');
    mkdirSync(localesDirectory);
    writeFileSync(
      join(localesDirectory, 'de.yaml'),
      [
        'rune.progress.running: LAUF::{total}::{platform}',
        'rune.warning.message: HINWEIS::{warning}',
        'rune.result.succeeded: ERFOLG',
        'rune.result.nothingExecuted: LEER',
        'rune.result.summary: BILANZ::{succeeded}::{failed}::{skipped}::{notrun}::{exit}',
        'rune.result.written: GESCHRIEBEN::{path}',
        '',
      ].join('\n'),
      'utf8',
    );
    const io = capture();

    expect(
      await run(['run', path, '--non-interactive', '--locale', 'de', '--result', resultPath], io),
    ).toBe(0);
    const diagnostics = io.err.join('\n');
    expect(diagnostics).toContain('LAUF::0::');
    expect(diagnostics).toContain('ERFOLG');
    expect(diagnostics).toContain('HINWEIS::LEER');
    expect(diagnostics).toContain('BILANZ::0::0::0::0::0');
    expect(diagnostics).toContain(`GESCHRIEBEN::${resultPath}`);
    expect(diagnostics).not.toContain('running 0 steps on');
    expect(diagnostics).not.toContain('warning:');
    expect(diagnostics).not.toContain('Setup completed successfully.');
    expect(diagnostics).not.toContain('result written to');
  });

  it('uses locale chrome for every live-step progress message', async () => {
    const path = fixture([
      'schemaVersion: 1',
      'product:',
      '  name: Example',
      '  version: "1.0.0"',
      'steps:',
      '  - id: hello',
      '    run:',
      '      command: node',
      '      args: ["-e", "console.log(\'hello\')"]',
    ]);
    const localesDirectory = join(path, '..', 'locales');
    mkdirSync(localesDirectory);
    writeFileSync(
      join(localesDirectory, 'de.yaml'),
      [
        'rune.progress.running: LAUF::{total}::{platform}',
        'rune.progress.step: SCHRITT::{index}::{total}::{title}',
        'rune.progress.output: AUSGABE::{line}',
        'rune.progress.finished: ENDE::{state}{exit}{duration}',
        'rune.progress.exit: AUSGANG::{code}',
        'rune.progress.duration: ZEIT::{duration}',
        'rune.result.succeeded: ERFOLG',
        'rune.result.summary: BILANZ::{succeeded}::{failed}::{skipped}::{notrun}::{exit}',
        '',
      ].join('\n'),
      'utf8',
    );
    const io = capture();

    expect(await run(['run', path, '--non-interactive', '--locale', 'de'], io)).toBe(0);
    const diagnostics = io.err.join('\n');
    expect(diagnostics).toContain('LAUF::1::');
    expect(diagnostics).toContain('SCHRITT::1::1::hello');
    expect(diagnostics).toContain('AUSGABE::hello');
    expect(diagnostics).toContain('ENDE::SUCCEEDEDAUSGANG::0ZEIT::');
    expect(diagnostics).not.toContain('Step 1 of 1');
    expect(diagnostics).not.toContain(' after ');
  });

  it('exits 4 listing every missing input, and still writes the result file', async () => {
    const path = fixture(MANIFEST);
    const resultPath = join(path, '..', 'result.json');
    const io = capture();

    const code = await run(['run', path, '--non-interactive', '--result', resultPath], io);

    expect(code).toBe(4);
    expect(io.err.join('\n')).toContain('--set greeting=');
    const written = JSON.parse(readFileSync(resultPath, 'utf8')) as Record<string, unknown>;
    expect(written['resultSchemaVersion']).toBe(2);
    expect(written['status']).toBe('input_error');
    expect(written['mode']).toBe('non-interactive');
  });

  it('exits 1 when a step fails', async () => {
    const path = fixture([
      'schemaVersion: 1',
      'product:',
      '  name: Example',
      '  version: "1.0.0"',
      'steps:',
      '  - id: boom',
      '    run:',
      '      command: node',
      '      args: ["-e", "process.exit(3)"]',
    ]);
    const io = capture();

    expect(await run(['run', path, '--non-interactive'], io)).toBe(1);
    expect(io.err.join('\n')).toContain('FAILED');
  });

  it('refuses --platform without --dry-run as a usage error', async () => {
    const path = fixture(MANIFEST);
    const io = capture();
    expect(await run(['run', path, '--non-interactive', '--platform', 'linux'], io)).toBe(2);
  });
});

describe('help and misuse', () => {
  it('exits 0 for requested help and 2 for a bare invocation', async () => {
    expect(await run(['--help'], capture())).toBe(0);
    expect(await run([], capture())).toBe(2);
  });
});

describe('result files for failed outcomes', () => {
  it('writes a config_error result when the manifest is invalid', async () => {
    const path = fixture(['schemaVersion: 1', 'product:', '  name: X']);
    const resultPath = join(path, '..', 'result.json');
    const io = capture();

    expect(await run(['run', path, '--non-interactive', '--result', resultPath], io)).toBe(3);
    const written = JSON.parse(readFileSync(resultPath, 'utf8')) as Record<string, unknown>;
    expect(written['resultSchemaVersion']).toBe(2);
    expect(written['status']).toBe('config_error');
    expect(written['exitCode']).toBe(3);
    expect(written['mode']).toBe('non-interactive');
    expect(io.err.join('\n')).toContain(`result written to ${resultPath}`);
  });

  it('keeps stdout pure JSON under --dry-run --result -', async () => {
    const path = fixture(MANIFEST);
    const io = capture();

    const code = await run(
      ['run', path, '--dry-run', '--non-interactive', '--set', 'greeting=hi', '--result', '-'],
      io,
    );

    expect(code).toBe(0);
    const result = JSON.parse(io.out.join('\n')) as Record<string, unknown>;
    expect(result['status']).toBe('planned');
    expect(result['dryRun']).toBe(true);
  });
});

describe('rune --version', () => {
  it('prints its own version and the engine version', async () => {
    const io = capture();
    expect(await run(['--version'], io)).toBe(0);
    expect(io.out.join('\n')).toMatch(/rune .*engine /);
  });
});
