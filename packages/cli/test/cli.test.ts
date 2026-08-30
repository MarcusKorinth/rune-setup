import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
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

  it('exits 3 for an invalid manifest', async () => {
    const path = fixture(['schemaVersion: 1', 'product:', '  name: X']);
    const io = capture();
    expect(await run(['validate', path], io)).toBe(3);
    expect(io.err.join('\n')).toContain('product');
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
});

describe('rune --version', () => {
  it('prints its own version and the engine version', async () => {
    const io = capture();
    expect(await run(['--version'], io)).toBe(0);
    expect(io.out.join('\n')).toMatch(/rune .*engine /);
  });
});
