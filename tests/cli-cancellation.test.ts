import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import { CancelToken, type RunResult } from '@rune/engine';
import { run, type CliIo } from '@rune/cli';
import { runResultSchema } from '../packages/engine/src/results/schema.js';
import { CLI_CANCELLATION_SIGNALS, createSignalController } from '../packages/cli/src/signals.js';

interface Capture extends CliIo {
  readonly out: string[];
  readonly err: string[];
}

describe('CLI cancellation control', () => {
  it('cancels cooperatively on the first signal and force-exits once on the second', () => {
    const cancel = new CancelToken();
    const forceExit = vi.fn<(code: number) => void>();
    const controller = createSignalController(cancel, forceExit);

    expect(CLI_CANCELLATION_SIGNALS).toEqual(['SIGINT', 'SIGTERM']);
    controller.handle();
    expect(cancel.cancelled).toBe(true);
    expect(forceExit).not.toHaveBeenCalled();

    controller.handle();
    controller.handle();
    expect(forceExit).toHaveBeenCalledTimes(1);
    expect(forceExit).toHaveBeenCalledWith(6);
  });

  it('cancels a running child through the engine and writes the completed topology', async () => {
    const cancel = new CancelToken();
    const manifestPath = fixture([
      'schemaVersion: 1',
      'product:',
      '  name: Example',
      '  version: "1.0.0"',
      'steps:',
      '  - id: running',
      '    run:',
      '      command: node',
      `      args: ["-e", "console.log('READY'); setInterval(() => {}, 1000)"]`,
      '  - id: after',
      '    run:',
      '      command: node',
      '      args: ["-e", ""]',
    ]);
    const resultPath = join(manifestPath, '..', 'cancelled.json');
    const io = capture((line) => {
      if (line === '  READY') {
        cancel.cancel();
      }
    });

    const code = await run(['run', manifestPath, '--non-interactive', '--result', resultPath], io, {
      cancel,
    });

    expect(code).toBe(6);
    const result = JSON.parse(readFileSync(resultPath, 'utf8')) as RunResult;
    expect(() => runResultSchema.parse(result)).not.toThrow();
    expect(result).toMatchObject({
      status: 'cancelled',
      exitCode: 6,
      dryRun: false,
      stepsTotal: 2,
      stepsExecuted: 1,
      stepsCancelled: 1,
      stepsNotRun: 1,
      steps: [
        { id: 'running', state: 'CANCELLED' },
        { id: 'after', state: 'NOT_RUN' },
      ],
    });
  }, 15_000);

  it('writes a cancelled dry-run result when the token was already cancelled', async () => {
    const cancel = new CancelToken();
    cancel.cancel();
    const manifestPath = fixture([
      'schemaVersion: 1',
      'product:',
      '  name: Example',
      '  version: "1.0.0"',
      'inputs:',
      '  enabled:',
      '    type: boolean',
      '    default: false',
      'steps:',
      '  - id: skipped',
      '    when: "${enabled}"',
      '    run:',
      '      command: never-runs',
      '  - id: pending',
      '    run:',
      '      command: node',
    ]);
    const resultPath = join(manifestPath, '..', 'cancelled-preview.json');
    const io = capture();

    const code = await run(
      ['run', manifestPath, '--dry-run', '--non-interactive', '--result', resultPath],
      io,
      { cancel },
    );

    expect(code).toBe(6);
    expect(io.out).toEqual([]);
    const result = JSON.parse(readFileSync(resultPath, 'utf8')) as RunResult;
    expect(() => runResultSchema.parse(result)).not.toThrow();
    expect(result).toMatchObject({
      status: 'cancelled',
      exitCode: 6,
      dryRun: true,
      stepsExecuted: 0,
      stepsSkipped: 1,
      stepsNotRun: 1,
      nothingExecuted: true,
      steps: [
        { id: 'skipped', state: 'SKIPPED', command: null },
        { id: 'pending', state: 'PENDING', command: ['node'] },
      ],
    });
  });

  it('keeps calls without a control context compatible', async () => {
    const manifestPath = fixture(MINIMAL_MANIFEST);
    const io = capture();

    expect(await run(['run', manifestPath, '--dry-run', '--non-interactive'], io)).toBe(0);
    expect(io.out.join('\n')).toContain('Execution plan v1');
  });
});

const MINIMAL_MANIFEST = [
  'schemaVersion: 1',
  'product:',
  '  name: Example',
  '  version: "1.0.0"',
  'steps:',
  '  - id: noop',
  '    run:',
  '      command: node',
];

function capture(onStderr?: (line: string) => void): Capture {
  const out: string[] = [];
  const err: string[] = [];
  return {
    out,
    err,
    stdout: (line) => out.push(line),
    stderr: (line) => {
      err.push(line);
      onStderr?.(line);
    },
  };
}

function fixture(lines: readonly string[]): string {
  const dir = mkdtempSync(join(tmpdir(), 'rune-cli-cancel-'));
  const path = join(dir, 'installer.yaml');
  writeFileSync(path, [...lines, ''].join('\n'), 'utf8');
  return path;
}
