import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { Duplex, PassThrough } from 'node:stream';

import { CancelToken, CancelledError, RUNE_VERSION, UsageError } from '@rune/engine';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { launchGui } from '../src/guiCmd.js';
import { ExitWithCode } from '../src/io.js';

vi.mock('node:child_process', () => ({ spawn: vi.fn() }));

const spawnMock = vi.mocked(spawn);
const platformDescriptor = Object.getOwnPropertyDescriptor(process, 'platform')!;
const tick = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

class StartupPipe extends Duplex {
  readonly writes: string[] = [];
  writeFailure?: Error;

  override _read(): void {}

  override _write(
    chunk: Buffer,
    _encoding: BufferEncoding,
    callback: (error?: Error) => void,
  ): void {
    this.writes.push(chunk.toString());
    callback(this.writeFailure);
  }
}

beforeEach(() => {
  Object.defineProperty(process, 'platform', { ...platformDescriptor, value: 'linux' });
  vi.stubEnv('RUNE_GUI_SHELL', '/unused/rune-gui-shell');
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  spawnMock.mockReset();
});

afterEach(() => {
  Object.defineProperty(process, 'platform', platformDescriptor);
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

async function fixture(controlled = true) {
  const pipe = new StartupPipe();
  const shell = Object.assign(new EventEmitter(), {
    pid: 4242,
    kill: vi.fn(),
    unref: vi.fn(),
    stdio: [null, null, null, pipe],
  });
  const probe = Object.assign(new EventEmitter(), { stdout: new PassThrough() });
  spawnMock.mockImplementationOnce(() => {
    queueMicrotask(() => {
      probe.stdout.end(JSON.stringify({ protocolVersion: 1, runeVersion: RUNE_VERSION }));
      probe.emit('close', 0);
    });
    return probe as unknown as ReturnType<typeof spawn>;
  });
  spawnMock.mockImplementationOnce(() => shell as unknown as ReturnType<typeof spawn>);
  const killGroup = vi.spyOn(process, 'kill').mockImplementation(() => {
    queueMicrotask(() => shell.emit('close', null));
    return true;
  });
  const cancel = new CancelToken();
  const forceExit = vi.fn();
  const listeners = ['SIGINT', 'SIGTERM', 'exit'].map((event) => process.listenerCount(event));
  const result = launchGui(
    'installer.yaml',
    { result: 'result.json' },
    { stdout: vi.fn(), stderr: vi.fn() },
    { input: new PassThrough(), isTTY: false, write: () => undefined, forceExit },
    controlled ? { cancel } : {},
  ).catch((error: unknown) => error);
  await tick();
  expect(spawnMock).toHaveBeenCalledTimes(2);
  const token = spawnMock.mock.calls[1]?.[2]?.env?.['RUNE_GUI_STARTUP_TOKEN'];
  expect(token).toMatch(/^[a-f0-9]{32}$/u);
  return { pipe, child: shell, cancel, forceExit, killGroup, result, token, listeners };
}

async function expectClean(state: Awaited<ReturnType<typeof fixture>>): Promise<void> {
  await tick();
  expect(state.pipe.destroyed).toBe(true);
  expect(['SIGINT', 'SIGTERM', 'exit'].map((event) => process.listenerCount(event))).toEqual(
    state.listeners,
  );
  for (const event of ['data', 'end', 'close', 'error']) {
    expect(state.pipe.listenerCount(event)).toBe(0);
  }
  expect(vi.getTimerCount()).toBe(0);
}

describe('Linux GUI launch readiness ownership', () => {
  it('uses a private fd and fresh token, then forwards cancellation after START', async () => {
    vi.stubEnv('RUNE_GUI_STARTUP_TOKEN', 'ambient-token');
    const state = await fixture();
    expect(spawnMock.mock.calls[1]?.[2]).toMatchObject({
      shell: false,
      detached: true,
      stdio: ['ignore', 'ignore', 'inherit', 'pipe'],
    });
    expect(state.token).not.toBe('ambient-token');
    expect(process.env['RUNE_GUI_STARTUP_TOKEN']).toBe('ambient-token');
    state.pipe.push(Buffer.from(`READY ${state.token}\n`));
    await tick();
    state.cancel.cancel();
    expect(state.pipe.writes).toEqual([`START ${state.token}\n`]);
    expect(state.child.kill).toHaveBeenCalledExactlyOnceWith('SIGTERM');
    state.child.emit('close', 6);

    expect(await state.result).toMatchObject({ code: 6 });
    expect(state.killGroup).not.toHaveBeenCalled();
    await expectClean(state);
  });

  it('sends buffered cancellation once and lets the shell own its result', async () => {
    const state = await fixture();
    state.cancel.cancel();
    expect(state.child.kill).not.toHaveBeenCalled();
    state.pipe.push(Buffer.from(`READY ${state.token}\n`));
    await tick();
    expect(state.pipe.writes).toEqual([`CANCEL ${state.token}\n`]);
    state.child.emit('close', 6);

    const error = await state.result;
    expect(error).toBeInstanceOf(ExitWithCode);
    expect(error).not.toBeInstanceOf(CancelledError);
    expect(error).toMatchObject({ code: 6 });
    expect(state.child.kill).not.toHaveBeenCalled();
    await expectClean(state);
  });

  it('kills a missing-READY startup tree and preserves an earlier cancellation', async () => {
    const state = await fixture();
    state.cancel.cancel();
    await vi.advanceTimersByTimeAsync(10000);

    expect(await state.result).toBeInstanceOf(CancelledError);
    expect(state.killGroup).toHaveBeenCalledExactlyOnceWith(-4242, 'SIGKILL');
    expect(state.pipe.writes).toEqual([]);
    await expectClean(state);
  });

  it('keeps a startup timeout authoritative over cancellation during tree cleanup', async () => {
    const state = await fixture();
    state.killGroup.mockImplementation(() => {
      state.cancel.cancel();
      queueMicrotask(() => state.child.emit('close', null));
      return true;
    });
    await vi.advanceTimersByTimeAsync(10000);

    expect(await state.result).toBeInstanceOf(UsageError);
    await expectClean(state);
  });

  it('releases the child handle after a bounded wait when a failed startup never closes', async () => {
    const state = await fixture();
    state.killGroup.mockImplementation(() => true);
    await vi.advanceTimersByTimeAsync(15000);

    expect(await state.result).toBeInstanceOf(UsageError);
    expect(state.child.unref).toHaveBeenCalledOnce();
    await expectClean(state);
  });

  it('closes the gate before the second Ctrl+C force-exits the CLI', async () => {
    const state = await fixture(false);
    process.emit('SIGINT');
    expect(state.pipe.destroyed).toBe(false);
    process.emit('SIGINT');
    expect(state.pipe.destroyed).toBe(true);
    expect(state.forceExit).toHaveBeenCalledExactlyOnceWith(6);

    expect(await state.result).toBeInstanceOf(CancelledError);
    expect(state.pipe.writes).toEqual([]);
    await expectClean(state);
  });

  it('closes an untransferred gate during a host-owned forced process exit', async () => {
    const before = new Set(process.listeners('exit'));
    const state = await fixture();
    state.cancel.cancel();
    const exitCleanup = process.listeners('exit').find((listener) => !before.has(listener));
    expect(exitCleanup).toBeDefined();
    exitCleanup?.call(process, 6);

    expect(state.pipe.destroyed).toBe(true);
    expect(await state.result).toBeInstanceOf(CancelledError);
    await expectClean(state);
  });

  it('never reclaims result ownership after a failed decision write', async () => {
    const state = await fixture();
    state.cancel.cancel();
    state.pipe.writeFailure = new Error('private socket failure');
    state.pipe.push(Buffer.from(`READY ${state.token}\n`));

    const error = await state.result;
    expect(error).toBeInstanceOf(ExitWithCode);
    expect(error).not.toBeInstanceOf(CancelledError);
    expect(error).toMatchObject({ code: 70 });
    expect(state.pipe.writes).toEqual([`CANCEL ${state.token}\n`]);
    await expectClean(state);
  });
});
