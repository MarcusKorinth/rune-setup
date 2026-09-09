import { PassThrough, Writable } from 'node:stream';

import { describe, expect, it } from 'vitest';

import { LOST_STDOUT_DIAGNOSTIC, guardShellStreams } from '../src/main/streams.js';

function systemError(code: string, message: string): NodeJS.ErrnoException {
  return Object.assign(new Error(`${code}: ${message}, write`), { code, syscall: 'write' });
}

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

function collector(): { readonly stream: PassThrough; readonly text: () => string } {
  const chunks: string[] = [];
  const stream = new PassThrough();
  stream.on('data', (chunk: Buffer) => chunks.push(chunk.toString()));
  return { stream, text: () => chunks.join('') };
}

function callbackOnlySink(error: Error): Writable {
  const stream = new PassThrough();
  Object.defineProperty(stream, 'write', {
    value: (_text: string, callback: (error?: Error | null) => void): boolean => {
      callback(error);
      return true;
    },
  });
  return stream;
}

const settled = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

describe('GUI shell process-stream ownership', () => {
  it.each(['EPIPE', 'ECONNRESET'])(
    'silently abandons stdout after %s and drops later output',
    async (code) => {
      const stdout = failingSink(systemError(code, 'consumer went away'));
      const stderr = collector();
      const output = guardShellStreams({ stdout: stdout.stream, stderr: stderr.stream });

      await expect(output.stdout.writeAndWait('result')).resolves.toBe('consumer-gone');
      await expect(output.stdout.writeAndWait('later')).resolves.toBe('consumer-gone');

      expect(stdout.attempts).toEqual(['result']);
      expect(stderr.text()).toBe('');
      expect(output.stdout.failed()).toBe(false);
      output.dispose();
    },
  );

  it('reports a non-pipe stdout callback/event failure exactly once without its data', async () => {
    const raw = systemError('ENOSPC', 'private device details');
    const stdout = failingSink(raw);
    const stderr = collector();
    const output = guardShellStreams({ stdout: stdout.stream, stderr: stderr.stream });

    await expect(output.stdout.writeAndWait('result')).resolves.toBe('failed');
    await settled();
    // Writable supplies the same failure through the write callback and its `error` event.
    expect(stderr.text()).toBe(`${LOST_STDOUT_DIAGNOSTIC}\n`);
    expect(stderr.text()).not.toContain(raw.message);
    expect(output.stdout.failed()).toBe(true);

    await expect(output.stdout.writeAndWait('later')).resolves.toBe('failed');
    expect(stdout.attempts).toEqual(['result']);
    expect(stderr.text()).toBe(`${LOST_STDOUT_DIAGNOSTIC}\n`);
    output.dispose();
  });

  it('owns an emitted stdout error even when no write callback reports it', () => {
    const stdout = collector();
    const stderr = collector();
    const output = guardShellStreams({ stdout: stdout.stream, stderr: stderr.stream });

    stdout.stream.emit('error', systemError('EIO', 'private emitted error'));
    stdout.stream.emit('error', systemError('ENOSPC', 'later private error'));

    expect(output.stdout.failed()).toBe(true);
    expect(stderr.text()).toBe(`${LOST_STDOUT_DIAGNOSTIC}\n`);
    expect(stderr.text()).not.toContain('private');
    output.dispose();
  });

  it('keeps the first stdout classification when later errors disagree', () => {
    const stdout = collector();
    const stderr = collector();
    const output = guardShellStreams({ stdout: stdout.stream, stderr: stderr.stream });

    stdout.stream.emit('error', systemError('EPIPE', 'consumer went away'));
    stdout.stream.emit('error', systemError('EIO', 'later failure'));

    expect(output.stdout.isBroken()).toBe(true);
    expect(output.stdout.failed()).toBe(false);
    expect(stderr.text()).toBe('');
    output.dispose();
  });

  it('contains a synchronous stdout write throw and reports the fixed diagnostic', async () => {
    const stdout = new Writable({
      write() {
        throw new Error('private synchronous failure');
      },
    });
    const stderr = collector();
    const output = guardShellStreams({ stdout, stderr: stderr.stream });

    await expect(output.stdout.writeAndWait('result')).resolves.toBe('failed');

    expect(output.stdout.failed()).toBe(true);
    expect(stderr.text()).toBe(`${LOST_STDOUT_DIAGNOSTIC}\n`);
    expect(stderr.text()).not.toContain('private synchronous failure');
    output.dispose();
  });

  it.each(['EPIPE', 'ECONNRESET', 'EIO'])(
    'treats stderr %s as best-effort and leaves stdout healthy',
    async (code) => {
      const stdout = collector();
      const stderr = failingSink(systemError(code, 'private diagnostic failure'));
      const output = guardShellStreams({ stdout: stdout.stream, stderr: stderr.stream });

      expect(() => output.stderr.write('diagnostic')).not.toThrow();
      await settled();

      expect(output.stderr.isBroken()).toBe(true);
      expect(output.stderr.failed()).toBe(code === 'EIO');
      expect(output.stdout.failed()).toBe(false);
      expect(stderr.attempts).toEqual(['diagnostic']);
      output.dispose();
    },
  );

  it('classifies a callback-only stderr failure without making stdout fail', async () => {
    const stdout = collector();
    const stderr = callbackOnlySink(systemError('EIO', 'callback-only failure'));
    const output = guardShellStreams({ stdout: stdout.stream, stderr });

    output.stderr.write('diagnostic');

    expect(output.stderr.failed()).toBe(true);
    expect(output.stdout.failed()).toBe(false);
    output.dispose();
    await settled();
    expect(stderr.listenerCount('error')).toBe(0);
  });

  it('contains a synchronous stderr throw without changing stdout', () => {
    const stdout = collector();
    const stderr = new Writable({
      write() {
        throw new Error('private synchronous diagnostic failure');
      },
    });
    const output = guardShellStreams({ stdout: stdout.stream, stderr });

    expect(() => output.stderr.write('diagnostic')).not.toThrow();

    expect(output.stderr.failed()).toBe(true);
    expect(output.stdout.failed()).toBe(false);
    output.dispose();
  });

  it('settles a pending stderr write when its consumer closes without a callback', async () => {
    const stdout = collector();
    const stderr = new Writable({
      write() {
        // Deliberately neither succeeds nor fails the write callback.
      },
    });
    const output = guardShellStreams({ stdout: stdout.stream, stderr });

    const pending = output.stderr.writeAndWait('diagnostic');
    stderr.destroy();

    await expect(pending).resolves.toBe('consumer-gone');
    expect(output.stderr.isBroken()).toBe(true);
    expect(output.stderr.failed()).toBe(false);
    expect(stderr.destroyed).toBe(true);
    await settled();
    expect(stderr.listenerCount('error')).toBe(0);
    expect(stderr.listenerCount('close')).toBe(0);
    output.dispose();
  });

  it('keeps an earlier stream failure when the consumer then closes', async () => {
    const stdout = collector();
    const stderr = new Writable({
      write() {
        // Deliberately neither succeeds nor fails the write callback.
      },
    });
    const output = guardShellStreams({ stdout: stdout.stream, stderr });

    const pending = output.stderr.writeAndWait('diagnostic');
    stderr.emit('error', systemError('EIO', 'first failure'));
    stderr.destroy();

    await expect(pending).resolves.toBe('failed');
    expect(output.stderr.failed()).toBe(true);
    output.dispose();
  });

  it('disposes both listeners, settles a pending write, and ignores later writes', async () => {
    let finishWrite: ((error?: Error | null) => void) | undefined;
    const stdout = new Writable({
      write(_chunk: Buffer, _encoding, callback) {
        finishWrite = callback;
      },
    });
    const stderr = collector();
    const output = guardShellStreams({ stdout, stderr: stderr.stream });
    const pending = output.stdout.writeAndWait('pending');

    expect(stdout.listenerCount('error')).toBe(1);
    expect(stderr.stream.listenerCount('error')).toBe(1);
    output.dispose();
    output.dispose();

    await expect(pending).resolves.toBe('consumer-gone');
    expect(stdout.listenerCount('error')).toBe(1);
    output.stderr.write('later diagnostic');
    await expect(output.stdout.writeAndWait('later result')).resolves.toBe('consumer-gone');
    expect(stderr.text()).toBe('');

    finishWrite?.();
    await settled();
    expect(stdout.listenerCount('error')).toBe(0);
    expect(stderr.stream.listenerCount('error')).toBe(0);
  });
});
