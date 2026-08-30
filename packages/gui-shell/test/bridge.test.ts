import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { CancelToken, ManifestError, Session } from '@rune/engine';

const electron = vi.hoisted(() => {
  type Listener = (...args: unknown[]) => void;

  class TestWebContents {
    readonly send = vi.fn();
    readonly listeners = new Map<string, Listener[]>();

    once(event: string, listener: Listener): void {
      const onceListener: Listener = (...args) => {
        this.removeListener(event, onceListener);
        listener(...args);
      };
      this.on(event, onceListener);
    }

    on(event: string, listener: Listener): void {
      const listeners = this.listeners.get(event) ?? [];
      listeners.push(listener);
      this.listeners.set(event, listeners);
    }

    removeListener(event: string, listener: Listener): void {
      this.listeners.set(
        event,
        (this.listeners.get(event) ?? []).filter((candidate) => candidate !== listener),
      );
    }

    emit(event: string, ...args: unknown[]): void {
      for (const listener of [...(this.listeners.get(event) ?? [])]) {
        listener(...args);
      }
    }

    listenerCount(event: string): number {
      return this.listeners.get(event)?.length ?? 0;
    }
  }

  class TestBrowserWindow {
    readonly webContents = new TestWebContents();
    readonly listeners = new Map<string, Listener[]>();
    closeCalls = 0;
    destroyCalls = 0;
    destroyed = false;

    constructor(_options: unknown) {
      electron.construct();
      electron.windows.push(this);
    }

    once(event: string, listener: Listener): void {
      const onceListener: Listener = (...args) => {
        this.removeListener(event, onceListener);
        listener(...args);
      };
      this.on(event, onceListener);
    }

    on(event: string, listener: Listener): void {
      const listeners = this.listeners.get(event) ?? [];
      listeners.push(listener);
      this.listeners.set(event, listeners);
    }

    removeListener(event: string, listener: Listener): void {
      this.listeners.set(
        event,
        (this.listeners.get(event) ?? []).filter((candidate) => candidate !== listener),
      );
    }

    emit(event: string, ...args: unknown[]): void {
      for (const listener of [...(this.listeners.get(event) ?? [])]) {
        listener(...args);
      }
    }

    show(): void {}

    async loadFile(path: string): Promise<void> {
      await electron.loadFile(path);
    }

    close(): void {
      this.closeCalls += 1;
      let prevented = false;
      this.emit('close', { preventDefault: () => (prevented = true) });
      if (!prevented) {
        this.destroyed = true;
        this.emit('closed');
      }
    }

    isDestroyed(): boolean {
      return this.destroyed;
    }

    destroy(): void {
      this.destroyCalls += 1;
      this.destroyed = true;
      this.emit('closed');
    }
  }

  return {
    handlers: new Map<string, (...args: unknown[]) => unknown>(),
    windows: [] as TestBrowserWindow[],
    construct: vi.fn(() => undefined),
    loadFile: vi.fn(async (_path: string) => undefined),
    TestBrowserWindow,
  };
});

vi.mock('electron', () => ({
  app: { getAppPath: () => process.cwd(), whenReady: async () => undefined },
  BrowserWindow: electron.TestBrowserWindow,
  ipcMain: {
    handle: (channel: string, handler: (...args: unknown[]) => unknown) =>
      electron.handlers.set(channel, handler),
  },
}));

import {
  BRIDGE_CHANNELS,
  EVENT_CHANNEL,
  failureResultFor,
  headlessRun,
  openSession,
  registerBridge,
  runShell,
  runWorkflow,
  windowedRun,
} from '../src/main/index.js';

function fixture(): string {
  const dir = mkdtempSync(join(tmpdir(), 'rune-bridge-'));
  const path = join(dir, 'installer.yaml');
  writeFileSync(
    path,
    [
      'schemaVersion: 1',
      'product:',
      '  name: Example',
      '  version: "1.0.0"',
      'inputs:',
      '  installDatabase:',
      '    type: boolean',
      '    default: false',
      '  databasePort:',
      '    type: text',
      '    when: "${installDatabase}"',
      '  token:',
      '    type: secret',
      'steps:',
      '  - id: use',
      '    run:',
      '      command: deploy',
      '      args: ["--token", "${token}"]',
      '',
    ].join('\n'),
    'utf8',
  );
  return path;
}

function missingGuiAssetFixture(): string {
  const dir = mkdtempSync(join(tmpdir(), 'rune-gui-assets-'));
  const path = join(dir, 'installer.yaml');
  writeFileSync(
    path,
    [
      'schemaVersion: 1',
      'product:',
      '  name: Example',
      '  version: "1.0.0"',
      'gui:',
      '  logo: assets/missing.png',
      'inputs: {}',
      'steps: []',
      '',
    ].join('\n'),
    'utf8',
  );
  return path;
}

function emptyFixture(): string {
  const dir = mkdtempSync(join(tmpdir(), 'rune-result-delivery-'));
  const path = join(dir, 'installer.yaml');
  writeFileSync(
    path,
    [
      'schemaVersion: 1',
      'product:',
      '  name: Example',
      '  version: "1.0.0"',
      'inputs: {}',
      'steps: []',
      '',
    ].join('\n'),
    'utf8',
  );
  return path;
}

