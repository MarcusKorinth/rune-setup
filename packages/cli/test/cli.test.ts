import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
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

  it('reports every validated locale overlay', async () => {
    const path = fixture(MANIFEST);
    writeLocaleOverlay(path, ['rune.button.next: Weiter']);
    const io = capture();

    expect(await run(['validate', path], io)).toBe(0);
    expect(io.out.join('\n')).toContain('locales: de');
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

  it('renders resolved locale chrome while keeping result JSON machine-readable', async () => {
    const path = fixture([
      'schemaVersion: 1',
      'product:',
      '  name: Example',
      '  version: "1.0.0"',
      'steps:',
      '  - id: hello',
      '    title: Hello step',
      '    run:',
      '      command: node',
      '      args: ["-e", "console.log(\'child output\')"]',
    ]);
    writeLocaleOverlay(path, [
      'steps.hello.title: Hallo Schritt',
      'rune.progress.step: "Schritt {index} von {total}: {title}"',
      'rune.result.succeeded: Einrichtung abgeschlossen.',
      'rune.result.planned: "Vorschau: Es wurde nichts ausgeführt."',
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
      steps: [{ id: 'hello', title: 'Hallo Schritt', state: 'SUCCEEDED', exitCode: 0 }],
    });
    expect(live.err).toContain('Schritt 1 von 1: Hallo Schritt');
    expect(live.err).toContain('Einrichtung abgeschlossen.');

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
    expect(io.out.join('\n')).toContain('literal-***');
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
    expect(rendered).toContain('Execution options: failFast=true, logFile=null');
    expect(rendered).toContain(
      'ignoredInput: value="", type=text, enabled=false, source=none, ignored=set',
    );
    expect(rendered).toContain('token: value="***", type=secret, enabled=true, source=set');
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
      manifest: { path, sha256: null, schemaVersion: null },
    });
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
        { id: 'pending', state: 'NOT_RUN', command: ['node', 'prefix-***', 'literal-***'] },
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
