import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Writable } from 'node:stream';

import { CancelToken, resultJsonSchema, type RunResult } from '@rune/engine';
import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

import { bootstrap } from '../src/bootstrap.js';

/** The one line §10 allows for a lost stdout sink — never the stream error itself. */
const LOST_STDOUT_LINE = 'could not write the requested machine output to stdout';

function systemError(code: string, message: string): NodeJS.ErrnoException {
  return Object.assign(new Error(`${code}: ${message}, write`), { code, syscall: 'write' });
}

/** A sink that fails the write itself, so the loss is known while the run is still in flight. */
function immediatelyFailingSink(error: Error): Writable {
  return new Writable({
    write() {
      throw error;
    },
  });
}

/** A sink whose writes fail through their callback, after the write call returned. */
function failingSink(error: Error): Writable {
  return new Writable({
    write(_chunk: Buffer, _encoding, callback) {
      callback(error);
    },
  });
}

function capturingSink(): { readonly stream: Writable; readonly text: () => string } {
  const chunks: string[] = [];
  const stream = new Writable({
    write(chunk: Buffer, _encoding, callback) {
      chunks.push(chunk.toString());
      callback();
    },
  });
  return { stream, text: () => chunks.join('') };
}

const settled = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

/**
 * A dry run with a result file: the one argv shape in which requested stdout output (the plan)
 * and a delivered result file coexist, so the §10 override can leave a written file behind.
 */
function dryRunFixture(): { readonly manifestPath: string; readonly resultPath: string } {
  const dir = mkdtempSync(join(tmpdir(), 'rune-bootstrap-'));
  const manifestPath = join(dir, 'installer.yaml');
  writeFileSync(
    manifestPath,
    [
      'schemaVersion: 1',
      'product:',
      '  name: Example',
      '  version: "1.0.0"',
      'steps:',
      '  - id: only',
      '    run:',
      '      command: node',
      '      args: ["-e", ""]',
      '',
    ].join('\n'),
    'utf8',
  );
  return { manifestPath, resultPath: join(dir, 'result.json') };
}

/** Reads the delivered result file and checks it against the generated schema (§14). */
function deliveredResult(path: string): RunResult {
  const result = JSON.parse(readFileSync(path, 'utf8')) as RunResult;
  const validator = z.fromJSONSchema(resultJsonSchema() as Parameters<typeof z.fromJSONSchema>[0]);
  expect(validator.safeParse(result).success).toBe(true);
  return result;
}

function countLines(text: string, line: string): number {
  return text.split('\n').filter((entry) => entry === line).length;
}

