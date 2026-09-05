import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { serializeResult, Session, type RunResult } from '@rune/engine';
import { afterEach, describe, expect, it, vi } from 'vitest';

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
  const directory = mkdtempSync(join(tmpdir(), 'rune-cli-result-stdout-'));
  const manifestPath = join(directory, 'installer.yaml');
  writeFileSync(manifestPath, [...lines, ''].join('\n'), 'utf8');
  return manifestPath;
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

const SECRET_MANIFEST = [
  'schemaVersion: 1',
  'product:',
  '  name: Example',
  '  version: "1.0.0"',
  'inputs:',
  '  token:',
  '    type: secret',
  'steps:',
  '  - id: use-token',
  '    run:',
  '      command: node',
  '      args: ["-e", ""]',
];

/** Pins member order while neutralizing the fields that differ between two runs. */
function normalized(result: Record<string, unknown>): string {
  const copy = JSON.parse(JSON.stringify(result)) as Record<string, unknown> & {
    steps: Array<Record<string, unknown>>;
  };
  copy['id'] = 'id';
  copy['startedAt'] = 'startedAt';
  copy['finishedAt'] = 'finishedAt';
  copy['durationMs'] = 0;
  for (const step of copy.steps) {
    step['durationMs'] = 0;
  }
  return JSON.stringify(copy, null, 2);
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('--result - shares the file sink serialization', () => {
  it('prints the validated text with the member order of the result file', async () => {
    const manifestPath = fixture(MANIFEST);
    const resultPath = join(manifestPath, '..', 'result.json');
    const stdoutIo = capture();
    const fileIo = capture();

    expect(
      await run(
        ['run', manifestPath, '--non-interactive', '--set', 'greeting=hello', '--result', '-'],
        stdoutIo,
      ),
    ).toBe(0);
    expect(
      await run(
        [
          'run',
          manifestPath,
          '--non-interactive',
          '--set',
          'greeting=hello',
          '--result',
          resultPath,
        ],
        fileIo,
      ),
    ).toBe(0);

    expect(stdoutIo.out).toHaveLength(1);
    const printed = `${stdoutIo.out[0]}\n`;
    const written = readFileSync(resultPath, 'utf8');
    const fromStdout = JSON.parse(printed) as Record<string, unknown>;
    const fromFile = JSON.parse(written) as Record<string, unknown>;

    expect(Object.keys(fromStdout)).toEqual(Object.keys(fromFile));
    expect(normalized(fromStdout)).toBe(normalized(fromFile));
    expect(printed).toBe(serializeResult(fromStdout as unknown as RunResult));
    expect(written).toBe(serializeResult(fromFile as unknown as RunResult));
  });

  it('fails closed on a forged plaintext secret before anything reaches stdout', async () => {
    const plaintext = 'PLAINTEXT-LEAK-s3cr3t-forged';
    const manifestPath = fixture(SECRET_MANIFEST);
    const execute = Session.prototype.execute;
    vi.spyOn(Session.prototype, 'execute').mockImplementation(async function (
      this: Session,
      ...args: Parameters<Session['execute']>
    ) {
      const real = await execute.apply(this, args);
      return {
        ...real,
        inputs: [{ id: 'token', value: plaintext, source: 'set', secret: true, enabled: true }],
      } as unknown as RunResult;
    });
    const io = capture();

    const code = await run(
      [
        'run',
        manifestPath,
        '--non-interactive',
        '--set',
        'token=real-secret-value',
        '--result',
        '-',
      ],
      io,
    );

    expect(code).toBe(70);
    expect(io.out).toEqual([]);
    expect(io.err.join('\n')).toContain('the run result does not match resultSchemaVersion 2');
    expect([...io.out, ...io.err].join('\n')).not.toContain(plaintext);
  });
});
