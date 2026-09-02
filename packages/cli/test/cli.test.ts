import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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

function writeLocaleOverlay(manifestPath: string, lines: readonly string[]): void {
  const locales = join(manifestPath, '..', 'locales');
  mkdirSync(locales);
  writeFileSync(join(locales, 'de.yaml'), [...lines, ''].join('\n'), 'utf8');
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
    expect(io.out.join('\n')).toContain('resultSchemaVersion');
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

  it('rejects --platform as an unknown option without reporting success', async () => {
    const path = fixture(MANIFEST);
    const io = capture();

    expect(await run(['validate', path, '--platform', 'linux'], io)).toBe(2);
    expect(io.err.join('\n')).toContain("unknown option '--platform'");
    expect(io.out.join('\n')).not.toContain('is valid');
  });

  it('reports every validated locale overlay', async () => {
    const path = fixture(MANIFEST);
    writeLocaleOverlay(path, ['rune.button.next: Weiter']);
    const io = capture();

    expect(await run(['validate', path], io)).toBe(0);
    expect(io.out.join('\n')).toContain('locales: de');
  });

  it('renders the complete validate report in the explicitly selected locale', async () => {
    const path = fixture([
      'schemaVersion: 1',
      'product:',
      '  name: Example',
      '  version: "1.0.0"',
      'inputs:',
      '  target:',
      '    type: directory',
      '    default: "${env.RUNE_VALIDATE_TARGET}"',
      'steps: []',
    ]);
    writeLocaleOverlay(path, [
      'rune.validate.valid: "{path} ist gültig (Schema {schemaVersion}, Produkt {productName} {productVersion})"',
      'rune.validate.locales.none: "Sprachdateien: keine"',
      'rune.validate.locales.list: "Sprachdateien: {locales}"',
      'rune.validate.environment.none: "Gelesene Umgebungsvariablen: keine"',
      'rune.validate.environment.heading: "Gelesene Umgebungsvariablen:"',
      'rune.validate.environment.entry: "  {name} bei {location}"',
    ]);
    const io = capture();

    expect(await run(['validate', path, '--locale', 'de-DE'], io)).toBe(0);

    expect(io.out).toHaveLength(4);
    expect(io.out[0]).toBe(`${path} ist gültig (Schema 1, Produkt Example 1.0.0)`);
    expect(io.out[1]).toBe('Sprachdateien: de');
    expect(io.out[2]).toBe('Gelesene Umgebungsvariablen:');
    expect(io.out[3]).toMatch(/^ {2}RUNE_VALIDATE_TARGET bei /);
    expect(io.out[3]).toContain(`${path}:8:`);
    expect(io.err).toEqual([]);
  });

  it('exits 3 for an invalid manifest', async () => {
    const path = fixture(['schemaVersion: 1', 'product:', '  name: X']);
    const io = capture();
    expect(await run(['validate', path], io)).toBe(3);
    expect(io.err.join('\n')).toContain('product');
  });

  it('exits 2 for an invalid explicit locale without reporting success', async () => {
    const path = fixture(MANIFEST);
    const io = capture();

    expect(await run(['validate', path, '--locale', 'definitely_invalid'], io)).toBe(2);
    expect(io.err.join('\n')).toContain('invalid locale "definitely_invalid" from --locale');
    expect(io.out.join('\n')).not.toContain('is valid');
  });

  it.each(['de-DE', 'de_DE', 'C', 'POSIX'])('accepts explicit locale %s', async (locale) => {
    const path = fixture(MANIFEST);
    const io = capture();

    expect(await run(['validate', path, '--locale', locale], io)).toBe(0);
    expect(io.out[0]).toContain('is valid');
    expect(io.err).toEqual([]);
  });
});

