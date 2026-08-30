import { PassThrough } from 'node:stream';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { Session } from '@rune/engine';

import type { CliIo } from '../src/io.js';
import type { Interaction } from '../src/prompt.js';
import { runCommand } from '../src/runCmd.js';

interface PendingExecution {
  readonly promise: Promise<never>;
  reject(error: Error): void;
}

function pendingExecution(): PendingExecution {
  let reject!: (error: Error) => void;
  const promise = new Promise<never>((_resolve, rejectPromise) => {
    reject = rejectPromise;
  });
  return { promise, reject };
}

function capture(): CliIo & { readonly stderr: ReturnType<typeof vi.fn> } {
  return { stdout: vi.fn(), stderr: vi.fn() };
}

function interaction(forceExit = vi.fn()): Interaction {
  return {
    input: new PassThrough(),
    isTTY: false,
    write: vi.fn(),
    forceExit,
  };
}

function session(execution: PendingExecution): Session & {
  readonly cancel: ReturnType<typeof vi.fn>;
  readonly execute: ReturnType<typeof vi.fn>;
} {
  return {
    cancel: vi.fn(),
    execute: vi.fn(() => execution.promise),
    getStrings: () => ({ chrome: () => 'cancelling' }),
  } as unknown as Session & {
    readonly cancel: ReturnType<typeof vi.fn>;
    readonly execute: ReturnType<typeof vi.fn>;
  };
}

async function startExecution(fakeSession: Session): Promise<void> {
  vi.spyOn(Session, 'open').mockResolvedValue(fakeSession);
  void runCommand('installer.yaml', { nonInteractive: true }, capture(), interaction()).catch(
    () => undefined,
  );
  await vi.waitFor(() => expect(fakeSession.execute).toHaveBeenCalledOnce());
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe.sequential('regular CLI execution signals', () => {
  it('cancels once for repeated SIGTERM and writes one diagnostic', async () => {
    const execution = pendingExecution();
    const fakeSession = session(execution);
    const io = capture();
    const forceExit = vi.fn();
    vi.spyOn(Session, 'open').mockResolvedValue(fakeSession);
    const run = runCommand('installer.yaml', { nonInteractive: true }, io, interaction(forceExit));
    await vi.waitFor(() => expect(fakeSession.execute).toHaveBeenCalledOnce());

    process.emit('SIGTERM');
    process.emit('SIGTERM');

    expect(fakeSession.cancel).toHaveBeenCalledTimes(1);
    expect(io.stderr).toHaveBeenCalledTimes(1);
    expect(io.stderr).toHaveBeenCalledWith('cancelling');
    expect(forceExit).not.toHaveBeenCalled();

    execution.reject(new Error('stop test execution'));
    await expect(run).rejects.toThrow('stop test execution');
  });

  it('force-exits only after a second SIGINT, even when SIGTERM requested cancellation', async () => {
    const execution = pendingExecution();
    const fakeSession = session(execution);
    const forceExit = vi.fn();
    vi.spyOn(Session, 'open').mockResolvedValue(fakeSession);
    const run = runCommand(
      'installer.yaml',
      { nonInteractive: true },
      capture(),
      interaction(forceExit),
    );
    await vi.waitFor(() => expect(fakeSession.execute).toHaveBeenCalledOnce());

    process.emit('SIGTERM');
    process.emit('SIGINT');
    expect(forceExit).not.toHaveBeenCalled();

    process.emit('SIGINT');
    expect(fakeSession.cancel).toHaveBeenCalledTimes(1);
    expect(forceExit).toHaveBeenCalledTimes(1);
    expect(forceExit).toHaveBeenCalledWith(6);

    execution.reject(new Error('stop test execution'));
    await expect(run).rejects.toThrow('stop test execution');
  });

  it('removes both signal listeners when execution settles', async () => {
    const sigintListeners = process.listenerCount('SIGINT');
    const sigtermListeners = process.listenerCount('SIGTERM');
    const execution = pendingExecution();
    const fakeSession = session(execution);

    await startExecution(fakeSession);
    expect(process.listenerCount('SIGINT')).toBe(sigintListeners + 1);
    expect(process.listenerCount('SIGTERM')).toBe(sigtermListeners + 1);

    execution.reject(new Error('stop test execution'));
    await vi.waitFor(() => {
      expect(process.listenerCount('SIGINT')).toBe(sigintListeners);
      expect(process.listenerCount('SIGTERM')).toBe(sigtermListeners);
    });
  });
});