function shellInvocation(manifestPath: string, nonInteractive: boolean) {
  return {
    manifestPath,
    values: [],
    overrides: {},
    locale: undefined,
    result: undefined,
    logFile: undefined,
    nonInteractive,
  };
}

function sigtermHarness(): {
  readonly subscribe: (listener: () => void) => () => void;
  readonly fire: () => void;
  readonly active: () => number;
} {
  let listener: (() => void) | undefined;
  return {
    subscribe: (next) => {
      listener = next;
      let subscribed = true;
      return () => {
        if (subscribed) {
          subscribed = false;
          listener = undefined;
        }
      };
    },
    fire: () => {
      if (listener === undefined) {
        throw new Error('SIGTERM listener is not active');
      }
      listener();
    },
    active: () => (listener === undefined ? 0 : 1),
  };
}

function deferred(): { readonly promise: Promise<void>; readonly resolve: () => void } {
  let resolvePromise: (() => void) | undefined;
  const promise = new Promise<void>((resolve) => {
    resolvePromise = resolve;
  });
  return {
    promise,
    resolve: () => {
      resolvePromise?.();
    },
  };
}

function rejectingDeferred(): {
  readonly promise: Promise<undefined>;
  readonly reject: (error: Error) => void;
} {
  let rejectPromise: ((error: Error) => void) | undefined;
  const promise = new Promise<undefined>((_resolve, reject) => {
    rejectPromise = reject;
  });
  return {
    promise,
    reject: (error) => rejectPromise?.(error),
  };
}

async function bridgeOver(session: Session): Promise<{
  channels: string[];
  call: (channel: string, ...args: unknown[]) => Promise<unknown>;
  sent: { channel: string; payload: unknown }[];
}> {
  const handlers = new Map<string, (...args: unknown[]) => unknown>();
  const sent: { channel: string; payload: unknown }[] = [];
  registerBridge(
    session,
    { events: { send: (channel: string, payload: unknown) => sent.push({ channel, payload }) } },
    (channel, handler) => handlers.set(channel, handler),
  );
  return {
    channels: [...handlers.keys()],
    call: async (channel, ...args) => {
      const handler = handlers.get(channel);
      if (handler === undefined) {
        throw new Error(`no handler for ${channel}`);
      }
      return handler(...args);
    },
    sent,
  };
}

