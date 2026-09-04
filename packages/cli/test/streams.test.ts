import { PassThrough, Writable } from 'node:stream';

import { describe, expect, it } from 'vitest';

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
