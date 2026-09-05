import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, parse, resolve, toNamespacedPath } from 'node:path';

import { resultJsonSchema, sameSinkPath } from '@rune/engine';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';

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

function hasRawTerminalControl(text: string): boolean {
  return [...text].some((character) => {
    const codePoint = character.codePointAt(0)!;
    return (
      codePoint <= 0x1f ||
      (codePoint >= 0x7f && codePoint <= 0x9f) ||
      codePoint === 0x2028 ||
      codePoint === 0x2029
    );
  });
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

function writeExecutionMarkerManifest(
  manifestPath: string,
  childMarker: string,
  execution: readonly string[] = [],
): void {
  writeFileSync(
    manifestPath,
    [
      'schemaVersion: 1',
      'product:',
      '  name: Example',
      '  version: "1.0.0"',
      ...execution,
      'steps:',
      '  - id: run',
      '    run:',
      '      command: node',
      `      args: ["-e", "require('node:fs').writeFileSync(process.argv[1], 'ran')", ${JSON.stringify(childMarker)}]`,
      '',
    ].join('\n'),
    'utf8',
  );
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

  it('emits a result schema that validates a successful CLI result', async () => {
    const schemaIo = capture();
    expect(await run(['schema', '--result'], schemaIo)).toBe(0);

    const emittedSchema = JSON.parse(schemaIo.out.join('\n')) as Parameters<
      typeof z.fromJSONSchema
    >[0];
    expect(emittedSchema).toEqual(resultJsonSchema());

    const resultValidator = z.fromJSONSchema(emittedSchema);
    const path = fixture(MANIFEST);
    const resultIo = capture();
    expect(
      await run(
        ['run', path, '--non-interactive', '--set', 'greeting=hello', '--result', '-'],
        resultIo,
      ),
    ).toBe(0);

    const result = JSON.parse(resultIo.out.join('\n')) as Record<string, unknown>;
    expect(resultValidator.safeParse(result).success).toBe(true);
    expect(resultValidator.safeParse({ ...result, resultSchemaVersion: 1 }).success).toBe(false);
  });

  it('escapes only the human file announcement', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'rune-cli-schema-announcement-'));
    const output = join(dir, 'schema\u2028controlled.json');
    const io = capture();

    expect(await run(['schema', '--output', output], io)).toBe(0);
    expect(io.err).toEqual([`schema written to ${output.replace('\u2028', '\\u2028')}`]);
    expect(JSON.parse(readFileSync(output, 'utf8'))).toMatchObject({ type: 'object' });
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

  it('reports secret argv warnings only on stderr and keeps the environment audit on stdout', async () => {
    const path = fixture([
      'schemaVersion: 1',
      'product:',
      '  name: Example',
      '  version: "1.0.0"',
      'inputs:',
      '  token:',
      '    type: secret',
      '    required: false',
      'steps:',
      '  - id: inspect',
      '    run:',
      '      command: node',
      '      args: ["${token}", "${env.VALIDATE_AUDIT}"]',
    ]);
    writeLocaleOverlay(path, ['rune.warning: "WARNUNG: {message}"']);
    const io = capture();

    expect(await run(['validate', path, '--locale', 'de'], io)).toBe(0);

    const warning = io.err.filter((line) => line.startsWith('WARNUNG:'));
    const environmentIndex = io.out.findIndex((line) => line === 'environment variables read:');
    expect(warning).toHaveLength(1);
    expect(warning[0]).toContain('secret input "token"');
    expect(warning[0]).toContain('OS process listings');
    expect(warning[0]).toContain('use env: instead');
    expect(io.out.join('\n')).not.toContain('WARNUNG:');
    expect(io.out.join('\n')).not.toContain('OS process listings');
    expect(environmentIndex).toBeGreaterThan(1);
    expect(io.out[environmentIndex + 1]).toContain('VALIDATE_AUDIT');
  });

  it('rejects --platform as an unknown option without reporting success', async () => {
    const path = fixture(MANIFEST);
    const io = capture();

    expect(await run(['validate', path, '--platform', 'linux'], io)).toBe(2);
    expect(io.err.join('\n')).toContain("unknown option '--platform'");
    expect(io.out.join('\n')).not.toContain('is valid');
  });

  it('escapes controls in an unknown option without injecting stderr lines', async () => {
    const path = fixture(MANIFEST);
    const io = capture();
    const option = '--unknown\u001b\r\nforged\u0085\u2028\u2029';

    expect(await run(['validate', path, option], io)).toBe(2);

    expect(io.out).toEqual([]);
    expect(io.err).toHaveLength(1);
    const stderr = io.err[0]!;
    expect(hasRawTerminalControl(stderr)).toBe(false);
    for (const visible of ['\\u001b', '\\r', '\\n', '\\u0085', '\\u2028', '\\u2029']) {
      expect(stderr).toContain(visible);
    }
    expect(stderr).toContain('unknown option');
    expect(stderr).not.toContain('\nforged');
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

  it('escapes a composed localized validate line once', async () => {
    const productName = 'Product\u001b\u2028';
    const path = fixture([
      'schemaVersion: 1',
      'product:',
      `  name: ${JSON.stringify(productName)}`,
      '  version: "1.0.0"',
      'steps: []',
    ]);
    writeLocaleOverlay(path, [
      `rune.validate.valid: ${JSON.stringify('VALID\u0085 {productName} literal \\n')}`,
    ]);
    const io = capture();

    expect(await run(['validate', path, '--locale', 'de'], io)).toBe(0);
    expect(io.out[0]).toContain(String.raw`VALID\u0085 Product\u001b\u2028 literal \n`);
    expect(io.out[0]).not.toContain(String.raw`\\u001b`);
    expect(hasRawTerminalControl(io.out[0] ?? '')).toBe(false);
  });

  it('exits 3 for an invalid manifest', async () => {
    const path = fixture(['schemaVersion: 1', 'product:', '  name: X']);
    const io = capture();
    expect(await run(['validate', path], io)).toBe(3);
    expect(io.err.join('\n')).toContain('product');
  });

  it.each([['validate'], ['run']])(
    'keeps formatter line feeds while escaping %s issue data',
    async (command) => {
      const path = fixture([
        'schemaVersion: 1',
        'product:',
        '  name: Example',
        `${JSON.stringify('unknown\u001b')}: true`,
        `${JSON.stringify('unknown\u0085')}: true`,
      ]);
      const io = capture();

      expect(await run([command, path], io)).toBe(3);
      const aggregate = io.err[0] ?? '';
      expect(aggregate.split('\n').length).toBeGreaterThanOrEqual(2);
      expect(aggregate).toContain('\\u001b');
      expect(aggregate).toContain('\\u0085');
      expect(hasRawTerminalControl(aggregate.replaceAll('\n', ''))).toBe(false);
    },
  );

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
  it.each([
    { name: 'real', dryRun: false },
    { name: 'dry', dryRun: true },
  ])(
    'keeps $name-run secret argv warnings on stderr and machine output intact',
    async ({ dryRun }) => {
      const secret = 'cli-argv-warning-secret';
      const path = fixture([
        'schemaVersion: 1',
        'product:',
        '  name: Example',
        '  version: "1.0.0"',
        'inputs:',
        '  token:',
        '    type: secret',
        'steps:',
        '  - id: inspect',
        '    run:',
        '      command: node',
        '      args: ["-e", "process.exit(0)", "${token}"]',
      ]);
      const io = capture();
      const args = [
        'run',
        path,
        '--non-interactive',
        '--set',
        `token=${secret}`,
        '--result',
        '-',
        ...(dryRun ? ['--dry-run'] : []),
      ];

      expect(await run(args, io)).toBe(0);

      expect(io.out).toHaveLength(1);
      expect(JSON.parse(io.out[0] ?? '')).toMatchObject({
        status: dryRun ? 'planned' : 'succeeded',
      });
      const warning = io.err.filter((line) => line.includes('OS process listings'));
      expect(warning).toHaveLength(1);
      expect(warning[0]).toContain('warning: steps[0].run.args[2]');
      expect(warning[0]).toContain('use env: instead');
      expect([...io.out, ...io.err].join('\n')).not.toContain(secret);
    },
  );

  it('escapes composed locale chrome and child output without forged lines', async () => {
    const childLine = 'child\r\u001b\u0085\u2028\u2029';
    const script = `process.stdout.write(${JSON.stringify(childLine)})`;
    const path = fixture([
      'schemaVersion: 1',
      'product:',
      '  name: Example',
      '  version: "1.0.0"',
      'steps:',
      '  - id: controlled',
      `    title: ${JSON.stringify('title\u001b')}`,
      '    run:',
      '      command: node',
      `      args: ${JSON.stringify(['-e', script])}`,
    ]);
    writeLocaleOverlay(path, [
      `rune.progress.output: ${JSON.stringify('chrome\u0007[{line}]\u007f')}`,
      `rune.progress.step: ${JSON.stringify('step\u009f {index}/{total}: {title}')}`,
    ]);
    const io = capture();

    expect(await run(['run', path, '--non-interactive', '--locale', 'de'], io)).toBe(0);

    expect(io.err).toContain(String.raw`chrome\u0007[child\r\u001b\u0085\u2028\u2029]\u007f`);
    expect(io.err).toContain(String.raw`step\u009f 1/1: title\u001b`);
    expect(io.err).toHaveLength(6);
    expect(io.err.some(hasRawTerminalControl)).toBe(false);
  });

  it('masks a normalized secret cwd in locale progress chrome', async () => {
    const relativeSecret = 'private/../secret-target';
    const path = fixture([
      'schemaVersion: 1',
      'product:',
      '  name: Example',
      '  version: "1.0.0"',
      'inputs:',
      '  workingDirectory:',
      '    type: secret',
      'steps:',
      '  - id: controlled',
      '    run:',
      '      command: node',
      '      args: ["-e", "process.exit(0)"]',
      '      cwd: "${workingDirectory}"',
    ]);
    const derivedSecret = resolve(path, '..', relativeSecret);
    mkdirSync(derivedSecret);
    writeLocaleOverlay(path, [`rune.progress.runStarted: ${JSON.stringify(derivedSecret)}`]);
    const io = capture();

    expect(
      await run(
        [
          'run',
          path,
          '--non-interactive',
          '--locale',
          'de',
          '--set',
          `workingDirectory=${relativeSecret}`,
        ],
        io,
      ),
    ).toBe(0);

    expect(io.err).toContain('***');
    expect(io.err.join('\n')).not.toContain(derivedSecret);
  });

  it('masks a derived secret in the result and suppresses unsafe terminal fallback', async () => {
    const relativeSecret = 'private/../setup.cmd';
    const path = fixture([
      'schemaVersion: 1',
      'product:',
      '  name: Example',
      '  version: "1.0.0"',
      'inputs:',
      '  workingDirectory:',
      '    type: secret',
      '  mirror:',
      '    type: text',
      'steps:',
      '  - id: derive',
      '    run:',
      '      command: node',
      '      cwd: "${workingDirectory}"',
      '  - id: fail',
      '    run:',
      '      command: "${mirror}"',
    ]);
    const derivedSecret = resolve(path, '..', relativeSecret);
    writeLocaleOverlay(path, [`rune.result.failed: ${JSON.stringify(derivedSecret)}`]);
    const io = capture();

    expect(
      await run(
        [
          'run',
          path,
          '--dry-run',
          '--non-interactive',
          '--platform',
          'windows',
          '--locale',
          'de',
          '--result',
          '-',
          '--set',
          `workingDirectory=${relativeSecret}`,
          '--set',
          `mirror=${derivedSecret}`,
        ],
        io,
      ),
    ).toBe(1);
    expect(io.out).toHaveLength(1);
    expect(JSON.parse(io.out[0] ?? '')).toMatchObject({
      status: 'failed',
      error: { code: 'RUNE-405' },
      inputs: [
        { id: 'workingDirectory', value: null, secret: true },
        { id: 'mirror', value: '***', secret: false },
      ],
    });
    expect([...io.out, ...io.err].join('\n')).not.toContain(derivedSecret);
  });

  it('keeps control-containing result JSON machine-readable', async () => {
    const controlled = 'value\u001b\u0085\u2028\u2029';
    const path = fixture([
      'schemaVersion: 1',
      'product:',
      '  name: Example',
      '  version: "1.0.0"',
      'inputs:',
      '  value:',
      '    type: text',
      'steps: []',
    ]);
    const io = capture();

    expect(
      await run(
        [
          'run',
          path,
          '--dry-run',
          '--non-interactive',
          '--set',
          `value=${controlled}`,
          '--result',
          '-',
        ],
        io,
      ),
    ).toBe(0);
    expect(io.out).toHaveLength(1);
    expect(JSON.parse(io.out[0] ?? '')).toMatchObject({ inputs: [{ value: controlled }] });
  });

  it('escapes plan chrome and substitutions without doubling safe JSON escapes', async () => {
    const path = fixture([
      'schemaVersion: 1',
      'product:',
      '  name: Example',
      '  version: "1.0.0"',
      'steps:',
      '  - id: controlled',
      `    title: ${JSON.stringify('title\u001b')}`,
      '    run:',
      '      command: node',
      `      args: ${JSON.stringify(['-e', 'literal\ntext'])}`,
    ]);
    writeLocaleOverlay(path, [`rune.plan.step: ${JSON.stringify('plan\u0085 {number}{title}')}`]);
    const io = capture();

    expect(await run(['run', path, '--dry-run', '--non-interactive', '--locale', 'de'], io)).toBe(
      0,
    );
    expect(io.out).toContain(String.raw`plan\u0085 1. title\u001b`);
    expect(io.out.join('\n')).toContain(String.raw`literal\ntext`);
    expect(io.out.join('\n')).not.toContain(String.raw`literal\\ntext`);
    expect(io.out.some(hasRawTerminalControl)).toBe(false);
  });

  it('remasks a control escape created while rendering a dry-run title', async () => {
    const renderedSecret = String.raw`\u001b`;
    const path = fixture([
      'schemaVersion: 1',
      'product:',
      '  name: Example',
      '  version: "1.0.0"',
      'inputs:',
      '  token:',
      '    type: secret',
      'steps:',
      '  - id: controlled',
      `    title: ${JSON.stringify('\u001b')}`,
      '    run:',
      '      command: node',
    ]);
    const io = capture();

    expect(
      await run(
        ['run', path, '--dry-run', '--non-interactive', '--set', `token=${renderedSecret}`],
        io,
      ),
    ).toBe(0);

    const output = [...io.out, ...io.err].join('\n');
    expect(output).toContain('***');
    expect(output).not.toContain(renderedSecret);
    expect([...io.out, ...io.err].some(hasRawTerminalControl)).toBe(false);
  });

  it('remasks live output and localized outcome lines after terminal escaping', async () => {
    const renderedSecret = String.raw`\u001b`;
    const script = 'process.stdout.write(String.fromCharCode(27))';
    const path = fixture([
      'schemaVersion: 1',
      'product:',
      '  name: Example',
      '  version: "1.0.0"',
      'inputs:',
      '  token:',
      '    type: secret',
      'steps:',
      '  - id: controlled',
      '    run:',
      '      command: node',
      `      args: ${JSON.stringify(['-e', script])}`,
    ]);
    writeLocaleOverlay(path, [
      `rune.result.succeeded: ${JSON.stringify('\u001b complete')}`,
      `rune.result.summary: ${JSON.stringify('\u001b {status}')}`,
      `rune.result.written: ${JSON.stringify('\u001b {path}')}`,
    ]);
    const resultPath = join(path, '..', 'terminal-result.json');
    const io = capture();

    expect(
      await run(
        [
          'run',
          path,
          '--non-interactive',
          '--locale',
          'de',
          '--set',
          `token=${renderedSecret}`,
          '--result',
          resultPath,
        ],
        io,
      ),
    ).toBe(0);

    const output = [...io.out, ...io.err].join('\n');
    expect(output).toContain('***');
    expect(output).not.toContain(renderedSecret);
    expect([...io.out, ...io.err].some(hasRawTerminalControl)).toBe(false);
    expect(JSON.parse(readFileSync(resultPath, 'utf8'))).toMatchObject({
      status: 'succeeded',
      inputs: [{ id: 'token', value: null, secret: true }],
    });
  });

  it('escapes the result-file announcement after composition', async () => {
    const path = fixture([
      'schemaVersion: 1',
      'product:',
      '  name: Example',
      '  version: "1.0.0"',
      'steps: []',
    ]);
    const resultPath = join(path, '..', 'result\u2029controlled.json');
    const io = capture();

    expect(await run(['run', path, '--non-interactive', '--result', resultPath], io)).toBe(0);
    expect(io.err).toContain(`result written to ${resultPath.replace('\u2029', '\\u2029')}`);
    expect(JSON.parse(readFileSync(resultPath, 'utf8'))).toMatchObject({ status: 'succeeded' });
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
    expect(empty.err).toContain(
      'succeeded: 0 succeeded, 0 failed, 0 skipped, 0 cancelled, 0 not run (exit 0)',
    );

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
    expect(failed.err).toContain(
      'failed: 0 succeeded, 1 failed, 0 skipped, 0 cancelled, 0 not run (exit 1)',
    );
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

  it('does not reconstruct a secret between a single issue location and message', async () => {
    const secret = '1: i';
    const path = fixture([
      'schemaVersion: 1',
      'product:',
      '  name: Example',
      '  version: "1.0.0"',
      'inputs:',
      '  masker:',
      '    type: secret',
      '    required: false',
      '  requiredInput:',
      '    type: text',
      'steps: []',
    ]);
    const resultPath = join(path, '..', 'result.json');
    const io = capture();

    const code = await run(
      ['run', path, '--non-interactive', '--result', resultPath, '--set', `masker=${secret}`],
      io,
    );

    expect(code).toBe(4);
    const stderr = io.err.join('\n');
    expect(stderr).toContain('***');
    expect(stderr).not.toContain(secret);

    const result = JSON.parse(readFileSync(resultPath, 'utf8')) as {
      readonly status: string;
      readonly error: {
        readonly message: string;
        readonly location: {
          readonly file: string;
          readonly line: number;
          readonly column: number;
        };
      };
      readonly inputs: readonly { readonly id: string; readonly value: unknown }[];
    };
    expect(result.status).toBe('input_error');
    expect(result.error.location).toBeNull();
    expect(result.error.message).not.toContain(secret);
    expect(result.inputs.find((input) => input.id === 'masker')?.value).toBeNull();
    expect(JSON.stringify(result)).not.toContain(secret);
  });

  it('reports an invalid seed with every missing input in stderr and the result', async () => {
    const secret = 'F090-OPEN-FAILURE-SECRET';
    const path = fixture([
      'schemaVersion: 1',
      'product:',
      '  name: Example',
      '  version: "1.0.0"',
      'inputs:',
      '  masker:',
      '    type: secret',
      '    required: false',
      '  invalidOptional:',
      '    type: text',
      '    required: false',
      '    pattern: "x+"',
      '  firstMissing:',
      '    type: text',
      '  secondMissing:',
      '    type: secret',
      'steps: []',
    ]);
    const resultPath = join(path, '..', 'result.json');
    const io = capture();

    const code = await run(
      [
        'run',
        path,
        '--non-interactive',
        '--result',
        resultPath,
        '--set',
        `masker=${secret}`,
        '--set',
        `invalidOptional=${secret}`,
      ],
      io,
    );

    expect(code).toBe(4);
    const stderr = io.err.join('\n');
    expect(stderr).toContain('invalidOptional (from --set invalidOptional=…)');
    for (const id of ['firstMissing', 'secondMissing']) {
      expect(stderr).toContain(
        `input "${id}" is required and has no value — supply it with --set ${id}=... | RUNE_INPUT_${id.toUpperCase()} | values-file key '${id}'`,
      );
    }
    expect(stderr).not.toContain(secret);

    const result = JSON.parse(readFileSync(resultPath, 'utf8')) as {
      readonly status: string;
      readonly error: { readonly code: string; readonly message: string };
    };
    expect(result.status).toBe('input_error');
    expect(result.error.code).toBe('RUNE-202');
    expect(result.error.message).toContain('invalidOptional (from --set invalidOptional=…)');
    expect(result.error.message).toContain('input "firstMissing" is required and has no value');
    expect(result.error.message).toContain('input "secondMissing" is required and has no value');
    expect(JSON.stringify(result)).not.toContain(secret);
  });

  it('does not reconstruct a multiline secret at an aggregate issue boundary', async () => {
    const path = fixture([
      'schemaVersion: 1',
      'product:',
      '  name: Example',
      '  version: "1.0.0"',
      'inputs:',
      '  masker:',
      '    type: secret',
      '    required: false',
      '  invalidOptional:',
      '    type: text',
      '    required: false',
      '    pattern: "x+"',
      '  firstMissing:',
      '    type: text',
      '  secondMissing:',
      '    type: text',
      'steps: []',
    ]);
    const locationPrefix = process.platform === 'win32' ? parse(path).root.slice(0, 2) : '/';
    const issueSuffix = process.platform === 'win32' ? '+' : 'x+';
    const secret = `${issueSuffix}\n${locationPrefix}`;
    const controlledCandidate = 'invalid\u001b\u0085';
    const resultPath = join(path, '..', 'result.json');
    const io = capture();

    const code = await run(
      [
        'run',
        path,
        '--non-interactive',
        '--result',
        resultPath,
        '--set',
        `masker=${secret}`,
        '--set',
        `invalidOptional=${controlledCandidate}`,
      ],
      io,
    );

    expect(code).toBe(4);
    const aggregate = io.err[0] ?? '';
    expect(aggregate).not.toContain(secret);
    expect(io.err.join('\n')).not.toContain(secret);
    expect(hasRawTerminalControl(aggregate.replaceAll('\n', ''))).toBe(false);
    expect(aggregate).toContain('\n');

    const resultText = readFileSync(resultPath, 'utf8');
    const resultStrings: string[] = [];
    const result = JSON.parse(resultText, (_key, value: unknown) => {
      if (typeof value === 'string') {
        resultStrings.push(value);
      }
      return value;
    }) as {
      readonly status: string;
      readonly error: { readonly message: string };
    };
    expect(result.status).toBe('input_error');
    expect(aggregate).toBe(result.error.message);
    expect(result.error.message).toContain('\n');
    expect(result.error.message).not.toContain(secret);
    expect(resultStrings.every((value) => !value.includes(secret))).toBe(true);
  });

  it('masks raw quote and backslash content across a location-message boundary', async () => {
    const path = fixture([
      'schemaVersion: 1',
      'product:',
      '  name: Example',
      '  version: "1.0.0"',
      'inputs:',
      '  masker:',
      '    type: secret',
      '    required: false',
      '  requiredInput:',
      '    type: text',
      'steps: []',
    ]);
    const controlledKey = `A"B\\C\u001bTAIL\u0085\u2028`;
    const secret = `1:1: "A"B\\C\u001b`;
    const visibleSecret = '1:1: "A\\"B\\\\C\\u001b';
    const valuesPath = join(path, '..', 'values.yaml');
    writeFileSync(valuesPath, `${JSON.stringify(controlledKey)}: value\n`, 'utf8');
    const resultPath = join(path, '..', 'result.json');
    const io = capture();

    const code = await run(
      [
        'run',
        path,
        '--non-interactive',
        '--values',
        valuesPath,
        '--result',
        resultPath,
        '--set',
        `masker=${secret}`,
      ],
      io,
    );

    expect(code).toBe(4);
    const stderr = io.err[0] ?? '';
    expect(stderr).not.toContain(secret);
    expect(stderr).not.toContain(visibleSecret);
    expect(hasRawTerminalControl(stderr.replaceAll('\n', ''))).toBe(false);
    expect(stderr).toContain('\n');

    const resultStrings: string[] = [];
    const result = JSON.parse(readFileSync(resultPath, 'utf8'), (_key, value: unknown) => {
      if (typeof value === 'string') {
        resultStrings.push(value);
      }
      return value;
    }) as {
      readonly status: string;
      readonly error: { readonly message: string };
    };
    expect(result.status).toBe('input_error');
    expect(stderr).toBe(result.error.message);
    expect(result.error.message).toContain('\n');
    expect(result.error.message).not.toContain(secret);
    expect(result.error.message).not.toContain(visibleSecret);
    expect(resultStrings.every((value) => !value.includes(secret))).toBe(true);
    expect(resultStrings.every((value) => !value.includes(visibleSecret))).toBe(true);
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

  it.each(['set', 'environment'] as const)(
    'does not expose a %s secret in an invalid --platform usage error',
    async (source) => {
      const secret = 'R9-F095-PLATFORM-SECRET';
      const path = fixture([
        'schemaVersion: 1',
        'product:',
        '  name: Example',
        '  version: "1.0.0"',
        'inputs:',
        '  token:',
        '    type: secret',
        'steps: []',
      ]);
      const resultPath = join(path, '..', `${source}-result.json`);
      const environmentName = 'RUNE_INPUT_TOKEN';
      const previousEnvironment = process.env[environmentName];
      if (source === 'environment') {
        process.env[environmentName] = secret;
      } else {
        delete process.env[environmentName];
      }
      const io = capture();

      try {
        expect(
          await run(
            [
              'run',
              path,
              '--dry-run',
              '--non-interactive',
              ...(source === 'set' ? ['--set', `token=${secret}`] : []),
              '--platform',
              secret,
              '--result',
              resultPath,
            ],
            io,
          ),
        ).toBe(2);
      } finally {
        if (previousEnvironment === undefined) {
          delete process.env[environmentName];
        } else {
          process.env[environmentName] = previousEnvironment;
        }
      }

      const output = [...io.out, ...io.err].join('\n');
      expect(io.err).toEqual(['--platform must be windows or linux']);
      expect(output).not.toContain(secret);
      expect(existsSync(resultPath)).toBe(false);
    },
  );

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

  it('rejects an explicit log file that collides with the result before touching either sink', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'rune-cli-colliding-output-'));
    const manifestPath = join(directory, 'installer.yaml');
    const destination = join(directory, 'run.json');
    const childMarker = join(directory, 'child-ran');
    const original = 'existing output\n';
    writeExecutionMarkerManifest(manifestPath, childMarker);
    writeFileSync(destination, original, 'utf8');
    const io = capture();

    expect(
      await run(
        [
          'run',
          manifestPath,
          '--non-interactive',
          '--log-file',
          destination,
          '--result',
          destination,
        ],
        io,
      ),
    ).toBe(2);

    expect(readFileSync(destination, 'utf8')).toBe(original);
    expect(existsSync(childMarker)).toBe(false);
    expect(io.out).toEqual([]);
    expect(io.err).toContain(
      '--result and the effective log file must use different paths for a real run',
    );
    expect(io.err.join('\n')).not.toContain('result written');
  });

  it('rejects a manifest log file that collides with the result before execution', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'rune-cli-manifest-colliding-output-'));
    const manifestPath = join(directory, 'installer.yaml');
    const destination = join(directory, 'run.json');
    const childMarker = join(directory, 'child-ran');
    const original = 'existing output\n';
    writeExecutionMarkerManifest(manifestPath, childMarker, ['execution:', '  logFile: run.json']);
    writeFileSync(destination, original, 'utf8');
    const io = capture();

    expect(await run(['run', manifestPath, '--non-interactive', '--result', destination], io)).toBe(
      2,
    );

    expect(readFileSync(destination, 'utf8')).toBe(original);
    expect(existsSync(childMarker)).toBe(false);
    expect(io.out).toEqual([]);
    expect(io.err).toContain(
      '--result and the effective log file must use different paths for a real run',
    );
    expect(io.err.join('\n')).not.toContain('result written');
  });

  it('rejects an absolute manifest log alias of the result before execution', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'rune-cli-absolute-log-alias-'));
    const manifestPath = join(directory, 'installer.yaml');
    const destination = join(directory, 'run.json');
    const aliasedLogPath = `${join(directory, 'sub')}/../run.json`;
    const childMarker = join(directory, 'child-ran');
    const original = 'existing output\n';
    writeExecutionMarkerManifest(manifestPath, childMarker, [
      'execution:',
      `  logFile: ${JSON.stringify(aliasedLogPath)}`,
    ]);
    writeFileSync(destination, original, 'utf8');
    const io = capture();

    expect(await run(['run', manifestPath, '--non-interactive', '--result', destination], io)).toBe(
      2,
    );

    expect(readFileSync(destination, 'utf8')).toBe(original);
    expect(existsSync(childMarker)).toBe(false);
    expect(io.out).toEqual([]);
    expect(io.err).toContain(
      '--result and the effective log file must use different paths for a real run',
    );
    expect(io.err.join('\n')).not.toContain('result written');
  });

  it.runIf(process.platform === 'win32')(
    'rejects a drive-unbound rooted manifest log alias of the result before execution',
    async () => {
      const directory = mkdtempSync(join(tmpdir(), 'rune-cli-rooted-log-alias-'));
      const manifestPath = join(directory, 'installer.yaml');
      const destination = join(directory, 'run.json');
      const driveUnboundLogPath = destination.slice(parse(destination).root.length - 1);
      const childMarker = join(directory, 'child-ran');
      const original = 'existing output\n';
      writeExecutionMarkerManifest(manifestPath, childMarker, [
        'execution:',
        `  logFile: ${JSON.stringify(driveUnboundLogPath)}`,
      ]);
      writeFileSync(destination, original, 'utf8');
      const io = capture();

      expect(
        await run(['run', manifestPath, '--non-interactive', '--result', destination], io),
      ).toBe(2);

      expect(readFileSync(destination, 'utf8')).toBe(original);
      expect(existsSync(childMarker)).toBe(false);
      expect(io.out).toEqual([]);
      expect(io.err).toContain(
        '--result and the effective log file must use different paths for a real run',
      );
      expect(io.err.join('\n')).not.toContain('result written');
    },
  );

  it.runIf(process.platform === 'win32')(
    'compares colliding output paths case-insensitively on Windows',
    async () => {
      const directory = mkdtempSync(join(tmpdir(), 'rune-cli-case-colliding-output-'));
      const manifestPath = join(directory, 'installer.yaml');
      const resultPath = join(directory, 'run.json');
      const logPath = join(directory, 'RUN.JSON');
      const childMarker = join(directory, 'child-ran');
      const original = 'existing output\n';
      writeExecutionMarkerManifest(manifestPath, childMarker);
      writeFileSync(resultPath, original, 'utf8');
      const io = capture();

      expect(
        await run(
          ['run', manifestPath, '--non-interactive', '--log-file', logPath, '--result', resultPath],
          io,
        ),
      ).toBe(2);

      expect(readFileSync(resultPath, 'utf8')).toBe(original);
      expect(existsSync(childMarker)).toBe(false);
    },
  );

  it.runIf(process.platform === 'win32')(
    'rejects namespaced local-drive aliases before touching either sink',
    async () => {
      const aliases: readonly [string, (path: string) => string][] = [
        ['namespaced', toNamespacedPath],
        ['drive-device', (path) => `\\\\.\\${path}`],
      ];

      for (const [aliasName, alias] of aliases) {
        const directory = mkdtempSync(join(tmpdir(), `rune-cli-${aliasName}-output-`));
        const manifestPath = join(directory, 'installer.yaml');
        const destination = join(directory, 'run.json');
        const childMarker = join(directory, 'child-ran');
        const original = 'existing output\n';
        writeExecutionMarkerManifest(manifestPath, childMarker);
        writeFileSync(destination, original, 'utf8');
        const io = capture();

        expect(
          await run(
            [
              'run',
              manifestPath,
              '--non-interactive',
              '--log-file',
              alias(destination),
              '--result',
              destination,
            ],
            io,
          ),
          aliasName,
        ).toBe(2);

        expect(readFileSync(destination, 'utf8'), aliasName).toBe(original);
        expect(existsSync(childMarker), aliasName).toBe(false);
        expect(io.out, aliasName).toEqual([]);
        expect(io.err, aliasName).toContain(
          '--result and the effective log file must use different paths for a real run',
        );
        expect(io.err.join('\n'), aliasName).not.toContain('result written');
      }
    },
  );

  it.runIf(process.platform === 'win32')(
    'treats ordinary and namespaced UNC sink paths as identical without filesystem access',
    () => {
      expect(
        sameSinkPath(
          String.raw`\\server\share\out\run.json`,
          String.raw`\\?\UNC\server\share\out\run.json`,
        ),
      ).toBe(true);
    },
  );

  it.runIf(process.platform === 'win32')(
    'does not treat non-ASCII device names as local-drive aliases',
    () => {
      const aliases = [
        [String.raw`\\.\K:\out`, String.raw`\\?\K:\out`],
        [String.raw`\\.\ſ:\out`, String.raw`\\?\ſ:\out`],
      ] as const;

      for (const [devicePath, namespacedPath] of aliases) {
        expect(sameSinkPath(devicePath, namespacedPath)).toBe(false);
      }
    },
  );

  it.runIf(process.platform === 'win32')(
    'keeps non-drive device namespace spellings distinct',
    () => {
      const aliases = [
        ['pipe', String.raw`\\.\pipe\rune`, String.raw`\\?\pipe\rune`],
        ['PhysicalDrive', String.raw`\\.\PhysicalDrive0`, String.raw`\\?\PhysicalDrive0`],
        [
          'GLOBALROOT',
          String.raw`\\.\GLOBALROOT\Device\HarddiskVolume1`,
          String.raw`\\?\GLOBALROOT\Device\HarddiskVolume1`,
        ],
        [
          'Volume',
          String.raw`\\.\Volume{12345678-1234-1234-1234-123456789abc}\out`,
          String.raw`\\?\Volume{12345678-1234-1234-1234-123456789abc}\out`,
        ],
      ] as const;

      for (const [name, devicePath, namespacedPath] of aliases) {
        expect(sameSinkPath(devicePath, namespacedPath), name).toBe(false);
      }
    },
  );

  it('allows a dry-run result to use the configured log path', async () => {
    const path = fixture([...MANIFEST, 'execution:', '  logFile: planned.json']);
    const destination = join(path, '..', 'planned.json');
    const io = capture();

    expect(
      await run(
        [
          'run',
          path,
          '--dry-run',
          '--non-interactive',
          '--set',
          'greeting=hello',
          '--result',
          destination,
        ],
        io,
      ),
    ).toBe(0);

    expect(JSON.parse(readFileSync(destination, 'utf8'))).toMatchObject({
      status: 'planned',
      dryRun: true,
    });
  });

  it('refuses --platform without --dry-run as a usage error', async () => {
    const path = fixture(MANIFEST);
    const io = capture();
    expect(await run(['run', path, '--non-interactive', '--platform', 'linux'], io)).toBe(2);
  });
});

