import { PassThrough, Writable } from 'node:stream';

import { describe, expect, it, vi } from 'vitest';

import { guardStream } from '../src/streams.js';

function epipe(): NodeJS.ErrnoException {
  return Object.assign(new Error('EPIPE: broken pipe, write'), {
    code: 'EPIPE',
    errno: -32,
    syscall: 'write',
  });
}

/** A pipe whose reader has gone away: every write fails asynchronously with EPIPE. */
function brokenPipe(): { readonly stream: Writable; readonly attempts: string[] } {
  const attempts: string[] = [];
  const stream = new Writable({
    write(chunk: Buffer, _encoding, callback) {
      attempts.push(chunk.toString());
      callback(epipe());
    },
  });
  return { stream, attempts };
}

/** A healthy sink that records what it received. */
function collector(): { readonly stream: PassThrough; readonly received: string[] } {
  const received: string[] = [];
  const stream = new PassThrough();
  stream.on('data', (chunk: Buffer) => {
    received.push(chunk.toString());
  });
  return { stream, received };
}

const settled = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

describe('guarded process streams', () => {
  it('shares one drain waiter until every queued write callback finishes', async () => {
    const callbacks: Array<(error?: Error | null) => void> = [];
    const received: string[] = [];
    const stream = new Writable({
      highWaterMark: 1,
      write(chunk: Buffer, _encoding, callback) {
        received.push(chunk.toString());
        callbacks.push(callback);
      },
    });
    const guard = guardStream(stream);
    guard.writeLine('first');
    guard.writeLine('second');
    const drained = vi.fn();
    const pending = guard.drain();
    void pending.then(drained);

    for (let index = 0; index < 1_000; index += 1) {
      expect(guard.drain()).toBe(pending);
    }
    expect(stream.listenerCount('error')).toBe(1);
    expect(stream.listenerCount('close')).toBe(1);
    expect(stream.listenerCount('drain')).toBe(0);
    await settled();
    expect(drained).not.toHaveBeenCalled();
    expect(received).toEqual(['first\n']);

    callbacks.shift()!();
    await settled();
    expect(drained).not.toHaveBeenCalled();
    expect(received).toEqual(['first\n', 'second\n']);

    callbacks.shift()!();
    await pending;
    expect(drained).toHaveBeenCalledOnce();
    await expect(guard.drain()).resolves.toBeUndefined();
  });

  it.each(['EPIPE', 'ENOSPC'])(
    'releases a drain waiter on %s and keeps error ownership',
    async (code) => {
      const stream = new Writable({ write() {} });
      const onFailure = vi.fn();
      const guard = guardStream(stream, onFailure);
      guard.writeLine('queued');
      const pending = guard.drain();
      const error = Object.assign(new Error('sink failure'), { code });

      stream.emit('error', error);
      await expect(pending).resolves.toBeUndefined();
      guard.writeLine('ignored');
      await expect(guard.drain()).resolves.toBeUndefined();
      expect(guard.failure()).toBe(code === 'EPIPE' ? undefined : error);
      expect(onFailure).toHaveBeenCalledTimes(code === 'EPIPE' ? 0 : 1);
      stream.destroy();
    },
  );

  it('releases a drain waiter when the stream closes without completing its write', async () => {
    const stream = new Writable({ write() {} });
    const guard = guardStream(stream);
    guard.writeLine('queued');
    const pending = guard.drain();

    stream.destroy();
    await expect(pending).resolves.toBeUndefined();
    expect(guard.isBroken()).toBe(true);
    expect(guard.failure()).toBeUndefined();
  });

  it('writes raw prompt fragments without adding a line break', async () => {
    const { stream, received } = collector();
    const guard = guardStream(stream);

    guard.write('Prompt: ');
    guard.writeLine('answer');
    await settled();

    expect(received.join('')).toBe('Prompt: answer\n');
  });

  it('owns EPIPE, remembers the broken stream, and drops later writes', async () => {
    const { stream, attempts } = brokenPipe();
    const guard = guardStream(stream);

    expect(stream.listenerCount('error')).toBe(1);
    expect(guard.isBroken()).toBe(false);

    guard.writeLine('first');
    await settled();

    expect(attempts).toEqual(['first\n']);
    expect(guard.isBroken()).toBe(true);
    expect(stream.destroyed).toBe(true);

    guard.writeLine('second');
    await settled();

    expect(attempts).toEqual(['first\n']);
  });

  it('treats an error emitted between writes as the end of output', async () => {
    const { stream, received } = collector();
    const guard = guardStream(stream);

    guard.writeLine('before');
    stream.destroy(epipe());
    await settled();

    expect(guard.isBroken()).toBe(true);

    guard.writeLine('after');
    await settled();

    expect(received).toEqual(['before\n']);
  });

  it('writes nothing to a stream that is already destroyed', async () => {
    const { stream, received } = collector();
    stream.destroy();
    const guard = guardStream(stream);

    expect(guard.isBroken()).toBe(true);

    guard.writeLine('late');
    await settled();

    expect(received).toEqual([]);
  });

  it('marks a stream broken when its write throws synchronously', () => {
    const stream = new Writable({
      write() {
        throw new Error('synchronous sink failure');
      },
    });
    const guard = guardStream(stream);

    expect(() => guard.writeLine('boom')).not.toThrow();
    expect(guard.isBroken()).toBe(true);
    expect(() => guard.writeLine('again')).not.toThrow();
  });

  it('keeps the other stream working after one breaks', async () => {
    const stdout = brokenPipe();
    const stderr = collector();
    const out = guardStream(stdout.stream);
    const err = guardStream(stderr.stream);

    out.writeLine('requested output');
    await settled();
    err.writeLine('diagnostic');
    out.writeLine('more output');
    await settled();

    expect(out.isBroken()).toBe(true);
    expect(err.isBroken()).toBe(false);
    expect(stdout.attempts).toEqual(['requested output\n']);
    expect(stderr.received).toEqual(['diagnostic\n']);
  });
});
