import { PassThrough, Writable } from 'node:stream';

import { describe, expect, it, vi } from 'vitest';

import { guardStream } from '../src/streams.js';

function systemError(code: string, message: string): NodeJS.ErrnoException {
  return Object.assign(new Error(`${code}: ${message}, write`), { code, syscall: 'write' });
}

/** A sink whose every write fails asynchronously with `error`. */
function failingSink(error: Error): { readonly stream: Writable; readonly attempts: string[] } {
  const attempts: string[] = [];
  const stream = new Writable({
    write(chunk: Buffer, _encoding, callback) {
      attempts.push(chunk.toString());
      callback(error);
    },
  });
  return { stream, attempts };
}

const settled = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

describe('guarded process streams: failures other than a consumer that went away', () => {
  it('keeps an ENOSPC write error as the failure and reports it once', async () => {
    const enospc = systemError('ENOSPC', 'no space left on device');
    const { stream, attempts } = failingSink(enospc);
    const onFailure = vi.fn();
    const guard = guardStream(stream, onFailure);

    guard.writeLine('requested output');
    await settled();

    expect(guard.isBroken()).toBe(true);
    expect(guard.failure()).toBe(enospc);
    // The write callback and the stream's `error` event both carry the error; one report.
    expect(onFailure).toHaveBeenCalledTimes(1);
    expect(onFailure).toHaveBeenCalledWith(enospc);

    guard.writeLine('more output');
    await settled();

    expect(attempts).toEqual(['requested output\n']);
    expect(onFailure).toHaveBeenCalledTimes(1);
  });

  it.each(['EPIPE', 'ECONNRESET'])('treats %s as a consumer that went away', async (code) => {
    const { stream } = failingSink(systemError(code, 'the reader is gone'));
    const onFailure = vi.fn();
    const guard = guardStream(stream, onFailure);

    guard.writeLine('requested output');
    await settled();

    expect(guard.isBroken()).toBe(true);
    expect(guard.failure()).toBeUndefined();
    expect(onFailure).not.toHaveBeenCalled();
  });

  it('classifies the stream by its first error only', async () => {
    // A slow sink keeps later lines buffered; when the first write fails with EPIPE, Node
    // fails the buffered writes as well, and those follow-up errors must not count.
    const pending: Array<(error?: Error | null) => void> = [];
    const stream = new Writable({
      write(_chunk: Buffer, _encoding, callback) {
        pending.push(callback);
      },
    });
    const onFailure = vi.fn();
    const guard = guardStream(stream, onFailure);

    guard.writeLine('one');
    guard.writeLine('two');
    guard.writeLine('three');
    expect(pending).toHaveLength(1);

    pending[0]!(systemError('EPIPE', 'broken pipe'));
    await settled();

    expect(guard.isBroken()).toBe(true);
    expect(guard.failure()).toBeUndefined();
    expect(onFailure).not.toHaveBeenCalled();
  });

  it('marks a synchronous write throw as a failure', () => {
    const thrown = new Error('synchronous sink failure');
    const stream = new Writable({
      write() {
        throw thrown;
      },
    });
    const onFailure = vi.fn();
    const guard = guardStream(stream, onFailure);

    expect(() => guard.writeLine('boom')).not.toThrow();

    expect(guard.isBroken()).toBe(true);
    expect(guard.failure()).toBe(thrown);
    expect(onFailure).toHaveBeenCalledTimes(1);
  });

  it('reports an error emitted between writes unless the consumer went away', async () => {
    const eio = systemError('EIO', 'i/o error');
    const failing = new PassThrough();
    const failingGuard = guardStream(failing);
    const closing = new PassThrough();
    const closingGuard = guardStream(closing);

    failingGuard.writeLine('before');
    failing.destroy(eio);
    closingGuard.writeLine('before');
    closing.destroy(systemError('EPIPE', 'broken pipe'));
    await settled();

    expect(failingGuard.isBroken()).toBe(true);
    expect(failingGuard.failure()).toBe(eio);
    expect(closingGuard.isBroken()).toBe(true);
    expect(closingGuard.failure()).toBeUndefined();
  });

  it('leaves a healthy stream without a failure', async () => {
    const received: string[] = [];
    const stream = new PassThrough();
    stream.on('data', (chunk: Buffer) => {
      received.push(chunk.toString());
    });
    const onFailure = vi.fn();
    const guard = guardStream(stream, onFailure);

    guard.writeLine('fine');
    await settled();

    expect(received).toEqual(['fine\n']);
    expect(guard.isBroken()).toBe(false);
    expect(guard.failure()).toBeUndefined();
    expect(onFailure).not.toHaveBeenCalled();
  });
});
