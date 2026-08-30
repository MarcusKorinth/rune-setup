import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';

import { describe, expect, it } from 'vitest';

import { run } from '../src/cli.js';
import type { CliIo } from '../src/io.js';
import type { Interaction } from '../src/prompt.js';

interface Capture extends CliIo {
  readonly out: string[];
  readonly err: string[];
}

function capture(): Capture {
  const out: string[] = [];
  const err: string[] = [];
  return { out, err, stdout: (line) => out.push(line), stderr: (line) => err.push(line) };
}

/**
 * A TTY-like interaction whose answers are scripted: the next answer is typed only after a
 * question prompt appears, the way a person answers — pre-buffered lines would race
 * readline's eager consumption.
 */
function scripted(answers: readonly string[]): Interaction & { transcript: () => string } {
  const input = new PassThrough();
  const queue = [...answers];
  const written: string[] = [];
  return {
    input,
    isTTY: true,
    write: (text) => {
      written.push(text);
      if (text.endsWith(': ')) {
        setImmediate(() => {
          const next = queue.shift();
          if (next !== undefined) {
            input.write(`${next}\n`);
          }
        });
      }
    },
    forceExit: () => undefined,
    transcript: () => written.join(''),
  };
}

function fixture(lines: readonly string[]): string {
  const dir = mkdtempSync(join(tmpdir(), 'rune-interactive-'));
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
  '  token:',
  '    type: secret',
  'steps:',
  '  - id: hello',
  '    run:',
  '      command: node',
  '      args: ["-e", "console.log(process.argv[1])", "${greeting}"]',
];

describe('the interactive run', { timeout: 15_000 }, () => {
  it('prompts for pending inputs, shows the summary, and runs on proceed', async () => {
    const path = fixture(MANIFEST);
    const io = capture();
    const interaction = scripted(['hello', 'super-secret-value', 'p']);

    const code = await run(['run', path, '--result', '-'], io, interaction);

    expect(code).toBe(0);
    const result = JSON.parse(io.out.join('\n')) as {
      status: string;
      mode: string;
      inputs: readonly { id: string; value: unknown }[];
    };
    expect(result.status).toBe('succeeded');
    expect(result.mode).toBe('interactive');
    expect(result.inputs.find((input) => input.id === 'token')?.value).toBeNull();
    expect(interaction.transcript()).toContain('greeting');
    // The muted echo: the typed secret never appears on the prompt stream.
    expect(interaction.transcript()).not.toContain('super-secret-value');
    expect(io.out.join('\n')).not.toContain('super-secret-value');
  });

  it('re-prompts on a pattern mismatch, showing the hint', async () => {
    const path = fixture([
      'schemaVersion: 1',
      'product:',
      '  name: Example',
      '  version: "1.0.0"',
      'inputs:',
      '  name:',
      '    type: text',
      '    pattern: "[a-z]+"',
      '    patternHint: lower-case letters only',
      'steps:',
      '  - id: a',
      '    run:',
      '      command: node',
      '      args: ["-e", "0"]',
    ]);
    const io = capture();
    const interaction = scripted(['BAD1', 'good', 'p']);

    const code = await run(['run', path], io, interaction);

    expect(code).toBe(0);
    expect(interaction.transcript()).toContain('lower-case letters only');
  });

  it('prompts for an invalid seeded value and succeeds after correction', async () => {
    const path = fixture([
      'schemaVersion: 1',
      'product:',
      '  name: Example',
      '  version: "1.0.0"',
      'inputs:',
      '  name:',
      '    type: text',
      '    default: BAD1',
      '    pattern: "[a-z]+"',
      '    patternHint: lower-case letters only',
      'steps:',
      '  - id: a',
      '    run:',
      '      command: node',
      '      args: ["-e", "0"]',
    ]);
    const io = capture();
    const interaction = scripted(['good', 'p']);

    const code = await run(['run', path], io, interaction);

    expect(code).toBe(0);
    expect(interaction.transcript()).toContain('name');
    expect(io.err.join('\n')).toContain('name = good');
  });

  it('lets the summary edit a value, then prompts and re-renders', async () => {
    const path = fixture(MANIFEST);
    const io = capture();
    const interaction = scripted(['hello', 'super-secret-value', '1', 'bye', 'p']);

    const code = await run(['run', path], io, interaction);

    expect(code).toBe(0);
    expect(io.err.join('\n')).toContain('bye');
  });

  it('cancels from the summary with exit 6 and a cancelled result', async () => {
    const path = fixture(MANIFEST);
    const resultPath = join(path, '..', 'result.json');
    const io = capture();
    const interaction = scripted(['hello', 'super-secret-value', 'c']);

    const code = await run(['run', path, '--result', resultPath], io, interaction);

    expect(code).toBe(6);
    const written = JSON.parse(readFileSync(resultPath, 'utf8')) as {
      status: string;
      mode: string;
      stepsTotal: number;
      stepsNotRun: number;
      steps: readonly { state: string }[];
      inputs: readonly { id: string }[];
    };
    expect(written.status).toBe('cancelled');
    expect(written.mode).toBe('interactive');
    // A plan existed at the summary, so the result reports it: all steps NOT_RUN (§10).
    expect(written.stepsTotal).toBe(1);
    expect(written.stepsNotRun).toBe(1);
    expect(written.steps.map((step) => step.state)).toEqual(['NOT_RUN']);
    expect(written.inputs.map((input) => input.id)).toEqual(['greeting', 'token']);
  });

  it('degrades to non-interactive without a TTY and records that mode', async () => {
    const path = fixture(MANIFEST);
    const io = capture();
    const interaction = scripted([]);
    const noTty = { ...interaction, isTTY: false };

    const code = await run(
      ['run', path, '--set', 'greeting=hi', '--set', 'token=super-secret-value', '--result', '-'],
      io,
      noTty,
    );

    expect(code).toBe(0);
    const result = JSON.parse(io.out.join('\n')) as Record<string, unknown>;
    expect(result['mode']).toBe('non-interactive');
  });
});
