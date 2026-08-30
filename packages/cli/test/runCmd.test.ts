import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { CancelledError, Session, UsageError } from '@rune/engine';

import { run } from '../src/cli.js';
import { ExitWithCode, type CliIo } from '../src/io.js';
import type { Interaction } from '../src/prompt.js';
import { runCommand } from '../src/runCmd.js';

const gui = vi.hoisted(() => ({ launchGui: vi.fn() }));
vi.mock('../src/guiCmd.js', () => ({ launchGui: gui.launchGui }));

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
  gui.launchGui.mockReset();
  vi.restoreAllMocks();
});

describe('GUI result ownership before shell launch', () => {
  it('writes one zero-counter cancelled result when pre-shell cancellation owns the run', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'rune-gui-prelaunch-result-'));
    const resultPath = join(directory, 'result.json');
    const io = capture();
    gui.launchGui.mockRejectedValueOnce(
      new CancelledError('cancelled before the GUI shell started'),
    );

    try {
      await expect(
        runCommand('installer.yaml', { gui: true, result: resultPath }, io, interaction()),
      ).rejects.toMatchObject({ code: 6 });

      const result = JSON.parse(readFileSync(resultPath, 'utf8')) as Record<string, unknown>;
      expect(result).toMatchObject({
        mode: 'gui',
        status: 'cancelled',
        exitCode: 6,
        stepsTotal: 0,
        stepsExecuted: 0,
        nothingExecuted: true,
      });
      expect(io.stderr).toHaveBeenCalledTimes(1);
      expect(io.stderr).toHaveBeenCalledWith(`result written to ${resultPath}`);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('does not write a second result when an already-started shell exits cancelled', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'rune-gui-shell-result-owner-'));
    const resultPath = join(directory, 'result.json');
    gui.launchGui.mockRejectedValueOnce(new ExitWithCode(6));

    try {
      await expect(
        runCommand('installer.yaml', { gui: true, result: resultPath }, capture(), interaction()),
      ).rejects.toMatchObject({ code: 6 });
      expect(existsSync(resultPath)).toBe(false);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('keeps pre-shell cancellation unchanged when no result was requested', async () => {
    const io = capture();
    gui.launchGui.mockRejectedValueOnce(
      new CancelledError('cancelled before the GUI shell started'),
    );

    await expect(
      runCommand('installer.yaml', { gui: true }, io, interaction()),
    ).rejects.toMatchObject({ code: 6 });
    expect(io.stderr).not.toHaveBeenCalled();
  });

  it('does not write a result for GUI usage errors', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'rune-gui-usage-result-'));
    const resultPath = join(directory, 'result.json');
    gui.launchGui.mockRejectedValueOnce(new UsageError('GUI shell version mismatch'));

    try {
      await expect(
        runCommand('installer.yaml', { gui: true, result: resultPath }, capture(), interaction()),
      ).rejects.toBeInstanceOf(UsageError);
      expect(existsSync(resultPath)).toBe(false);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('maps a pre-shell cancellation result writer failure to exit 70', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'rune-gui-result-writer-error-'));
    const io = capture();
    gui.launchGui.mockRejectedValueOnce(
      new CancelledError('cancelled before the GUI shell started'),
    );

    try {
      expect(
        await run(['run', 'installer.yaml', '--gui', '--result', directory], io, interaction()),
      ).toBe(70);
      expect(io.stderr).toHaveBeenCalledWith(expect.stringContaining('internal error:'));
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
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