describe('rune run', () => {
  it('runs to success and honours --result -', async () => {
    const path = fixture(MANIFEST);
    const io = capture();

    const code = await run(
      ['run', path, '--non-interactive', '--set', 'greeting=hello', '--result', '-'],
      io,
    );

    expect(code).toBe(0);
    const result = JSON.parse(io.out.join('\n')) as Record<string, unknown>;
    expect(result['status']).toBe('succeeded');
    expect(result).toMatchObject({
      mode: 'non-interactive',
      manifest: {
        path,
        sha256: createHash('sha256').update(readFileSync(path)).digest('hex'),
        schemaVersion: 1,
      },
    });
    expect(result).not.toHaveProperty('manifestPath');
    expect(io.err.join('\n')).toContain('hello');
  });

  it('uses the non-interactive fallback without the flag', async () => {
    const path = fixture(MANIFEST);
    const io = capture();

    const code = await run(['run', path, '--set', 'greeting=hello', '--result', '-'], io);

    expect(code).toBe(0);
    expect(io.out).toHaveLength(1);
    expect(JSON.parse(io.out.join('\n'))).toMatchObject({
      mode: 'non-interactive',
      status: 'succeeded',
      exitCode: 0,
    });
    expect(io.err.join('\n')).toContain('hello');
  });

  it('collects repeated --set and --values options around the manifest in invocation order', async () => {
    const path = fixture([
      'schemaVersion: 1',
      'product:',
      '  name: Example',
      '  version: "1.0.0"',
      'inputs:',
      '  greeting:',
      '    type: text',
      '  target:',
      '    type: text',
      'steps: []',
    ]);
    const firstValues = join(path, '..', 'first-values.yaml');
    const secondValues = join(path, '..', 'second-values.yaml');
    writeFileSync(firstValues, 'greeting: from-first-values\ntarget: first\n', 'utf8');
    writeFileSync(secondValues, 'greeting: from-second-values\ntarget: second\n', 'utf8');
    const io = capture();

    const code = await run(
      [
        'run',
        '--dry-run',
        '--values',
        firstValues,
        '--set',
        'greeting=before-manifest',
        path,
        '--values',
        secondValues,
        '--set',
        'greeting=after-manifest',
        '--result',
        '-',
      ],
      io,
    );

    expect(code).toBe(0);
    expect(JSON.parse(io.out.join('\n'))).toMatchObject({
      status: 'planned',
      inputs: [
        { id: 'greeting', value: 'after-manifest', source: 'set' },
        { id: 'target', value: 'second', source: 'values' },
      ],
    });
  });

  it('renders resolved locale chrome while keeping result JSON machine-readable', async () => {
    const path = fixture([
      'schemaVersion: 1',
      'product:',
      '  name: Example',
      '  version: "1.0.0"',
      'inputs:',
      '  includeSkipped:',
      '    type: boolean',
      '    default: false',
      'steps:',
      '  - id: hello',
      '    title: Hello step',
      '    run:',
      '      command: node',
      '      args: ["-e", "console.log(\'child output\')"]',
      '  - id: skipped',
      '    when: "${includeSkipped}"',
      '    run:',
      '      command: never-runs',
    ]);
    writeLocaleOverlay(path, [
      'steps.hello.title: Hallo Schritt',
      'rune.progress.runStarted: "Ausführung {total} Schritte auf {platform}"',
      'rune.progress.step: "Schritt {index} von {total}: {title}"',
      'rune.progress.stepFinished: "Ende {state} mit Code {exitCode} nach {durationMs}ms"',
      'rune.progress.stepFinishedWithoutExitCode: "Ende {state} ohne Code nach {durationMs}ms"',
      'rune.result.succeeded: Einrichtung abgeschlossen.',
      'rune.result.planned: "Vorschau: Es wurde nichts ausgeführt."',
      'rune.result.summary: "Bilanz {status}: {succeeded}/{failed}/{skipped}/{notRun} mit Code {exitCode}"',
    ]);

    const live = capture();
    expect(
      await run(['run', path, '--non-interactive', '--locale', 'de-DE', '--result', '-'], live),
    ).toBe(0);

    const result = JSON.parse(live.out.join('\n')) as Record<string, unknown>;
    expect(live.out).toHaveLength(1);
    expect(result).toMatchObject({
      status: 'succeeded',
      exitCode: 0,
      stepsExecuted: 1,
      steps: [
        { id: 'hello', title: 'Hallo Schritt', state: 'SUCCEEDED', exitCode: 0 },
        { id: 'skipped', title: 'skipped', state: 'SKIPPED', exitCode: null },
      ],
    });
    const platform = process.platform === 'win32' ? 'windows' : 'linux';
    const diagnostics = live.err.join('\n');
    expect(diagnostics).toContain(`Ausführung 2 Schritte auf ${platform}`);
    expect(diagnostics).toContain('Schritt 1 von 2: Hallo Schritt');
    expect(diagnostics).toContain('Ende SUCCEEDED mit Code 0 nach');
    expect(diagnostics).toContain('Ende SKIPPED ohne Code nach');
    expect(diagnostics).toContain('Einrichtung abgeschlossen.');
    expect(diagnostics).toContain('Bilanz succeeded: 1/0/1/0 mit Code 0');

    const dryRun = capture();
    expect(
      await run(['run', path, '--dry-run', '--non-interactive', '--locale', 'de-DE'], dryRun),
    ).toBe(0);
    expect(dryRun.out.join('\n')).toContain('Hallo Schritt');
    expect(dryRun.err).toContain('Vorschau: Es wurde nichts ausgeführt.');
  });

  it('uses localized nothing-executed chrome and English fallbacks per key', async () => {
    const emptyPath = fixture([
      'schemaVersion: 1',
      'product:',
      '  name: Example',
      '  version: "1.0.0"',
      'steps: []',
    ]);
    writeLocaleOverlay(emptyPath, [
      'rune.result.succeeded: Einrichtung abgeschlossen.',
      'rune.result.nothingExecuted: Kein Schritt musste ausgeführt werden.',
    ]);
    const empty = capture();

    expect(await run(['run', emptyPath, '--non-interactive', '--locale', 'de-DE'], empty)).toBe(0);
    expect(empty.err).toContain('Einrichtung abgeschlossen.');
    expect(empty.err).toContain('warning: Kein Schritt musste ausgeführt werden.');
    expect(empty.err).toContain('succeeded: 0 succeeded, 0 failed, 0 skipped, 0 not run (exit 0)');

    const failedPath = fixture([
      'schemaVersion: 1',
      'product:',
      '  name: Example',
      '  version: "1.0.0"',
      'steps:',
      '  - id: fail',
      '    run:',
      '      command: node',
      '      args: ["-e", "process.exit(3)"]',
    ]);
    writeLocaleOverlay(failedPath, ['rune.progress.step: "Schritt {index} von {total}: {title}"']);
    const failed = capture();

    expect(await run(['run', failedPath, '--non-interactive', '--locale', 'de-DE'], failed)).toBe(
      1,
    );
    expect(failed.err).toContain('Setup failed.');
    expect(failed.err).toContain('failed: 0 succeeded, 1 failed, 0 skipped, 0 not run (exit 1)');
  });

  it('masks registered bytes in ordinary dry-run values and literal argv', async () => {
    const marker = 'shared-secret-marker';
    const mirror = `prefix-${marker}-suffix`;
    const path = fixture([
      'schemaVersion: 1',
      'product:',
      '  name: Example',
      '  version: "1.0.0"',
      'inputs:',
      '  token:',
      '    type: secret',
      '  mirror:',
      '    type: text',
      'steps:',
      '  - id: use',
      '    run:',
      '      command: node',
      `      args: ["\${mirror}", "literal-${marker}"]`,
    ]);
    const io = capture();

    const code = await run(
      [
        'run',
        path,
        '--dry-run',
        '--non-interactive',
        '--set',
        `token=${marker}`,
        '--set',
        `mirror=${mirror}`,
      ],
      io,
    );

    expect(code).toBe(0);
    expect(io.out.join('\n')).not.toContain(marker);
    expect(io.out.join('\n')).toContain('prefix-***-suffix');
    expect(io.out.join('\n')).toContain('argv: ["node","***","***"]');
  });

  it('masks complete dry-run lines while preserving structured identities', async () => {
    const productName = 'IdentityProduct';
    const path = fixture([
      'schemaVersion: 1',
      'product:',
      `  name: ${productName}`,
      '  version: "1.0.0"',
      'inputs:',
      '  headingSecret:',
      '    type: secret',
      '  productSecret:',
      '    type: secret',
      '  manifestSecret:',
      '    type: secret',
      '  logSecret:',
      '    type: secret',
      '  resultSecret:',
      '    type: secret',
      'steps: []',
    ]);
    const logPath = join(path, '..', 'identity.log');
    const resultPath = join(path, '..', 'identity-result.json');
    const io = capture();
    const markers = ['Resolved inputs:', productName, path, logPath, resultPath];

    const code = await run(
      [
        'run',
        path,
        '--dry-run',
        '--non-interactive',
        '--log-file',
        logPath,
        '--result',
        resultPath,
        '--set',
        'headingSecret=Resolved inputs:',
        '--set',
        `productSecret=${productName}`,
        '--set',
        `manifestSecret=${path}`,
        '--set',
        `logSecret=${logPath}`,
        '--set',
        `resultSecret=${resultPath}`,
      ],
      io,
    );

    expect(code).toBe(0);
    const humanOutput = [...io.out, ...io.err].join('\n');
    for (const marker of markers) {
      expect(humanOutput).not.toContain(marker);
    }
    expect(humanOutput).toContain('***');

    const result = JSON.parse(readFileSync(resultPath, 'utf8')) as Record<string, unknown>;
    expect(result['product']).toEqual({ name: productName, version: '1.0.0' });
    expect(result['manifest']).toMatchObject({ path });
  });

  it('masks fixed live chrome and fully composed log records', async () => {
    const progressMarker = 'Step 1 of 1';
    const resultMarker = 'Setup completed successfully.';
    const runLogMarker = 'run started';
    const stepLogMarker = 'hello:stdout';
    const path = fixture([
      'schemaVersion: 1',
      'product:',
      '  name: Example',
      '  version: "1.0.0"',
      'inputs:',
      '  progressSecret:',
      '    type: secret',
      '  resultSecret:',
      '    type: secret',
      '  runLogSecret:',
      '    type: secret',
      '  stepLogSecret:',
      '    type: secret',
      'steps:',
      '  - id: hello',
      '    run:',
      '      command: node',
      '      args: ["-e", "console.log(\'complete\')"]',
    ]);
    const logPath = join(path, '..', 'run.log');
    const io = capture();

    const code = await run(
      [
        'run',
        path,
        '--non-interactive',
        '--log-file',
        logPath,
        '--set',
        `progressSecret=${progressMarker}`,
        '--set',
        `resultSecret=${resultMarker}`,
        '--set',
        `runLogSecret=${runLogMarker}`,
        '--set',
        `stepLogSecret=${stepLogMarker}`,
      ],
      io,
    );

    expect(code).toBe(0);
    const diagnostics = io.err.join('\n');
    expect(diagnostics).not.toContain(progressMarker);
    expect(diagnostics).not.toContain(resultMarker);
    expect(diagnostics).toContain('***');

    const log = readFileSync(logPath, 'utf8');
    expect(log).not.toContain(runLogMarker);
    expect(log).not.toContain(stepLogMarker);
    expect(log).toContain('[***] complete');
  });

  it.each(['before', 'after'] as const)(
    'masks a rejected ordinary value when the matching secret is declared %s it',
    async (order) => {
      const marker = 'rejected-shared-secret';
      const inputs =
        order === 'before'
          ? [
              '  token:',
              '    type: secret',
              '  channel:',
              '    type: select',
              '    options: [stable]',
            ]
          : [
              '  channel:',
              '    type: select',
              '    options: [stable]',
              '  token:',
              '    type: secret',
            ];
      const path = fixture([
        'schemaVersion: 1',
        'product:',
        '  name: Example',
        '  version: "1.0.0"',
        'inputs:',
        ...inputs,
        'steps: []',
      ]);
      const io = capture();

      const code = await run(
        [
          'run',
          path,
          '--non-interactive',
          '--set',
          `token=${marker}`,
          '--set',
          `channel=prefix-${marker}`,
        ],
        io,
      );

      expect(code).toBe(4);
      expect(io.err.join('\n')).not.toContain(marker);
      expect(io.err.join('\n')).toContain('prefix-***');
    },
  );

  it('renders the complete, unambiguous plan under --dry-run without leaking secrets', async () => {
    const secret = 'super-secret-value';
    const path = fixture([
      'schemaVersion: 1',
      'product:',
      '  name: Example',
      '  version: "1.0.0"',
      'inputs:',
      '  includeExtra:',
      '    type: boolean',
      '    default: false',
      '  ignoredInput:',
      '    type: text',
      '    when: "${includeExtra}"',
      '  token:',
      '    type: secret',
      'steps:',
      '  - id: preview',
      '    run:',
      '      command: node',
      '      args:',
      '        - two words',
      `        - 'quote"inside'`,
      '        - "--token=${token}"',
      '      cwd: "work/${token}"',
      '      env:',
      '        PUBLIC: visible value',
      '        PRIVATE: "prefix-${token}-suffix"',
      '      timeoutSeconds: 12',
      '      successExitCodes: [0, 7]',
      '  - id: skipped',
      '    when: "${includeExtra}"',
      '    run:',
      '      command: never-runs',
    ]);
    const io = capture();

    const code = await run(
      [
        'run',
        path,
        '--dry-run',
        '--non-interactive',
        '--set',
        `token=${secret}`,
        '--set',
        'ignoredInput=discarded',
      ],
      io,
    );

    expect(code).toBe(0);
    const rendered = io.out.join('\n');
    expect(io.out[0]).toContain('Execution plan v1 for Example 1.0.0');
    expect(rendered).toContain('Execution options: failFast=true, logFile=none');
    expect(rendered).toContain(
      'ignoredInput: value="", secret=false, enabled=false, source=none, ignored=set',
    );
    expect(rendered).toContain('token: value="***", secret=true, enabled=true, source=set');
    expect(rendered).toContain('argv: ["node","two words","quote\\"inside","***"]');
    expect(rendered).toContain('cwd: "***"');
    expect(rendered).toContain('env: {"PUBLIC":"visible value","PRIVATE":"***"}');
    expect(rendered).toContain('timeoutSeconds: 12');
    expect(rendered).toContain('successExitCodes: [0,7]');
    expect(rendered).toContain('SKIPPED (condition false: ${includeExtra})');
    expect(rendered).not.toContain(secret);
  });

  it('exits 4 listing every missing input, and still writes the result file', async () => {
    const path = fixture(MANIFEST);
    const resultPath = join(path, '..', 'result.json');
    const io = capture();

    const code = await run(['run', path, '--non-interactive', '--result', resultPath], io);

    expect(code).toBe(4);
    expect(io.err.join('\n')).toContain('--set greeting=');
    const written = JSON.parse(readFileSync(resultPath, 'utf8')) as Record<string, unknown>;
    expect(written['status']).toBe('input_error');
  });

  it('rejects __proto__ as an unknown --set key', async () => {
    const path = fixture(MANIFEST);
    const io = capture();

    const code = await run(
      ['run', path, '--non-interactive', '--set', 'greeting=hello', '--set', '__proto__=secret'],
      io,
    );

    expect(code).toBe(4);
    expect(io.err.join('\n')).toContain('"__proto__" is not an input of this manifest');
  });

  it.each([
    { case: 'without a separator', pair: 'not-a-real-secret-marker' },
    { case: 'with an empty key', pair: '=not-a-real-secret-marker' },
  ])('rejects malformed --set $case without echoing it or writing a result', async ({ pair }) => {
    const path = fixture(MANIFEST);
    const resultPath = join(path, '..', 'result.json');
    const io = capture();

    const code = await run(
      ['run', path, '--non-interactive', '--set', pair, '--result', resultPath],
      io,
    );

    expect(code).toBe(2);
    expect(io.err.join('\n')).toContain('--set expects key=value');
    expect(io.err.join('\n')).not.toContain('not-a-real-secret-marker');
    expect(io.out.join('\n')).not.toContain('not-a-real-secret-marker');
    expect(existsSync(resultPath)).toBe(false);
  });

  it('accepts an empty value in a syntactically valid --set pair', async () => {
    const path = fixture([
      'schemaVersion: 1',
      'product:',
      '  name: Example',
      '  version: "1.0.0"',
      'inputs:',
      '  greeting:',
      '    type: text',
      '    required: false',
      'steps: []',
    ]);
    const io = capture();

    const code = await run(
      ['run', path, '--dry-run', '--non-interactive', '--set', 'greeting=', '--result', '-'],
      io,
    );

    expect(code).toBe(0);
    expect(JSON.parse(io.out.join('\n'))).toMatchObject({ status: 'planned', dryRun: true });
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

  it('anchors a relative result path before observer output changes the working directory', async () => {
    const invocationDirectory = mkdtempSync(join(tmpdir(), 'rune-cli-result-invocation-'));
    const laterDirectory = mkdtempSync(join(tmpdir(), 'rune-cli-result-later-'));
    const manifestPath = join(invocationDirectory, 'installer.yaml');
    const resultPath = join('results', 'run.json');
    const originalDirectory = process.cwd();
    mkdirSync(join(invocationDirectory, 'results'));
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
        '      args: ["-e", "console.log(\'complete\')"]',
        '',
      ].join('\n'),
      'utf8',
    );
    const out: string[] = [];
    const err: string[] = [];
    let changedDirectory = false;
    const io: Capture = {
      out,
      err,
      stdout: (line) => out.push(line),
      stderr: (line) => {
        err.push(line);
        if (!changedDirectory) {
          changedDirectory = true;
          process.chdir(laterDirectory);
        }
      },
    };

    try {
      process.chdir(invocationDirectory);

      expect(
        await run(['run', manifestPath, '--non-interactive', '--result', resultPath], io),
      ).toBe(0);

      expect(changedDirectory).toBe(true);
      expect(existsSync(join(invocationDirectory, resultPath))).toBe(true);
      expect(existsSync(join(laterDirectory, resultPath))).toBe(false);
      expect(err).toContain(`result written to ${resultPath}`);
    } finally {
      process.chdir(originalDirectory);
      rmSync(invocationDirectory, { recursive: true, force: true });
      rmSync(laterDirectory, { recursive: true, force: true });
    }
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
    expect(written['status']).toBe('config_error');
    expect(written['exitCode']).toBe(3);
    expect(written).toMatchObject({
      mode: 'non-interactive',
      product: null,
      locale: null,
      manifest: { path, sha256: null, schemaVersion: null },
    });
    expect(io.err).toContain(`result written to ${resultPath}`);
    expect(io.err).toContain('config_error: 0 succeeded, 0 failed, 0 skipped, 0 not run (exit 3)');
  });

  it('suppresses unsafe fallback lines after a secret-bearing open failure', async () => {
    const path = fixture([
      'schemaVersion: 1',
      'product:',
      '  name: Example',
      '  version: "1.0.0"',
      'inputs:',
      '  summarySecret:',
      '    type: secret',
      '  announcementSecret:',
      '    type: secret',
      '  channel:',
      '    type: select',
      '    options: [stable]',
      'steps: []',
    ]);
    const resultPath = join(path, '..', 'open-failure.json');
    const summary = 'input_error: 0 succeeded, 0 failed, 0 skipped, 0 not run (exit 4)';
    const announcement = `result written to ${resultPath}`;
    const io = capture();

    const code = await run(
      [
        'run',
        path,
        '--non-interactive',
        '--result',
        resultPath,
        '--set',
        `summarySecret=${summary}`,
        '--set',
        `announcementSecret=${announcement}`,
        '--set',
        'channel=invalid',
      ],
      io,
    );

    expect(code).toBe(4);
    const humanOutput = [...io.out, ...io.err].join('\n');
    expect(humanOutput).not.toContain(summary);
    expect(humanOutput).not.toContain(announcement);

    const result = JSON.parse(readFileSync(resultPath, 'utf8')) as Record<string, unknown>;
    expect(result).toMatchObject({
      status: 'input_error',
      exitCode: 4,
      error: { code: 'RUNE-202' },
    });
    expect(JSON.stringify(result)).not.toContain(summary);
    expect(JSON.stringify(result)).not.toContain(announcement);
  });

  it('keeps validated metadata when the selected locale overlay is invalid', async () => {
    const path = fixture(MANIFEST);
    writeLocaleOverlay(path, ['rune.button.unknown: Unbekannt']);
    const resultPath = join(path, '..', 'overlay-failure.json');
    const foreign = process.platform === 'win32' ? 'linux' : 'windows';
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
          foreign,
          '--result',
          resultPath,
        ],
        io,
      ),
    ).toBe(3);

    const written = JSON.parse(readFileSync(resultPath, 'utf8')) as Record<string, unknown>;
    expect(written).toMatchObject({
      status: 'config_error',
      exitCode: 3,
      dryRun: true,
      mode: 'non-interactive',
      platform: foreign,
      crossPlatformPreview: true,
      locale: 'de',
      product: { name: 'Example', version: '1.0.0' },
      manifest: {
        path,
        sha256: createHash('sha256').update(readFileSync(path)).digest('hex'),
        schemaVersion: 1,
      },
      inputs: [],
      steps: [],
    });
    expect((written['manifest'] as Record<string, unknown>)['sha256']).toMatch(/^[a-f0-9]{64}$/);
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
    expect(io.out).toHaveLength(1);
    expect(io.out[0]).not.toContain('Execution plan');
  });

  it('preserves post-open context and renders session warnings once on plan failure', async () => {
    const secret = 'failure-path-secret';
    const path = fixture([
      'schemaVersion: 1',
      'product:',
      '  name: Example',
      '  version: "1.0.0"',
      'inputs:',
      '  enabled:',
      '    type: boolean',
      '    default: false',
      '  ignoredInput:',
      '    type: text',
      '    when: "${enabled}"',
      '  token:',
      '    type: secret',
      'steps:',
      '  - id: unresolved',
      '    run:',
      '      command: "${env.RUNE_F011_MISSING}"',
    ]);
    const resultPath = join(path, '..', 'failure-result.json');
    const io = capture();

    const code = await run(
      [
        'run',
        path,
        '--non-interactive',
        '--set',
        'ignoredInput=discarded',
        '--set',
        `token=${secret}`,
        '--result',
        resultPath,
      ],
      io,
    );

    expect(code).toBe(5);
    const written = JSON.parse(readFileSync(resultPath, 'utf8')) as Record<string, unknown>;
    expect(written).toMatchObject({
      status: 'resolution_error',
      product: { name: 'Example', version: '1.0.0' },
      manifest: {
        path,
        sha256: createHash('sha256').update(readFileSync(path)).digest('hex'),
        schemaVersion: 1,
      },
      inputs: [
        { id: 'enabled', value: false, source: 'default', enabled: true, secret: false },
        {
          id: 'ignoredInput',
          value: '',
          source: 'set',
          enabled: false,
          secret: false,
          ignored: 'input disabled',
        },
        { id: 'token', value: null, source: 'set', enabled: true, secret: true },
      ],
      steps: [],
    });
    expect(JSON.stringify(written)).not.toContain(secret);
    const warnings = io.err.filter((line) => line.includes('ignoredInput was set'));
    expect(warnings).toHaveLength(1);
    expect(io.err.join('\n')).not.toContain('warning: nothing was executed');
  });

  it('preserves the completed plan when log opening fails', async () => {
    const marker = 'log-open-shared-secret';
    const path = fixture([
      'schemaVersion: 1',
      'product:',
      '  name: Example',
      '  version: "1.0.0"',
      'inputs:',
      '  enabled:',
      '    type: boolean',
      '    default: false',
      '  token:',
      '    type: secret',
      '  mirror:',
      '    type: text',
      'steps:',
      '  - id: skipped',
      '    when: "${enabled}"',
      '    run:',
      '      command: never-runs',
      '  - id: pending',
      '    run:',
      '      command: node',
      `      args: ["\${mirror}", "literal-${marker}"]`,
    ]);
    const directory = join(path, '..');
    const resultPath = join(directory, 'planned-failure.json');
    const io = capture();

    const code = await run(
      [
        'run',
        path,
        '--non-interactive',
        '--set',
        `token=${marker}`,
        '--set',
        `mirror=prefix-${marker}`,
        '--log-file',
        directory,
        '--result',
        resultPath,
      ],
      io,
    );

    expect(code).toBe(1);
    const written = JSON.parse(readFileSync(resultPath, 'utf8')) as Record<string, unknown>;
    expect(written).toMatchObject({
      status: 'failed',
      exitCode: 1,
      stepsTotal: 2,
      stepsExecuted: 0,
      stepsSkipped: 1,
      stepsNotRun: 1,
      nothingExecuted: true,
      steps: [
        { id: 'skipped', state: 'SKIPPED', command: null },
        { id: 'pending', state: 'NOT_RUN', command: ['node', '***', '***'] },
      ],
    });
    expect(JSON.stringify(written)).not.toContain(marker);
    expect(io.err.join('\n')).not.toContain(marker);
    expect(io.err.join('\n')).not.toContain('warning: nothing was executed');
  });

  it('writes an honest empty topology for a plan-time execution error', async () => {
    const path = fixture([
      'schemaVersion: 1',
      'product:',
      '  name: Example',
      '  version: "1.0.0"',
      'inputs:',
      '  channel:',
      '    type: text',
      '    default: stable',
      'steps:',
      '  - id: legacy',
      '    run:',
      '      command: setup.cmd',
    ]);
    const resultPath = join(path, '..', 'policy-failure.json');
    const io = capture();

    const code = await run(
      [
        'run',
        path,
        '--dry-run',
        '--non-interactive',
        '--platform',
        'windows',
        '--result',
        resultPath,
      ],
      io,
    );

    expect(code).toBe(1);
    const written = JSON.parse(readFileSync(resultPath, 'utf8')) as Record<string, unknown>;
    expect(written).toMatchObject({
      status: 'failed',
      exitCode: 1,
      dryRun: true,
      platform: 'windows',
      product: { name: 'Example', version: '1.0.0' },
      manifest: {
        path,
        sha256: createHash('sha256').update(readFileSync(path)).digest('hex'),
        schemaVersion: 1,
      },
      stepsTotal: 0,
      stepsExecuted: 0,
      nothingExecuted: true,
      inputs: [{ id: 'channel', value: 'stable', source: 'default' }],
      steps: [],
    });
  });
});

describe('rune --version', () => {
  it('prints its own version and the engine version', async () => {
    const io = capture();
    expect(await run(['--version'], io)).toBe(0);
    expect(io.out.join('\n')).toMatch(/rune .*engine /);
  });
});