describe('the IPC bridge', () => {
  let sigtermListeners = new Set(process.listeners('SIGTERM'));

  beforeEach(() => {
    electron.handlers.clear();
    electron.windows.length = 0;
    electron.construct.mockReset();
    electron.construct.mockImplementation(() => undefined);
    electron.loadFile.mockReset();
    electron.loadFile.mockResolvedValue(undefined);
    sigtermListeners = new Set(process.listeners('SIGTERM'));
  });

  afterEach(() => {
    for (const listener of process.listeners('SIGTERM')) {
      if (!sigtermListeners.has(listener)) {
        process.removeListener('SIGTERM', listener);
      }
    }
    vi.restoreAllMocks();
  });

  it('checks GUI assets for windowed sessions but ignores them headlessly', async () => {
    const manifestPath = missingGuiAssetFixture();

    await expect(openSession(shellInvocation(manifestPath, false))).rejects.toThrow(
      /gui\.logo.*does not exist/,
    );
    await expect(openSession(shellInvocation(manifestPath, true))).resolves.toBeInstanceOf(Session);
  });

  it('maps malformed shell argv to one internal-error diagnostic and exit 70', async () => {
    const exit = vi.fn();
    const writeStderr = vi.fn();

    await expect(
      runShell({ argv: [], packaged: false, exit, writeStderr }),
    ).resolves.toBeUndefined();

    expect(writeStderr).toHaveBeenCalledTimes(1);
    expect(writeStderr).toHaveBeenCalledWith(
      'internal shell error: the shell needs a manifest path\n',
    );
    expect(exit).toHaveBeenCalledTimes(1);
    expect(exit).toHaveBeenCalledWith(70);
    expect(electron.windows).toHaveLength(0);
  });

  it('contains a rejected app readiness with one internal-error result and disposes SIGTERM', async () => {
    const manifestPath = fixture();
    const invocation = {
      ...shellInvocation(manifestPath, false),
      result: join(tmpdir(), 'result.json'),
    };
    const sigterm = sigtermHarness();
    const delivered: unknown[] = [];
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);

    const code = await runWorkflow(invocation, {
      whenReady: async () => {
        throw new Error('Electron startup unavailable');
      },
      writer: (result) => delivered.push(result),
      subscribeToSigterm: sigterm.subscribe,
    });

    expect(code).toBe(70);
    expect(delivered).toHaveLength(1);
    expect(delivered[0]).toMatchObject({ status: 'internal_error', exitCode: 70 });
    expect(electron.windows).toHaveLength(0);
    expect(sigterm.active()).toBe(0);
    expect(stderr).toHaveBeenCalledWith('Electron startup unavailable\n');
  });

  it('contains a rejected window load with one masked result and destroys the window', async () => {
    const manifestPath = fixture();
    const invocation = {
      ...shellInvocation(manifestPath, false),
      overrides: { token: 'super-secret-value' },
      result: join(tmpdir(), 'result.json'),
    };
    const sigterm = sigtermHarness();
    const delivered: unknown[] = [];
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    electron.loadFile.mockRejectedValueOnce(
      new Error('renderer assets unavailable for super-secret-value'),
    );

    const code = await runWorkflow(invocation, {
      whenReady: async () => undefined,
      writer: (result) => delivered.push(result),
      subscribeToSigterm: sigterm.subscribe,
    });

    expect(code).toBe(70);
    expect(delivered).toHaveLength(1);
    expect(delivered[0]).toMatchObject({ status: 'internal_error', exitCode: 70 });
    expect(electron.windows).toHaveLength(1);
    expect(electron.windows[0]?.closeCalls).toBe(0);
    expect(electron.windows[0]?.destroyCalls).toBe(1);
    expect(electron.windows[0]?.destroyed).toBe(true);
    expect(sigterm.active()).toBe(0);
    expect(stderr).toHaveBeenCalledWith('renderer assets unavailable for ***\n');
  });

  it('contains a BrowserWindow constructor rejection with one masked result', async () => {
    const manifestPath = fixture();
    const invocation = {
      ...shellInvocation(manifestPath, false),
      overrides: { token: 'super-secret-value' },
      result: join(tmpdir(), 'result.json'),
    };
    const sigterm = sigtermHarness();
    const delivered: unknown[] = [];
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    electron.construct.mockImplementationOnce(() => {
      throw new Error('window construction failed for super-secret-value');
    });

    const code = await runWorkflow(invocation, {
      whenReady: async () => undefined,
      writer: (result) => delivered.push(result),
      subscribeToSigterm: sigterm.subscribe,
    });

    expect(code).toBe(70);
    expect(delivered).toHaveLength(1);
    expect(delivered[0]).toMatchObject({ status: 'internal_error', exitCode: 70 });
    expect(electron.windows).toHaveLength(0);
    expect(sigterm.active()).toBe(0);
    expect(stderr).toHaveBeenCalledWith('window construction failed for ***\n');
  });

  it('does not retry a rejected-load result when its writer fails', async () => {
    const manifestPath = fixture();
    const invocation = {
      ...shellInvocation(manifestPath, false),
      overrides: { token: 'super-secret-value' },
      result: join(tmpdir(), 'result.json'),
    };
    const sigterm = sigtermHarness();
    let writes = 0;
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    electron.loadFile.mockRejectedValueOnce(new Error('renderer failed for super-secret-value'));

    const code = await runWorkflow(invocation, {
      whenReady: async () => undefined,
      writer: () => {
        writes += 1;
        throw new Error('disk denied for super-secret-value');
      },
      subscribeToSigterm: sigterm.subscribe,
    });

    expect(code).toBe(70);
    expect(writes).toBe(1);
    expect(electron.windows[0]?.destroyCalls).toBe(1);
    expect(sigterm.active()).toBe(0);
    expect(stderr).toHaveBeenCalledWith('renderer failed for ***\n');
    expect(stderr).toHaveBeenCalledWith('failed to write result: disk denied for ***\n');
  });

  it('treats renderer loss while idle as a hard crash without a result', async () => {
    const manifestPath = emptyFixture();
    const session = await Session.open(manifestPath, { environment: {}, mode: 'gui' });
    const invocation = {
      ...shellInvocation(manifestPath, false),
      result: join(tmpdir(), 'result.json'),
    };
    const writer = vi.fn();
    const run = windowedRun(session, invocation, writer);

    await new Promise<void>((resolve) => setImmediate(resolve));
    const window = electron.windows[0];
    if (window === undefined) {
      throw new Error('window was not created');
    }
    expect(window.webContents.listenerCount('render-process-gone')).toBe(1);
    window.webContents.emit('render-process-gone', {}, { reason: 'crashed', exitCode: -1 });

    await expect(run).resolves.toBe(70);
    expect(writer).not.toHaveBeenCalled();
    expect(window.closeCalls).toBe(0);
    expect(window.destroyCalls).toBe(1);
    expect(window.webContents.listenerCount('render-process-gone')).toBe(0);
  });

  it('cancels and finishes active runner cleanup before ending a renderer crash', async () => {
    const manifestPath = fixture();
    const runnerStarted = deferred();
    const finishCleanup = deferred();
    let cancelNotifications = 0;
    let cleanupFinished = false;
    const session = await Session.open(manifestPath, {
      environment: {},
      mode: 'gui',
      overrides: { token: 'provided-token' },
      runner: {
        run: async (request) => {
          const cancelled = new Promise<void>((resolve) => {
            request.cancel.onCancel(() => {
              cancelNotifications += 1;
              resolve();
            });
          });
          runnerStarted.resolve();
          await cancelled;
          await finishCleanup.promise;
          cleanupFinished = true;
          return { kind: 'cancelled' as const };
        },
      },
    });
    const invocation = {
      ...shellInvocation(manifestPath, false),
      result: join(tmpdir(), 'result.json'),
    };
    const writer = vi.fn();
    const cancel = vi.spyOn(session, 'cancel');
    const run = windowedRun(session, invocation, writer);

    await new Promise<void>((resolve) => setImmediate(resolve));
    const execute = electron.handlers.get('rune:execute');
    if (execute === undefined) {
      throw new Error('execute handler was not registered');
    }
    const execution = execute({});
    await runnerStarted.promise;
    const window = electron.windows[0];
    if (window === undefined) {
      throw new Error('window was not created');
    }
    window.webContents.emit('render-process-gone', {}, { reason: 'crashed', exitCode: -1 });

    expect(cancel).toHaveBeenCalledTimes(1);
    expect(cancelNotifications).toBe(1);
    expect(window.destroyCalls).toBe(0);
    expect(writer).not.toHaveBeenCalled();

    finishCleanup.resolve();
    await expect(execution).resolves.toMatchObject({ status: 'cancelled', exitCode: 6 });
    await expect(run).resolves.toBe(70);
    expect(cleanupFinished).toBe(true);
    expect(writer).not.toHaveBeenCalled();
    expect(window.closeCalls).toBe(0);
    expect(window.destroyCalls).toBe(1);
    expect(window.webContents.listenerCount('render-process-gone')).toBe(0);
  });

  it('does not write a load error result after renderer loss wins the load race', async () => {
    const manifestPath = emptyFixture();
    const session = await Session.open(manifestPath, { environment: {}, mode: 'gui' });
    const invocation = {
      ...shellInvocation(manifestPath, false),
      result: join(tmpdir(), 'result.json'),
    };
    const load = rejectingDeferred();
    electron.loadFile.mockImplementationOnce(() => load.promise);
    const writer = vi.fn();
    const run = windowedRun(session, invocation, writer);

    await new Promise<void>((resolve) => setImmediate(resolve));
    const window = electron.windows[0];
    if (window === undefined) {
      throw new Error('window was not created');
    }
    window.webContents.emit('render-process-gone', {}, { reason: 'crashed', exitCode: -1 });
    load.reject(new Error('renderer load failed after process loss'));

    await expect(run).resolves.toBe(70);
    expect(writer).not.toHaveBeenCalled();
    expect(window.destroyCalls).toBe(1);
    expect(window.webContents.listenerCount('render-process-gone')).toBe(0);
  });

  it('reports a rejected execute through onExecuteError — fatal in main, never a wedge', async () => {
    // Required input left unanswered: execute() throws at plan time.
    const session = await Session.open(fixture(), { environment: {}, mode: 'gui' });
    session.setValue('installDatabase', true);
    const errors: unknown[] = [];
    const handlers = new Map<string, (...args: unknown[]) => unknown>();
    registerBridge(
      session,
      { events: { send: () => undefined }, onExecuteError: (error) => errors.push(error) },
      (channel, handler) => handlers.set(channel, handler),
    );

    await expect(handlers.get('rune:execute')?.()).rejects.toThrow(/token|databasePort/);
    expect(errors).toHaveLength(1);
  });

  it('masks a known secret in a windowed execute error and preserves its exit code', async () => {
    const manifestPath = fixture();
    const session = await Session.open(manifestPath, {
      environment: {},
      mode: 'gui',
      overrides: { token: 'super-secret-value' },
    });
    vi.spyOn(session, 'execute').mockRejectedValue(
      new ManifestError('RUNE-103', 'windowed failure for super-secret-value'),
    );
    const invocation = {
      ...shellInvocation(manifestPath, false),
      result: join(tmpdir(), 'result.json'),
    };
    const delivered: unknown[] = [];
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const run = windowedRun(session, invocation, (result) => delivered.push(result));

    await new Promise<void>((resolve) => setImmediate(resolve));
    const execute = electron.handlers.get('rune:execute');
    expect(execute).toBeDefined();
    await expect(execute?.({})).rejects.toThrow('RUNE-103 (exit 3): windowed failure for ***');

    expect(await run).toBe(3);
    expect(delivered).toHaveLength(1);
    expect(delivered[0]).toMatchObject({ exitCode: 3, status: 'config_error' });
    const diagnostics = stderr.mock.calls.map(([message]) => String(message)).join('');
    expect(diagnostics).toContain('windowed failure for ***');
    expect(diagnostics).not.toContain('super-secret-value');
  });

  it('masks a known secret in a non-Error headless failure and preserves exit 70', async () => {
    const manifestPath = fixture();
    const session = await Session.open(manifestPath, {
      environment: {},
      mode: 'non-interactive',
      overrides: { token: 'super-secret-value' },
    });
    vi.spyOn(session, 'execute').mockRejectedValue('headless failure for super-secret-value');
    const invocation = {
      ...shellInvocation(manifestPath, true),
      result: join(tmpdir(), 'result.json'),
    };
    const delivered: unknown[] = [];
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);

    const code = await headlessRun(session, invocation, (result) => delivered.push(result));

    expect(code).toBe(70);
    expect(delivered).toHaveLength(1);
    expect(delivered[0]).toMatchObject({ exitCode: 70, status: 'internal_error' });
    const diagnostics = stderr.mock.calls.map(([message]) => String(message)).join('');
    expect(diagnostics).toContain('headless failure for ***');
    expect(diagnostics).not.toContain('super-secret-value');
  });

  it('maps an invalid headless log target to an internal-error result and exit 70', async () => {
    const manifestPath = emptyFixture();
    const logTarget = join(manifestPath, '..', 'log-target');
    mkdirSync(logTarget);
    const invocation = {
      ...shellInvocation(manifestPath, true),
      logFile: logTarget,
      result: join(manifestPath, '..', 'result.json'),
    };
    const session = await openSession(invocation);
    const delivered: unknown[] = [];
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);

    const code = await headlessRun(session, invocation, (result) => delivered.push(result));

    expect(code).toBe(70);
    expect(delivered).toHaveLength(1);
    expect(delivered[0]).toMatchObject({ exitCode: 70, status: 'internal_error' });
    expect(stderr.mock.calls.map(([message]) => String(message)).join('')).toContain(logTarget);
  });

  it('masks a known secret in a rejected IPC RuneError and preserves code metadata', async () => {
    const session = await Session.open(fixture(), {
      environment: {},
      mode: 'gui',
      overrides: { token: 'super-secret-value' },
    });
    vi.spyOn(session, 'describe').mockImplementation(() => {
      throw new ManifestError('RUNE-103', 'IPC failure for super-secret-value');
    });
    registerBridge(session, { events: { send: () => undefined } });
    const plan = electron.handlers.get('rune:plan');
    expect(plan).toBeDefined();

    let rejection: unknown;
    try {
      await plan?.({});
    } catch (error) {
      rejection = error;
    }

    expect(rejection).toBeInstanceOf(Error);
    const message = rejection instanceof Error ? rejection.message : String(rejection);
    expect(message).toBe('RUNE-103 (exit 3): IPC failure for ***');
    expect(message).not.toContain('super-secret-value');
  });

  it('retains opened-session metadata in GUI failure results', async () => {
    const manifestPath = emptyFixture();
    const session = await Session.open(manifestPath, { environment: {}, mode: 'gui' });

    const result = failureResultFor(4, shellInvocation(manifestPath, false), session);

    expect(result.product).toEqual({ name: 'Example', version: '1.0.0' });
    expect(result.locale).toBe(session.getStrings().locale);
  });

  it('leaves metadata empty for failures before a session opens', () => {
    const manifestPath = join(tmpdir(), 'missing-installer.yaml');

    const result = failureResultFor(3, shellInvocation(manifestPath, false));

    expect(result.product).toEqual({ name: '', version: '' });
    expect(result.locale).toBeNull();
  });

  it('maps an open-failure result writer failure to 70 after one diagnostic', async () => {
    const manifestPath = fixture();
    const invocation = {
      ...shellInvocation(manifestPath, false),
      result: join(tmpdir(), 'result.json'),
    };
    let writes = 0;
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);

    const code = await runWorkflow(invocation, {
      whenReady: async () => undefined,
      open: async () => {
        throw new ManifestError('RUNE-103', 'manifest rejected');
      },
      writer: () => {
        writes += 1;
        throw new Error('disk denied');
      },
    });

    expect(code).toBe(70);
    expect(writes).toBe(1);
    expect(electron.windows).toHaveLength(0);
    expect(stderr).toHaveBeenCalledWith('manifest rejected\n');
    expect(stderr).toHaveBeenCalledWith('failed to write result: disk denied\n');
  });

  it('closes a window with 70 when execute-failure result delivery fails once', async () => {
    const manifestPath = fixture();
    const invocation = {
      ...shellInvocation(manifestPath, false),
      overrides: { installDatabase: 'true', token: 'super-secret-value' },
      result: join(tmpdir(), 'result.json'),
    };
    let writes = 0;
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const run = runWorkflow(invocation, {
      whenReady: async () => undefined,
      open: () =>
        Session.open(manifestPath, {
          environment: {},
          mode: 'gui',
          overrides: invocation.overrides,
        }),
      writer: () => {
        writes += 1;
        throw new Error('disk denied for super-secret-value');
      },
    });

    await new Promise<void>((resolve) => setImmediate(resolve));
    const execute = electron.handlers.get('rune:execute');
    await expect(execute?.({})).rejects.toThrow(/databasePort/);

    expect(await run).toBe(70);
    expect(writes).toBe(1);
    expect(electron.windows[0]?.closeCalls).toBe(1);
    expect(stderr).toHaveBeenCalledWith('failed to write result: disk denied for ***\n');
  });

  it('maps a headless failure result writer failure to 70 after one masked diagnostic', async () => {
    const manifestPath = fixture();
    const invocation = {
      ...shellInvocation(manifestPath, true),
      overrides: { installDatabase: 'true', token: 'super-secret-value' },
      result: join(tmpdir(), 'result.json'),
    };
    let writes = 0;
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);

    const code = await runWorkflow(invocation, {
      whenReady: async () => undefined,
      open: () =>
        Session.open(manifestPath, {
          environment: {},
          mode: 'non-interactive',
          overrides: invocation.overrides,
        }),
      writer: () => {
        writes += 1;
        throw new Error('disk denied for super-secret-value');
      },
    });

    expect(code).toBe(70);
    expect(writes).toBe(1);
    expect(electron.windows).toHaveLength(0);
    expect(stderr).toHaveBeenCalledWith('failed to write result: disk denied for ***\n');
  });

  it('ends a headless run with 70 after one masked result-write failure', async () => {
    const manifestPath = fixture();
    const session = await Session.open(manifestPath, {
      environment: {},
      mode: 'non-interactive',
      overrides: { token: 'super-secret-value' },
      runner: { run: async () => ({ kind: 'exited', exitCode: 0 }) },
    });
    const invocation = {
      ...shellInvocation(manifestPath, true),
      result: join(tmpdir(), 'result.json'),
    };
    let writes = 0;
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);

    const code = await headlessRun(session, invocation, () => {
      writes += 1;
      throw new Error('disk denied for super-secret-value');
    });

    expect(code).toBe(70);
    expect(writes).toBe(1);
    expect(stderr).toHaveBeenCalledWith('failed to write result: disk denied for ***\n');
  });

  it('closes a windowed run with 70 when completed-result delivery fails once', async () => {
    const manifestPath = emptyFixture();
    const session = await Session.open(manifestPath, { environment: {}, mode: 'gui' });
    const invocation = {
      ...shellInvocation(manifestPath, false),
      result: join(tmpdir(), 'result.json'),
    };
    let writes = 0;
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const run = windowedRun(session, invocation, () => {
      writes += 1;
      throw new Error('disk denied');
    });

    await new Promise<void>((resolve) => setImmediate(resolve));
    const execute = electron.handlers.get('rune:execute');
    expect(execute).toBeDefined();
    await expect(execute?.({})).resolves.toMatchObject({ status: 'succeeded' });
    await expect(run).resolves.toBe(70);

    expect(writes).toBe(1);
    expect(electron.windows).toHaveLength(1);
    expect(electron.windows[0]?.closeCalls).toBe(1);
    expect(stderr).toHaveBeenCalledWith('failed to write result: disk denied\n');
  });

  it('writes one zero-counter cancelled result when closed before Proceed with inputs missing', async () => {
    const manifestPath = fixture();
    const session = await Session.open(manifestPath, { environment: {}, mode: 'gui' });
    const invocation = {
      ...shellInvocation(manifestPath, false),
      result: join(tmpdir(), 'result.json'),
    };
    const delivered: unknown[] = [];
    const run = windowedRun(session, invocation, (result) => delivered.push(result));

    await new Promise<void>((resolve) => setImmediate(resolve));
    electron.windows[0]?.close();

    expect(await run).toBe(6);
    expect(delivered).toHaveLength(1);
    expect(delivered[0]).toMatchObject({
      status: 'cancelled',
      exitCode: 6,
      product: { name: 'Example', version: '1.0.0' },
      locale: session.getStrings().locale,
      stepsTotal: 0,
      stepsExecuted: 0,
      stepsSucceeded: 0,
      stepsFailed: 0,
      stepsCancelled: 0,
      stepsSkipped: 0,
      stepsNotRun: 0,
      nothingExecuted: true,
    });
  });

  it('keeps the plan-based cancelled result when closed before Proceed', async () => {
    const manifestPath = fixture();
    const session = await Session.open(manifestPath, {
      environment: {},
      mode: 'gui',
      overrides: { token: 'provided-token' },
    });
    const invocation = {
      ...shellInvocation(manifestPath, false),
      result: join(tmpdir(), 'result.json'),
    };
    const delivered: unknown[] = [];
    const listenersBefore = process.listenerCount('SIGTERM');
    const run = windowedRun(session, invocation, (result) => delivered.push(result));

    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(process.listenerCount('SIGTERM')).toBe(listenersBefore + 1);
    electron.windows[0]?.close();

    expect(await run).toBe(6);
    expect(process.listenerCount('SIGTERM')).toBe(listenersBefore);
    expect(delivered).toHaveLength(1);
    expect(delivered[0]).toMatchObject({
      status: 'cancelled',
      exitCode: 6,
      stepsTotal: 1,
      stepsExecuted: 0,
      stepsNotRun: 1,
    });
  });

  it('ends with 70 when early-close result delivery fails once', async () => {
    const manifestPath = fixture();
    const session = await Session.open(manifestPath, { environment: {}, mode: 'gui' });
    const invocation = {
      ...shellInvocation(manifestPath, false),
      result: join(tmpdir(), 'result.json'),
    };
    let writes = 0;
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const run = windowedRun(session, invocation, () => {
      writes += 1;
      throw new Error('disk denied');
    });

    await new Promise<void>((resolve) => setImmediate(resolve));
    electron.windows[0]?.close();

    expect(await run).toBe(70);
    expect(writes).toBe(1);
    expect(stderr).toHaveBeenCalledWith('failed to write result: disk denied\n');
  });

  it('buffers one SIGTERM before app readiness and closes with one cancelled result', async () => {
    const manifestPath = fixture();
    const invocation = {
      ...shellInvocation(manifestPath, false),
      result: join(tmpdir(), 'result.json'),
    };
    const ready = deferred();
    const sigterm = sigtermHarness();
    const delivered: unknown[] = [];

    const run = runWorkflow(invocation, {
      whenReady: () => ready.promise,
      writer: (result) => delivered.push(result),
      subscribeToSigterm: sigterm.subscribe,
    });

    expect(sigterm.active()).toBe(1);
    expect(electron.windows).toHaveLength(0);
    sigterm.fire();
    sigterm.fire();
    ready.resolve();

    expect(await run).toBe(6);
    expect(delivered).toHaveLength(1);
    expect(delivered[0]).toMatchObject({
      status: 'cancelled',
      exitCode: 6,
      stepsTotal: 0,
      stepsExecuted: 0,
      stepsNotRun: 0,
    });
    expect(electron.windows).toHaveLength(1);
    expect(electron.windows[0]?.closeCalls).toBe(1);
    expect(sigterm.active()).toBe(0);
  });

  it('relays one SIGTERM after window readiness through the plan-based close path', async () => {
    const manifestPath = fixture();
    const invocation = {
      ...shellInvocation(manifestPath, false),
      overrides: { token: 'provided-token' },
      result: join(tmpdir(), 'result.json'),
    };
    const sigterm = sigtermHarness();
    const delivered: unknown[] = [];
    const run = runWorkflow(invocation, {
      whenReady: async () => undefined,
      writer: (result) => delivered.push(result),
      subscribeToSigterm: sigterm.subscribe,
    });

    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(electron.windows).toHaveLength(1);
    sigterm.fire();
    sigterm.fire();

    expect(await run).toBe(6);
    expect(delivered).toHaveLength(1);
    expect(delivered[0]).toMatchObject({
      status: 'cancelled',
      exitCode: 6,
      stepsTotal: 1,
      stepsExecuted: 0,
      stepsNotRun: 1,
    });
    expect(electron.windows[0]?.closeCalls).toBe(1);
    expect(sigterm.active()).toBe(0);
  });

  it('relays one SIGTERM during execute through cancel and the close lifecycle', async () => {
    const manifestPath = fixture();
    const invocation = {
      ...shellInvocation(manifestPath, false),
      overrides: { token: 'provided-token' },
      result: join(tmpdir(), 'result.json'),
    };
    const sigterm = sigtermHarness();
    const runnerStarted = deferred();
    let cancelNotifications = 0;
    let session: Session | undefined;
    const delivered: unknown[] = [];
    const run = runWorkflow(invocation, {
      whenReady: async () => undefined,
      open: async () => {
        session = await Session.open(manifestPath, {
          environment: {},
          mode: 'gui',
          overrides: invocation.overrides,
          runner: {
            run: async (request) =>
              new Promise((resolve) => {
                request.cancel.onCancel(() => {
                  cancelNotifications += 1;
                  resolve({ kind: 'cancelled' });
                });
                runnerStarted.resolve();
              }),
          },
        });
        return session;
      },
      writer: (result) => delivered.push(result),
      subscribeToSigterm: sigterm.subscribe,
    });

    await new Promise<void>((resolve) => setImmediate(resolve));
    const execute = electron.handlers.get('rune:execute');
    const execution = execute?.({});
    await runnerStarted.promise;
    if (session === undefined) {
      throw new Error('session did not open');
    }
    const cancel = vi.spyOn(session, 'cancel');
    sigterm.fire();
    sigterm.fire();

    await expect(execution).resolves.toMatchObject({ status: 'cancelled', exitCode: 6 });
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(cancelNotifications).toBe(1);
    expect(delivered).toHaveLength(1);
    expect(await run).toBe(6);
    expect(electron.windows[0]?.closeCalls).toBe(1);
    expect(sigterm.active()).toBe(0);
  });

  it('relays one SIGTERM during headless execute through cooperative cancellation', async () => {
    const manifestPath = fixture();
    const invocation = {
      ...shellInvocation(manifestPath, true),
      overrides: { token: 'provided-token' },
      result: join(tmpdir(), 'result.json'),
    };
    const sigterm = sigtermHarness();
    const runnerStarted = deferred();
    let cancelNotifications = 0;
    const delivered: unknown[] = [];
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const cancel = vi.spyOn(CancelToken.prototype, 'cancel');
    const run = runWorkflow(invocation, {
      whenReady: async () => undefined,
      open: () =>
        Session.open(manifestPath, {
          environment: {},
          mode: 'non-interactive',
          overrides: invocation.overrides,
          runner: {
            run: async (request) =>
              new Promise((resolve) => {
                request.cancel.onCancel(() => {
                  cancelNotifications += 1;
                  resolve({ kind: 'cancelled' });
                });
                runnerStarted.resolve();
              }),
          },
        }),
      writer: (result) => delivered.push(result),
      subscribeToSigterm: sigterm.subscribe,
    });

    expect(sigterm.active()).toBe(1);
    await runnerStarted.promise;
    expect(sigterm.active()).toBe(1);
    expect(electron.windows).toHaveLength(0);
    sigterm.fire();
    sigterm.fire();

    expect(await run).toBe(6);
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(cancelNotifications).toBe(1);
    expect(delivered).toHaveLength(1);
    expect(delivered[0]).toMatchObject({
      status: 'cancelled',
      exitCode: 6,
      stepsExecuted: 1,
      stepsCancelled: 1,
      stepsNotRun: 0,
    });
    expect(electron.windows).toHaveLength(0);
    expect(sigterm.active()).toBe(0);
  });

  it('buffers one headless SIGTERM before readiness and cancels before the runner starts', async () => {
    const manifestPath = fixture();
    const invocation = {
      ...shellInvocation(manifestPath, true),
      overrides: { token: 'provided-token' },
      result: join(tmpdir(), 'result.json'),
    };
    const ready = deferred();
    const sigterm = sigtermHarness();
    const delivered: unknown[] = [];
    const runner = vi.fn(async () => ({ kind: 'exited' as const, exitCode: 0 }));
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const cancel = vi.spyOn(CancelToken.prototype, 'cancel');
    const run = runWorkflow(invocation, {
      whenReady: () => ready.promise,
      open: () =>
        Session.open(manifestPath, {
          environment: {},
          mode: 'non-interactive',
          overrides: invocation.overrides,
          runner: { run: runner },
        }),
      writer: (result) => delivered.push(result),
      subscribeToSigterm: sigterm.subscribe,
    });

    expect(sigterm.active()).toBe(1);
    expect(electron.windows).toHaveLength(0);
    sigterm.fire();
    sigterm.fire();
    ready.resolve();

    expect(await run).toBe(6);
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(runner).not.toHaveBeenCalled();
    expect(delivered).toHaveLength(1);
    expect(delivered[0]).toMatchObject({
      status: 'cancelled',
      exitCode: 6,
      stepsTotal: 1,
      stepsExecuted: 0,
      stepsCancelled: 0,
      stepsNotRun: 1,
    });
    expect(electron.windows).toHaveLength(0);
    expect(sigterm.active()).toBe(0);
  });

  it('maps an early-cancel result writer failure to 70 and removes the listener', async () => {
    const manifestPath = fixture();
    const invocation = {
      ...shellInvocation(manifestPath, false),
      result: join(tmpdir(), 'result.json'),
    };
    const ready = deferred();
    const sigterm = sigtermHarness();
    let writes = 0;
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const run = runWorkflow(invocation, {
      whenReady: () => ready.promise,
      writer: () => {
        writes += 1;
        throw new Error('disk denied');
      },
      subscribeToSigterm: sigterm.subscribe,
    });

    sigterm.fire();
    ready.resolve();

    expect(await run).toBe(70);
    expect(writes).toBe(1);
    expect(electron.windows[0]?.closeCalls).toBe(1);
    expect(sigterm.active()).toBe(0);
    expect(stderr).toHaveBeenCalledWith('failed to write result: disk denied\n');
  });

  it('keeps the successful headless result-delivery path unchanged', async () => {
    const manifestPath = emptyFixture();
    const session = await Session.open(manifestPath, {
      environment: {},
      mode: 'non-interactive',
    });
    const invocation = {
      ...shellInvocation(manifestPath, true),
      result: join(tmpdir(), 'result.json'),
    };
    const delivered: unknown[] = [];
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true);

    const code = await headlessRun(session, invocation, (result) => delivered.push(result));

    expect(code).toBe(0);
    expect(delivered).toHaveLength(1);
  });

  it('is a 1:1 projection: exactly the pinned channels, nothing else', async () => {
    const session = await Session.open(fixture(), { environment: {}, mode: 'gui' });
    const bridge = await bridgeOver(session);

    expect(bridge.channels.sort()).toEqual([...BRIDGE_CHANNELS].sort());
  });

  it('never lets a secret cross towards the renderer', async () => {
    const session = await Session.open(fixture(), {
      environment: {},
      mode: 'gui',
      overrides: { token: 'super-secret-value' },
    });
    const bridge = await bridgeOver(session);

    const inputs = (await bridge.call('rune:allInputs')) as readonly {
      id: string;
      value: unknown;
    }[];
    expect(inputs.find((input) => input.id === 'token')?.value).toBeNull();

    await bridge.call('rune:setValue', 'installDatabase', true);
    await bridge.call('rune:setValue', 'databasePort', '5432');
    const plan = await bridge.call('rune:plan');
    expect(JSON.stringify(plan)).not.toContain('super-secret-value');
    expect(JSON.stringify(inputs)).not.toContain('super-secret-value');
  });

  it('returns the InputStateChanged list as the resolved value of setValue', async () => {
    const session = await Session.open(fixture(), { environment: {}, mode: 'gui' });
    const bridge = await bridgeOver(session);

    const changes = await bridge.call('rune:setValue', 'installDatabase', true);
    expect(changes).toEqual([{ inputId: 'databasePort', enabled: true }]);
  });

  it('pushes every run event through the serializer, pre-masked', async () => {
    const session = await Session.open(fixture(), {
      environment: {},
      mode: 'gui',
      overrides: { token: 'super-secret-value' },
      runner: {
        run: async (request) => {
          request.onOutput('stdout', 'the token is super-secret-value');
          return { kind: 'exited', exitCode: 0 };
        },
      },
    });
    session.setValue('installDatabase', false);
    const bridge = await bridgeOver(session);

    const result = (await bridge.call('rune:execute')) as { status: string; mode: string };

    expect(result.status).toBe('succeeded');
    expect(result.mode).toBe('gui');
    expect(bridge.sent.length).toBeGreaterThan(0);
    for (const { channel, payload } of bridge.sent) {
      expect(channel).toBe(EVENT_CHANNEL);
      // JSON-safe plain data only — a raw engine object would not survive this round trip.
      expect(JSON.parse(JSON.stringify(payload))).toEqual(payload);
    }
    expect(JSON.stringify(bridge.sent)).not.toContain('super-secret-value');
    expect(JSON.stringify(bridge.sent)).toContain('***');
  });
});