describe('CLI bootstrap: guarded process streams and the effective exit code', () => {
  it('exits 70 with one fixed line when requested stdout output is lost', async () => {
    const stderr = capturingSink();
    const setExitCode = vi.fn();

    const code = await bootstrap(
      ['schema'],
      {
        stdout: immediatelyFailingSink(systemError('ENOSPC', 'no space left on device')),
        stderr: stderr.stream,
      },
      { setExitCode, control: {} },
    );

    expect(code).toBe(70);
    expect(stderr.text()).toBe(`${LOST_STDOUT_LINE}\n`);
    expect(setExitCode).toHaveBeenCalledTimes(1);
    expect(setExitCode).toHaveBeenCalledWith(70);
  });

  it('reports a stdout loss that surfaces only after the run resolved', async () => {
    const stderr = capturingSink();
    const setExitCode = vi.fn();

    // `rune schema` writes its machine output last, so the sink reports the loss after the
    // run has already returned its own code: the hook, not the returned value, owns exit 70.
    const code = await bootstrap(
      ['schema'],
      {
        stdout: failingSink(systemError('ENOSPC', 'no space left on device')),
        stderr: stderr.stream,
      },
      { setExitCode, control: {} },
    );
    await settled();

    expect(code).toBe(0);
    expect(setExitCode).toHaveBeenCalledTimes(1);
    expect(setExitCode).toHaveBeenCalledWith(70);
    expect(stderr.text()).toBe(`${LOST_STDOUT_LINE}\n`);
  });

  it('keeps the run exit code when the stdout consumer went away', async () => {
    const stderr = capturingSink();
    const setExitCode = vi.fn();

    const code = await bootstrap(
      ['schema'],
      { stdout: failingSink(systemError('EPIPE', 'broken pipe')), stderr: stderr.stream },
      { setExitCode, control: {} },
    );
    await settled();

    expect(code).toBe(0);
    expect(stderr.text()).toBe('');
    expect(setExitCode).not.toHaveBeenCalled();
  });

  it('writes the result file and still exits 70 when the plan is lost to a stdout error', async () => {
    const { manifestPath, resultPath } = dryRunFixture();
    const stderr = capturingSink();
    const setExitCode = vi.fn();

    const code = await bootstrap(
      ['run', manifestPath, '--non-interactive', '--dry-run', '--result', resultPath],
      {
        stdout: failingSink(systemError('ENOSPC', 'no space left on device')),
        stderr: stderr.stream,
      },
      { setExitCode, control: {} },
    );
    await settled();

    // The one documented disagreement: the delivered file keeps the run's own status while the
    // process reports the lost machine output (§10, invariant 9).
    expect(code).toBe(70);
    expect(setExitCode).toHaveBeenCalledWith(70);
    expect(existsSync(resultPath)).toBe(true);
    expect(deliveredResult(resultPath)).toMatchObject({
      status: 'planned',
      exitCode: 0,
      dryRun: true,
    });
    // The plan is many stdout lines, and the guard still reports their loss exactly once.
    expect(countLines(stderr.text(), LOST_STDOUT_LINE)).toBe(1);
  });

  it('keeps exit 0 and the result file when the stdout consumer went away', async () => {
    const { manifestPath, resultPath } = dryRunFixture();
    const stderr = capturingSink();
    const setExitCode = vi.fn();

    const code = await bootstrap(
      ['run', manifestPath, '--non-interactive', '--dry-run', '--result', resultPath],
      { stdout: failingSink(systemError('EPIPE', 'broken pipe')), stderr: stderr.stream },
      { setExitCode, control: {} },
    );
    await settled();

    expect(code).toBe(0);
    expect(setExitCode).not.toHaveBeenCalled();
    expect(stderr.text()).not.toContain(LOST_STDOUT_LINE);
    expect(existsSync(resultPath)).toBe(true);
    expect(deliveredResult(resultPath)).toMatchObject({
      status: 'planned',
      exitCode: 0,
      dryRun: true,
    });
  });

  it('never changes the exit code when the stderr sink fails', async () => {
    const stdout = capturingSink();
    const setExitCode = vi.fn();

    const code = await bootstrap(
      ['--no-such-flag'],
      { stdout: stdout.stream, stderr: failingSink(systemError('ENOSPC', 'no space left')) },
      { setExitCode, control: {} },
    );
    await settled();

    expect(code).toBe(2);
    expect(stdout.text()).toBe('');
    expect(setExitCode).not.toHaveBeenCalled();
  });

  it('returns the run exit code and its machine output when both streams are healthy', async () => {
    const stdout = capturingSink();
    const stderr = capturingSink();
    const setExitCode = vi.fn();

    const code = await bootstrap(
      ['schema'],
      { stdout: stdout.stream, stderr: stderr.stream },
      { setExitCode, control: {} },
    );
    await settled();

    expect(code).toBe(0);
    expect(stdout.text()).toContain('"$schema"');
    expect(stdout.text().endsWith('\n')).toBe(true);
    expect(stderr.text()).toBe('');
    expect(setExitCode).not.toHaveBeenCalled();
  });

  it("forwards the host's cancel token to the run", async () => {
    const { manifestPath, resultPath } = dryRunFixture();
    const cancel = new CancelToken();
    cancel.cancel();
    const stdout = capturingSink();
    const stderr = capturingSink();
    const setExitCode = vi.fn();

    // The token the executable host owns is the only way a `Ctrl+C` reaches the run: without
    // it this argv would plan, print and exit 0 (§7).
    const code = await bootstrap(
      ['run', manifestPath, '--non-interactive', '--dry-run', '--result', resultPath],
      { stdout: stdout.stream, stderr: stderr.stream },
      { setExitCode, control: { cancel } },
    );
    await settled();

    expect(code).toBe(6);
    expect(stdout.text()).toBe('');
    expect(deliveredResult(resultPath)).toMatchObject({ status: 'cancelled', exitCode: 6 });
  });
});
