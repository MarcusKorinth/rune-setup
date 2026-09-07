import { Duplex } from 'node:stream';

import { CancelledError, UsageError } from '@rune/engine';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createGuiStartupGate } from '../src/guiStartup.js';
import { ExitWithCode } from '../src/io.js';

const token = 'ab'.repeat(16);
const ready = `READY ${token}\n`;
const tick = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

class StartupPipe extends Duplex {
  readonly writes: string[] = [];
  onWrite?: () => void;
  writeFailure?: Error;
  holdWrite = false;

  override _read(): void {}

  override _write(
    chunk: Buffer,
    _encoding: BufferEncoding,
    callback: (error?: Error) => void,
  ): void {
    this.writes.push(chunk.toString());
    this.onWrite?.();
    if (!this.holdWrite) callback(this.writeFailure);
  }
}

beforeEach(() => vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] }));
afterEach(() => vi.useRealTimers());

async function expectClean(pipe: StartupPipe): Promise<void> {
  await tick();
  expect(pipe.destroyed).toBe(true);
  for (const event of ['data', 'end', 'close', 'error']) expect(pipe.listenerCount(event)).toBe(0);
  expect(vi.getTimerCount()).toBe(0);
}

describe('Linux GUI readiness gate', () => {
  it('accepts fragmented READY and transfers ownership before its one START write', async () => {
    const pipe = new StartupPipe();
    const gate = createGuiStartupGate(pipe, token);
    pipe.onWrite = () => expect(gate.transferred()).toBe(true);
    pipe.push(Buffer.from(ready.slice(0, 7)));
    await tick();
    expect(gate.transferred()).toBe(false);
    pipe.push(Buffer.from(ready.slice(7)));

    await gate.completion;
    expect(pipe.writes).toEqual([`START ${token}\n`]);
    expect(gate.cancel()).toBe(true);
    gate.abort();
    await expectClean(pipe);
  });

  it('buffers cancellation before READY and sends only CANCEL', async () => {
    const pipe = new StartupPipe();
    const gate = createGuiStartupGate(pipe, token);
    expect(gate.cancel()).toBe(false);
    expect(gate.cancel()).toBe(false);
    pipe.push(Buffer.from(ready));

    await gate.completion;
    expect(pipe.writes).toEqual([`CANCEL ${token}\n`]);
    expect(gate.cancel()).toBe(false);
    await expectClean(pipe);
  });

  it.each([
    'READY wrong\n',
    `READY ${token}\nextra`,
    `READY ${token}\r\n`,
    'x'.repeat(129),
    '\u00ff',
  ])('rejects a malformed or oversized frame without transferring ownership: %j', async (frame) => {
    const pipe = new StartupPipe();
    const gate = createGuiStartupGate(pipe, token);
    const failure = gate.completion.catch((error: unknown) => error);
    pipe.push(Buffer.from(frame));

    expect(await failure).toBeInstanceOf(UsageError);
    expect(gate.transferred()).toBe(false);
    expect(pipe.writes).toEqual([]);
    await expectClean(pipe);
  });

  it.each(['end', 'close', 'error'] as const)(
    'contains %s before READY and cleans its resources',
    async (event) => {
      const pipe = new StartupPipe();
      const gate = createGuiStartupGate(pipe, token);
      const failure = gate.completion.catch((error: unknown) => error);
      if (event === 'end') pipe.push(null);
      else if (event === 'close') pipe.destroy();
      else pipe.destroy(new Error('private pipe failure'));

      const error = await failure;
      expect(error).toBeInstanceOf(UsageError);
      expect((error as Error).message).not.toContain('private pipe failure');
      expect(gate.transferred()).toBe(false);
      await expectClean(pipe);
    },
  );

  it('keeps a cancellation requested before the deadline as the CLI-owned outcome', async () => {
    const pipe = new StartupPipe();
    const gate = createGuiStartupGate(pipe, token);
    const failure = gate.completion.catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(9999);
    gate.cancel();
    await vi.advanceTimersByTimeAsync(1);

    expect(await failure).toBeInstanceOf(CancelledError);
    expect(gate.transferred()).toBe(false);
    await expectClean(pipe);
  });

  it('does not let a late cancellation overwrite the startup deadline', async () => {
    const pipe = new StartupPipe();
    const gate = createGuiStartupGate(pipe, token);
    const failure = gate.completion.catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(10000);
    gate.cancel();

    expect(await failure).toBeInstanceOf(UsageError);
    await expectClean(pipe);
  });

  it.each(['throw', 'callback'] as const)(
    'retains shell ownership when its write fails by %s',
    async (kind) => {
      const pipe = new StartupPipe();
      const gate = createGuiStartupGate(pipe, token);
      const failure = gate.completion.catch((error: unknown) => error);
      if (kind === 'throw')
        vi.spyOn(pipe, 'write').mockImplementation(() => {
          throw new Error('private write failure');
        });
      else pipe.writeFailure = new Error('private write failure');
      pipe.push(Buffer.from(ready));

      expect(await failure).toBeInstanceOf(ExitWithCode);
      expect(await failure).toMatchObject({ code: 70 });
      expect(gate.transferred()).toBe(true);
      await expectClean(pipe);
    },
  );

  it('bounds a missing write callback after ownership transferred', async () => {
    const pipe = new StartupPipe();
    pipe.holdWrite = true;
    const gate = createGuiStartupGate(pipe, token);
    const failure = gate.completion.catch((error: unknown) => error);
    pipe.push(Buffer.from(ready));
    await tick();
    await vi.advanceTimersByTimeAsync(10000);

    expect(await failure).toMatchObject({ code: 70 });
    expect(gate.transferred()).toBe(true);
    await expectClean(pipe);
  });

  it('closes the descriptor on a forced exit before transfer', async () => {
    const pipe = new StartupPipe();
    const gate = createGuiStartupGate(pipe, token);
    const failure = gate.completion.catch((error: unknown) => error);
    gate.cancel();
    gate.abort();

    expect(await failure).toBeInstanceOf(CancelledError);
    expect(gate.transferred()).toBe(false);
    expect(pipe.writes).toEqual([]);
    await expectClean(pipe);
  });
});
