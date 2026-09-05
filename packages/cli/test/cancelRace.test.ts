import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { CancelToken, resultJsonSchema, type RunResult } from '@rune/engine';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { run, type CliIo } from '../src/cli.js';

interface Capture extends CliIo {
  readonly out: string[];
  readonly err: string[];
}

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
  const dir = mkdtempSync(join(tmpdir(), 'rune-cli-cancel-race-'));
  const path = join(dir, 'installer.yaml');
  writeFileSync(path, [...lines, ''].join('\n'), 'utf8');
  return path;
}

describe('CLI cancellation that races the step process', () => {
  it('ends cancelled with exit 6 when the child ends on its own as the first signal arrives', async () => {
    // The step child leaves with a non-success code the moment its READY line is out, and
    // the token is cancelled on that line: on Windows this is what a console Ctrl+C does to a
    // console-attached child, and the tree-kill helper then finds nothing to terminate.
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
      `      args: ["-e", "process.stdout.write('READY' + String.fromCharCode(10), () => process.exit(3221225786))"]`,
      '  - id: after',
      '    run:',
      '      command: node',
      '      args: ["-e", ""]',
    ]);
    const resultPath = join(manifestPath, '..', 'result.json');
    const io = capture((line) => {
      if (line === '  READY') {
        cancel.cancel();
      }
    });

    const code = await run(['run', manifestPath, '--non-interactive', '--result', resultPath], io, {
      cancel,
    });

    expect(code).toBe(6);
    expect(io.err).toContain('  READY');
    expect(io.err).toContain(
      'cancelled: 0 succeeded, 0 failed, 0 skipped, 1 cancelled, 1 not run (exit 6)',
    );
    expect(io.err.join('\n')).not.toContain('RUNE-401');
    const result = JSON.parse(readFileSync(resultPath, 'utf8')) as RunResult;
    const validator = z.fromJSONSchema(
      resultJsonSchema() as Parameters<typeof z.fromJSONSchema>[0],
    );
    expect(validator.safeParse(result).success).toBe(true);
    expect(result).toMatchObject({
      status: 'cancelled',
      exitCode: 6,
      dryRun: false,
      stepsTotal: 2,
      stepsExecuted: 1,
      stepsFailed: 0,
      stepsCancelled: 1,
      stepsNotRun: 1,
      steps: [
        { id: 'running', state: 'CANCELLED', exitCode: null },
        { id: 'after', state: 'NOT_RUN' },
      ],
    });
  }, 30_000);
});
