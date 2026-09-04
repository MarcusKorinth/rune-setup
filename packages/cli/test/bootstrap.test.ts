import { Writable } from 'node:stream';

import { describe, expect, it, vi } from 'vitest';

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
      { setExitCode },
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
      { setExitCode },
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
      { setExitCode },
    );
    await settled();

    expect(code).toBe(0);
    expect(stderr.text()).toBe('');
    expect(setExitCode).not.toHaveBeenCalled();
  });

  it('never changes the exit code when the stderr sink fails', async () => {
    const stdout = capturingSink();
    const setExitCode = vi.fn();

    const code = await bootstrap(
      ['--no-such-flag'],
      { stdout: stdout.stream, stderr: failingSink(systemError('ENOSPC', 'no space left')) },
      { setExitCode },
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
      { setExitCode },
    );
    await settled();

    expect(code).toBe(0);
    expect(stdout.text()).toContain('"$schema"');
    expect(stdout.text().endsWith('\n')).toBe(true);
    expect(stderr.text()).toBe('');
    expect(setExitCode).not.toHaveBeenCalled();
  });
});