describe('help and misuse', () => {
  it('describes run as guided or automated', async () => {
    const help = capture();

    expect(await run(['run', '--help'], help)).toBe(0);
    expect(help.err).toEqual([]);
    expect(help.out).toHaveLength(1);
    expect(help.out[0]).toContain('run a manifest — guided or automated');
  });

  it('exits 0 for requested help and 2 for a bare invocation', async () => {
    const help = capture();
    const bare = capture();

    expect(await run(['--help'], help)).toBe(0);
    expect(await run([], bare)).toBe(2);
    expect(help.err).toEqual([]);
    expect(help.out).toHaveLength(1);
    expect(help.out[0]).toMatch(/^Usage: rune/u);
    expect(help.out[0]).toContain('\nCommands:');
    expect(help.out[0]).not.toMatch(/\n$/u);
    expect(bare.out).toEqual([]);
    expect(bare.err).toHaveLength(1);
    expect(bare.err[0]).toMatch(/^Usage: rune/u);
    expect(bare.err[0]).toContain('\nCommands:');
  });

  it.each([
    ['the program', ['help'], 'Usage: rune '],
    ['one command', ['help', 'run'], 'Usage: rune run '],
  ])('exits 0 for help on %s requested through the verb', async (_name, argv, usage) => {
    const io = capture();

    expect(await run(argv, io)).toBe(0);

    // The page is requested output, so it belongs on stdout with the clean code (§10).
    // Commander carries that verdict in `exitCode`, not in the `commander.help` code the
    // verb shares with the bare invocation above, which prints to stderr and exits 2.
    expect(io.err).toEqual([]);
    expect(io.out).toHaveLength(1);
    expect(io.out[0]?.startsWith(usage)).toBe(true);
  });

  it('keeps the help and misuse codes under a non-zero ambient exit code', async () => {
    const help = capture();
    const bare = capture();
    const original = process.exitCode;
    // `Command.help()` derives its own exit code from this global, so a host that already set
    // one — main.ts assigns it, and so does any embedder — must not change what RUNE reports.
    process.exitCode = 3;

    try {
      expect(await run(['help'], help)).toBe(0);
      expect(await run([], bare)).toBe(2);
    } finally {
      process.exitCode = original;
    }

    expect(help.err).toEqual([]);
    expect(help.out).toHaveLength(1);
    expect(bare.out).toEqual([]);
    expect(bare.err).toHaveLength(1);
  });
});

