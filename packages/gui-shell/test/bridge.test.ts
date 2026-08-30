import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ManifestError, Session } from '@rune/engine';

const electron = vi.hoisted(() => {
  type Listener = (...args: unknown[]) => void;

  class TestBrowserWindow {
    readonly webContents = { send: vi.fn() };
    readonly listeners = new Map<string, Listener[]>();
    closeCalls = 0;

    constructor(_options: unknown) {
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

    async loadFile(_path: string): Promise<void> {}

    close(): void {
      this.closeCalls += 1;
      let prevented = false;
      this.emit('close', { preventDefault: () => (prevented = true) });
      if (!prevented) {
        this.emit('closed');
      }
    }
  }

  return {
    handlers: new Map<string, (...args: unknown[]) => unknown>(),
    windows: [] as TestBrowserWindow[],
    TestBrowserWindow,
  };
});

vi.mock('electron', () => ({
  app: { getAppPath: () => process.cwd() },
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

  it('relays one SIGTERM during execute to the Session cancel token', async () => {
    const manifestPath = fixture();
    const invocation = {
      ...shellInvocation(manifestPath, false),
      overrides: { token: 'provided-token' },
      result: join(tmpdir(), 'result.json'),
    };
    const sigterm = sigtermHarness();
    const runnerStarted = deferred();
    let cancelNotifications = 0;
    const delivered: unknown[] = [];
    const run = runWorkflow(invocation, {
      whenReady: async () => undefined,
      open: () =>
        Session.open(manifestPath, {
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
        }),
      writer: (result) => delivered.push(result),
      subscribeToSigterm: sigterm.subscribe,
    });

    await new Promise<void>((resolve) => setImmediate(resolve));
    const execute = electron.handlers.get('rune:execute');
    const execution = execute?.({});
    await runnerStarted.promise;
    sigterm.fire();
    sigterm.fire();

    await expect(execution).resolves.toMatchObject({ status: 'cancelled', exitCode: 6 });
    expect(cancelNotifications).toBe(1);
    expect(delivered).toHaveLength(1);
    await electron.handlers.get('rune:done')?.({});
    expect(await run).toBe(6);
    expect(electron.windows[0]?.closeCalls).toBe(1);
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
