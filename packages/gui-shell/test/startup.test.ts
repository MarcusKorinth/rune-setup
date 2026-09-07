import { Duplex } from 'node:stream';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { InternalError } from '@rune/engine';

import { STARTUP_TOKEN_ENV, takeStartupGate, waitForStartupDecision } from '../src/main/startup.js';

const token = '0123456789abcdef0123456789abcdef';

function transport(): { channel: Duplex; sent: string[] } {
  const sent: string[] = [];
  const channel = new Duplex({
    read() {},
    write(chunk: Buffer, _encoding, callback) {
      sent.push(chunk.toString('utf8'));
      callback();
    },
  });
  return { channel, sent };
}

afterEach(() => vi.useRealTimers());

describe('the private Linux shell startup gate', () => {
  it.each(['START', 'CANCEL'] as const)(
    'waits for a complete authenticated %s frame',
    async (kind) => {
      const { channel, sent } = transport();
      const decision = waitForStartupDecision(channel, token);
      const settled = vi.fn();
      void decision.then(settled);
      expect(sent).toEqual([`READY ${token}\n`]);

      channel.push(Buffer.from(`${kind} ${token.slice(0, 12)}`));
      await Promise.resolve();
      expect(settled).not.toHaveBeenCalled();
      expect(channel.destroyed).toBe(false);
      channel.push(Buffer.from(`${token.slice(12)}\n`));

      await expect(decision).resolves.toBe(kind.toLowerCase());
      expect(channel.destroyed).toBe(true);
      expect(channel.listenerCount('data')).toBe(0);
      expect(channel.listenerCount('end')).toBe(0);
    },
  );

  it.each([
    `START ${'0'.repeat(32)}\n`,
    `START ${token}\r\n`,
    `START ${token}\nCANCEL ${token}\n`,
    `OTHER ${token}\n`,
    'x'.repeat(129),
  ])('rejects malformed, foreign, or oversized protocol data without echoing it', async (frame) => {
    const { channel } = transport();
    const decision = waitForStartupDecision(channel, token);
    const rejected = expect(decision).rejects.toMatchObject({
      code: 'RUNE-500',
      message: new InternalError('the GUI shell startup handshake failed').message,
    });
    channel.push(Buffer.from(frame));
    await rejected;
    expect(channel.destroyed).toBe(true);
  });

  it.each(['end', 'close', 'error'] as const)(
    'releases a gate when its parent channel emits %s',
    async (event) => {
      const { channel } = transport();
      const decision = waitForStartupDecision(channel, token);
      const rejected = expect(decision).rejects.toBeInstanceOf(InternalError);
      if (event === 'end') channel.push(null);
      else if (event === 'close') channel.destroy();
      else channel.destroy(new Error('private transport bytes'));
      await rejected;
      expect(channel.destroyed).toBe(true);
    },
  );

  it('owns an asynchronous READY write failure', async () => {
    const channel = new Duplex({
      read() {},
      write(_chunk, _encoding, callback) {
        callback(new Error('private transport bytes'));
      },
    });
    await expect(waitForStartupDecision(channel, token)).rejects.toMatchObject({
      code: 'RUNE-500',
    });
    expect(channel.destroyed).toBe(true);
  });

  it('bounds a silent launcher to ten seconds and clears its timer', async () => {
    vi.useFakeTimers();
    const { channel } = transport();
    const decision = waitForStartupDecision(channel, token).catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(9999);
    expect(channel.destroyed).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(await decision).toMatchObject({
      message: new InternalError('the GUI shell startup decision did not arrive within 10 seconds')
        .message,
    });
    expect(channel.destroyed).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('consumes the private environment key before constructing any transport', async () => {
    const environment = { [STARTUP_TOKEN_ENV]: 'invalid private value', PUBLIC_VALUE: 'kept' };
    const gate = takeStartupGate(environment, 'linux');
    expect(environment).toEqual({ PUBLIC_VALUE: 'kept' });
    expect(gate).toBeTypeOf('function');
    await expect(gate?.()).rejects.toMatchObject({
      message: new InternalError('the GUI shell startup token is invalid').message,
    });
  });

  it('does not require a channel for standalone starts or Windows', () => {
    expect(takeStartupGate({}, 'linux')).toBeUndefined();
    const environment = { [STARTUP_TOKEN_ENV]: token };
    expect(takeStartupGate(environment, 'win32')).toBeUndefined();
    expect(environment).toEqual({});
  });
});