describe('result files for failed outcomes', () => {
  it('anchors a relative manifest path in an early config-error result', async () => {
    const invocationDirectory = mkdtempSync(join(tmpdir(), 'rune-cli-relative-manifest-'));
    const laterDirectory = mkdtempSync(join(tmpdir(), 'rune-cli-relative-manifest-later-'));
    const manifestArgument = 'installer.yaml';
    const manifestPath = join(invocationDirectory, manifestArgument);
    const resultPath = join(invocationDirectory, 'result.json');
    const originalDirectory = process.cwd();
    writeFileSync(manifestPath, 'schemaVersion: 1\nproduct:\n  name: X\n', 'utf8');

    try {
      process.chdir(invocationDirectory);
      const expectedManifestPath = resolve(manifestArgument);
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

      expect(
        await run(['run', manifestArgument, '--non-interactive', '--result', resultPath], io),
      ).toBe(3);

      const result = JSON.parse(readFileSync(resultPath, 'utf8')) as Record<string, unknown>;
      expect(changedDirectory).toBe(true);
      expect((result['manifest'] as Record<string, unknown>)['path']).toBe(expectedManifestPath);

      const location = (result['error'] as Record<string, unknown>)['location'];
      if (location !== null) {
        expect((location as Record<string, unknown>)['file']).toBe(expectedManifestPath);
      }
    } finally {
      process.chdir(originalDirectory);
      rmSync(invocationDirectory, { recursive: true, force: true });
      rmSync(laterDirectory, { recursive: true, force: true });
    }
  });

  it('writes the explicit canonical locale in an invalid-manifest result', async () => {
    const path = fixture(['schemaVersion: 1', 'product:', '  name: X']);
    const resultPath = join(path, '..', 'result.json');
    const io = capture();

    expect(
      await run(
        ['run', path, '--non-interactive', '--locale', 'de_DE', '--result', resultPath],
        io,
      ),
    ).toBe(3);
    const written = JSON.parse(readFileSync(resultPath, 'utf8')) as Record<string, unknown>;
    expect(written['status']).toBe('config_error');
    expect(written['exitCode']).toBe(3);
    expect(written).toMatchObject({
      mode: 'non-interactive',
      product: null,
      locale: 'de-DE',
      manifest: { path, sha256: null, schemaVersion: null },
    });
    expect(io.err).toContain(`result written to ${resultPath}`);
    expect(io.err).toContain(
      'config_error: 0 succeeded, 0 failed, 0 skipped, 0 cancelled, 0 not run (exit 3)',
    );
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
    const summary =
      'input_error: 0 succeeded, 0 failed, 0 skipped, 0 cancelled, 0 not run (exit 4)';
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

  it.each(['set', 'environment', 'values'] as const)(
    'masks %s-layer secrets in an invalid selected-overlay CLI outcome',
    async (source) => {
      const path = fixture([
        'schemaVersion: 1',
        'product:',
        '  name: Example',
        '  version: "1.0.0"',
        'inputs:',
        '  overlaySecret:',
        '    type: secret',
        '  summarySecret:',
        '    type: secret',
        'steps: []',
      ]);
      const resultPath = join(path, '..', `${source}-overlay-failure.json`);
      const overlaySecret = `result written to ${resultPath}`;
      const summarySecret =
        'config_error: 0 succeeded, 0 failed, 0 skipped, 0 cancelled, 0 not run (exit 3)';
      writeLocaleOverlay(path, [`${JSON.stringify(overlaySecret)}: Unbekannt`]);
      if (source === 'values') {
        writeFileSync(
          join(path, '..', 'values.yaml'),
          [
            `overlaySecret: ${JSON.stringify(overlaySecret)}`,
            `summarySecret: ${JSON.stringify(summarySecret)}`,
            '',
          ].join('\n'),
          'utf8',
        );
      }

      const environmentName = 'RUNE_INPUT_OVERLAYSECRET';
      const summaryEnvironmentName = 'RUNE_INPUT_SUMMARYSECRET';
      const previousEnvironment = process.env[environmentName];
      const previousSummaryEnvironment = process.env[summaryEnvironmentName];
      if (source === 'environment') {
        process.env[environmentName] = overlaySecret;
        process.env[summaryEnvironmentName] = summarySecret;
      } else {
        delete process.env[environmentName];
        delete process.env[summaryEnvironmentName];
      }
      const io = capture();
      const args = [
        'run',
        path,
        '--non-interactive',
        '--locale',
        'de',
        '--result',
        resultPath,
        ...(source === 'set'
          ? ['--set', `overlaySecret=${overlaySecret}`, '--set', `summarySecret=${summarySecret}`]
          : []),
        ...(source === 'values' ? ['--values', join(path, '..', 'values.yaml')] : []),
      ];

      try {
        expect(await run(args, io)).toBe(3);
      } finally {
        if (previousEnvironment === undefined) {
          delete process.env[environmentName];
        } else {
          process.env[environmentName] = previousEnvironment;
        }
        if (previousSummaryEnvironment === undefined) {
          delete process.env[summaryEnvironmentName];
        } else {
          process.env[summaryEnvironmentName] = previousSummaryEnvironment;
        }
      }

      const output = [...io.err, ...io.out].join('\n');
      expect(output).not.toContain(overlaySecret);
      expect(output).not.toContain(summarySecret);
      expect(io.out).toEqual([]);
      const written = JSON.parse(readFileSync(resultPath, 'utf8')) as Record<string, unknown>;
      expect(written).toMatchObject({
        status: 'config_error',
        exitCode: 3,
        error: { code: 'RUNE-104' },
      });
      expect(JSON.stringify(written)).not.toContain(overlaySecret);
      expect(JSON.stringify(written)).not.toContain(summarySecret);
    },
  );

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

  it('preserves post-open context and suppresses fallback after plan failure', async () => {
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
    expect(warnings).toHaveLength(0);
    expect(io.err.join('\n')).not.toContain('result written to');
    expect(io.err.join('\n')).not.toContain('resolution_error:');
    expect(io.err.join('\n')).not.toContain('warning: nothing was executed');
  });

  it('suppresses the result path announcement after failed planning', async () => {
    const relativeSecret = 'private/../failed-plan-result.json';
    const path = fixture([
      'schemaVersion: 1',
      'product:',
      '  name: Example',
      '  version: "1.0.0"',
      'inputs:',
      '  workingDirectory:',
      '    type: secret',
      'steps:',
      '  - id: derive',
      '    run:',
      '      command: node',
      '      cwd: "${workingDirectory}"',
      '  - id: fail',
      '    run:',
      '      command: setup.cmd',
    ]);
    const resultPath = resolve(path, '..', relativeSecret);
    writeLocaleOverlay(path, [`rune.result.failed: ${JSON.stringify(resultPath)}`]);
    const io = capture();

    expect(
      await run(
        [
          'run',
          path,
          '--dry-run',
          '--non-interactive',
          '--platform',
          'windows',
          '--locale',
          'de',
          '--result',
          resultPath,
          '--set',
          `workingDirectory=${relativeSecret}`,
        ],
        io,
      ),
    ).toBe(1);

    expect(JSON.parse(readFileSync(resultPath, 'utf8'))).toMatchObject({
      status: 'failed',
      error: { code: 'RUNE-405' },
    });
    expect(io.err.join('\n')).not.toContain(resultPath);
    expect(io.err.join('\n')).not.toContain('result written to');
  });

  it('uses a path-free delivery failure after failed planning', async () => {
    const relativeSecret = 'private/../failed-plan-result-dir';
    const path = fixture([
      'schemaVersion: 1',
      'product:',
      '  name: Example',
      '  version: "1.0.0"',
      'inputs:',
      '  workingDirectory:',
      '    type: secret',
      'steps:',
      '  - id: derive',
      '    run:',
      '      command: node',
      '      cwd: "${workingDirectory}"',
      '  - id: fail',
      '    run:',
      '      command: setup.cmd',
    ]);
    const resultPath = resolve(path, '..', relativeSecret);
    mkdirSync(resultPath);
    writeLocaleOverlay(path, [`rune.result.failed: ${JSON.stringify(resultPath)}`]);
    const io = capture();

    expect(
      await run(
        [
          'run',
          path,
          '--dry-run',
          '--non-interactive',
          '--platform',
          'windows',
          '--locale',
          'de',
          '--result',
          resultPath,
          '--set',
          `workingDirectory=${relativeSecret}`,
        ],
        io,
      ),
    ).toBe(1);

    expect(io.err).toContain('could not write the result file');
    expect(io.err.join('\n')).not.toContain(resultPath);
    expect(io.err.join('\n')).not.toContain('result written to');
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
      '  ignoredInput:',
      '    type: text',
      '    when: "${enabled}"',
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
    writeLocaleOverlay(path, ['rune.result.failed: completed plan failure']);
    const io = capture();

    const code = await run(
      [
        'run',
        path,
        '--non-interactive',
        '--locale',
        'de',
        '--set',
        'ignoredInput=discarded',
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
    expect(io.err).toContain('completed plan failure');
    expect(io.err.filter((line) => line.includes('ignoredInput was set'))).toHaveLength(1);
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
    expect(io.out).toHaveLength(1);
    expect(io.err).toEqual([]);
    expect(io.out[0]).not.toContain('\n');
    expect(io.out.join('\n')).toMatch(/rune .*engine /);
  });
});
