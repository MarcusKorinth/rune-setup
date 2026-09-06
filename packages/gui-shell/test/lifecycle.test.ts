import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  CancelledError,
  ManifestError,
  PlatformError,
  Session,
  createFailureResult,
  resultJsonSchema,
  writeResult,
  type RunResult,
} from '@rune/engine';
import { z } from 'zod';

interface FakeWindow {
  close(): void;
}

const electronHarness = vi.hoisted(() => ({
  handlers: new Map<string, (...args: unknown[]) => unknown>(),
  duringLoad: undefined as (() => void | Promise<void>) | undefined,
  window: undefined as FakeWindow | undefined,
  closed: false,
  closeAttempts: 0,
}));

vi.mock('electron', () => {
  class FakeBrowserWindow implements FakeWindow {
    readonly webContents = {
      send: vi.fn(),
      on: vi.fn(),
    };
    readonly #listeners = new Map<string, Array<(...args: unknown[]) => void>>();

    constructor() {
      electronHarness.window = this;
    }

    once(event: string, listener: (...args: unknown[]) => void): void {
      this.on(event, listener);
    }

    on(event: string, listener: (...args: unknown[]) => void): void {
      const listeners = this.#listeners.get(event) ?? [];
      listeners.push(listener);
      this.#listeners.set(event, listeners);
    }

    show(): void {}

    close(): void {
      electronHarness.closeAttempts += 1;
      let prevented = false;
      this.#emit('close', {
        preventDefault: () => {
          prevented = true;
        },
      });
      if (!prevented && !electronHarness.closed) {
        electronHarness.closed = true;
        this.#emit('closed');
      }
    }

    async loadFile(): Promise<void> {
      await electronHarness.duringLoad?.();
    }

    #emit(event: string, ...args: unknown[]): void {
      for (const listener of this.#listeners.get(event) ?? []) {
        listener(...args);
      }
    }
  }

  return {
    app: {
      exit: vi.fn(),
      getAppPath: vi.fn(() => 'C:\\rune-shell'),
      isPackaged: false,
      whenReady: vi.fn(),
    },
    BrowserWindow: FakeBrowserWindow,
    dialog: { showErrorBox: vi.fn() },
    ipcMain: {
      handle: vi.fn((channel: string, handler: (...args: unknown[]) => unknown) => {
        electronHarness.handlers.set(channel, (...args: unknown[]) => handler({}, ...args));
      }),
    },
  };
});

import { app, dialog } from 'electron';

import {
  closeWindowOnSigterm,
  headlessRun,
  main,
  withSigtermHandler,
  windowedRun,
  windowOptions,
  type SigtermSource,
} from '../src/main/index.js';
import type { ShellInvocation } from '../src/main/argv.js';
import { completeWrite } from './stream-fixture.js';

class FakeSigtermSource implements SigtermSource {
  readonly added: Array<{ signal: 'SIGTERM'; listener: () => void }> = [];
  readonly removed: Array<{ signal: 'SIGTERM'; listener: () => void }> = [];
  listener: (() => void) | undefined;

  on(signal: 'SIGTERM', listener: () => void): void {
    this.added.push({ signal, listener });
    this.listener = listener;
  }

  off(signal: 'SIGTERM', listener: () => void): void {
    this.removed.push({ signal, listener });
    if (this.listener === listener) {
      this.listener = undefined;
    }
  }

  emit(): void {
    if (this.listener === undefined) {
      throw new Error('SIGTERM has no listener');
    }
    this.listener();
  }
}

afterEach(() => {
  vi.restoreAllMocks();
});

beforeEach(() => {
  electronHarness.handlers.clear();
  electronHarness.duringLoad = undefined;
  electronHarness.window = undefined;
  electronHarness.closed = false;
  electronHarness.closeAttempts = 0;
});

describe('the GUI shell SIGTERM lifecycle', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(app.whenReady).mockResolvedValue();
  });

  it('registers one scoped handler, invokes its action, and removes it after resolve', async () => {
    const signals = new FakeSigtermSource();
    const action = vi.fn();
    const pending = deferred<number>();
    const run = withSigtermHandler(action, () => pending.promise, signals);

    expect(signals.added).toHaveLength(1);
    expect(signals.added[0]?.signal).toBe('SIGTERM');
    signals.emit();
    expect(action).toHaveBeenCalledTimes(1);

    pending.resolve(17);
    await expect(run).resolves.toBe(17);
    expect(signals.removed).toEqual(signals.added);
    expect(signals.listener).toBeUndefined();
  });

  it('removes the scoped handler when the run rejects', async () => {
    const signals = new FakeSigtermSource();
    const failure = new Error('loadFile failed');

    await expect(
      withSigtermHandler(
        () => undefined,
        async () => {
          throw failure;
        },
        signals,
      ),
    ).rejects.toBe(failure);

    expect(signals.added).toHaveLength(1);
    expect(signals.removed).toEqual(signals.added);
    expect(signals.listener).toBeUndefined();
  });

  it('cancels a headless Session, delivers its ordinary result, and returns exit 6', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'rune-headless-sigterm-'));
    const manifestPath = join(dir, 'installer.yaml');
    const resultPath = join(dir, 'result.json');
    writeFileSync(
      manifestPath,
      [
        'schemaVersion: 1',
        'product:',
        '  name: Signal lifecycle',
        '  version: 1.0.0',
        'inputs: {}',
        'steps:',
        '  - id: wait',
        '    run:',
        '      command: wait',
        '',
      ].join('\n'),
      'utf8',
    );
    const started = deferred<void>();
    const session = await Session.open(manifestPath, {
      environment: {},
      mode: 'non-interactive',
    });
    const plan = session.plan();
    vi.spyOn(Session.prototype, 'execute').mockImplementation(async (observer, cancelToken) => {
      observer?.({ kind: 'runStarted', plan });
      observer?.({
        kind: 'stepStarted',
        stepId: 'wait',
        index: 0,
        total: 1,
        title: 'wait',
      });
      started.resolve();
      await new Promise<void>((resolve) => cancelToken?.onCancel(resolve));
      const base = createFailureResult({
        error: new CancelledError(),
        manifestPath,
        dryRun: false,
        session,
        plan,
      });
      const result = {
        ...base,
        steps: base.steps.map((step) => ({ ...step, state: 'CANCELLED' as const })),
        stepsExecuted: 1,
        stepsCancelled: 1,
        stepsNotRun: 0,
        nothingExecuted: false,
      } as RunResult;
      observer?.({
        kind: 'stepFinished',
        stepId: 'wait',
        state: 'CANCELLED',
        exitCode: undefined,
        durationMs: 0,
      });
      observer?.({ kind: 'runFinished', result });
      return result;
    });
    const cancel = vi.spyOn(Session.prototype, 'cancel');
    vi.spyOn(process.stderr, 'write').mockImplementation(completeWrite);
    const signals = new FakeSigtermSource();
    const invocation: ShellInvocation = {
      manifestPath,
      values: [],
      overrides: {},
      locale: undefined,
      result: resultPath,
      logFile: undefined,
      nonInteractive: true,
    };

    const run = headlessRun(session, invocation, signals);
    await started.promise;
    signals.emit();

    await expect(run).resolves.toBe(6);
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(JSON.parse(readFileSync(resultPath, 'utf8'))).toMatchObject({
      status: 'cancelled',
      exitCode: 6,
      mode: 'non-interactive',
      stepsCancelled: 1,
    });
    expect(signals.removed).toEqual(signals.added);
    expect(signals.listener).toBeUndefined();
  });

  it('latches SIGTERM during readiness and completes the headless cancellation flow', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'rune-early-sigterm-'));
    const manifestPath = join(dir, 'installer.yaml');
    const resultPath = join(dir, 'result.json');
    writeFileSync(
      manifestPath,
      [
        'schemaVersion: 1',
        'product:',
        '  name: Early signal lifecycle',
        '  version: 1.0.0',
        'inputs: {}',
        'steps:',
        '  - id: never-started',
        '    run:',
        '      command: unused',
        '',
      ].join('\n'),
      'utf8',
    );
    const session = await Session.open(manifestPath, {
      environment: {},
      mode: 'non-interactive',
    });
    const plan = session.plan();
    vi.spyOn(Session.prototype, 'execute').mockImplementation(async (_observer, cancelToken) => {
      expect(cancelToken?.isCancelled).toBe(true);
      return createFailureResult({
        error: new CancelledError(),
        manifestPath,
        dryRun: false,
        session,
        plan,
      });
    });
    const open = vi.spyOn(Session, 'open').mockResolvedValue(session);
    const ready = deferred<void>();
    vi.mocked(app.whenReady).mockReturnValue(ready.promise);
    const signals = new FakeSigtermSource();
    vi.spyOn(process.stderr, 'write').mockImplementation(completeWrite);

    const run = main([manifestPath, '--non-interactive', '--result', resultPath], signals);

    expect(signals.added).toHaveLength(1);
    expect(open).not.toHaveBeenCalled();
    signals.emit();
    ready.resolve();

    await run;
    expect(app.exit).toHaveBeenCalledOnce();
    expect(app.exit).toHaveBeenCalledWith(6);
    expect(JSON.parse(readFileSync(resultPath, 'utf8'))).toMatchObject({
      status: 'cancelled',
      exitCode: 6,
      mode: 'non-interactive',
      stepsNotRun: 1,
    });
    expect(signals.removed).toEqual(signals.added);
    expect(signals.listener).toBeUndefined();
  });

  it('turns windowed SIGTERM into an unconditional close request', async () => {
    const signals = new FakeSigtermSource();
    const window = { close: vi.fn() };

    await withSigtermHandler(
      closeWindowOnSigterm(window),
      async () => {
        signals.emit();
        expect(window.close).toHaveBeenCalledTimes(1);
      },
      signals,
    );

    expect(signals.removed).toEqual(signals.added);
  });
});

describe('the GUI shell main lifecycle', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(app.whenReady).mockResolvedValue();
  });

  it('maps invalid argv to usage without waiting for Electron readiness', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'rune-shell-usage-'));
    const resultPath = join(dir, 'result.json');
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(completeWrite);

    await main(['installer.yaml', '--result', resultPath, '--unknown']);

    expect(app.whenReady).not.toHaveBeenCalled();
    expect(app.exit).toHaveBeenCalledOnce();
    expect(app.exit).toHaveBeenCalledWith(2);
    expect(stderr.mock.calls.map(([text]) => String(text))).toContain('unknown flag\n');
    expect(existsSync(resultPath)).toBe(false);
    expect(dialog.showErrorBox).not.toHaveBeenCalled();
  });

  it('does not echo a malformed --set candidate in usage stderr', async () => {
    const candidate = 'distinctive-secret-candidate';
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(completeWrite);

    await main(['installer.yaml', '--set', candidate]);

    expect(app.whenReady).not.toHaveBeenCalled();
    expect(app.exit).toHaveBeenCalledWith(2);
    const output = stderr.mock.calls.map(([text]) => String(text)).join('');
    expect(output).toBe('--set expects key=value\n');
    expect(output).not.toContain(candidate);
  });

  it.each(['--set=token=distinctive-secret-candidate', '--unknown=distinctive-secret-candidate'])(
    'does not echo values embedded in an unknown flag: %s',
    async (argument) => {
      const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(completeWrite);

      await main(['installer.yaml', argument]);

      expect(app.whenReady).not.toHaveBeenCalled();
      expect(app.exit).toHaveBeenCalledWith(2);
      const output = stderr.mock.calls.map(([text]) => String(text)).join('');
      expect(output).toBe('unknown flag\n');
      expect(output).not.toContain('distinctive-secret-candidate');
    },
  );

  it('maps an unhandled readiness failure to one internal exit', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'rune-shell-readiness-'));
    const resultPath = join(dir, 'result.json');
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(completeWrite);
    vi.mocked(app.whenReady).mockRejectedValue(new Error('Electron readiness failed'));

    await main(['installer.yaml', '--result', resultPath]);

    expect(app.exit).toHaveBeenCalledOnce();
    expect(app.exit).toHaveBeenCalledWith(70);
    expect(existsSync(resultPath)).toBe(false);
    expect(stderr.mock.calls.map(([text]) => String(text))).toContain(
      'RUNE-500 (exit 70): The setup could not be started.\n',
    );
    expect(dialog.showErrorBox).toHaveBeenCalledOnce();
    expect(dialog.showErrorBox).toHaveBeenCalledWith(
      'RUNE setup failed',
      'RUNE-500 (exit 70): The setup could not be started.',
    );
  });

  it('maps a RuneError from readiness through the shared exit table', async () => {
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(completeWrite);
    vi.mocked(app.whenReady).mockRejectedValue(
      new ManifestError('RUNE-101', 'the shell manifest is invalid'),
    );

    await main(['installer.yaml']);

    expect(app.exit).toHaveBeenCalledOnce();
    expect(app.exit).toHaveBeenCalledWith(3);
    expect(stderr.mock.calls.map(([text]) => String(text))).toContain(
      'RUNE-101 (exit 3): The setup could not be started.\n',
    );
    expect(dialog.showErrorBox).toHaveBeenCalledOnce();
    expect(dialog.showErrorBox).toHaveBeenCalledWith(
      'RUNE setup failed',
      'RUNE-101 (exit 3): The setup could not be started.',
    );
  });

  it('classifies a windowed Session.open failure without echoing unregistered secrets', async () => {
    const secret = 'unregistered-open-secret';
    vi.spyOn(Session, 'open').mockRejectedValue(
      new ManifestError('RUNE-101', `the shell could not read ${secret}`),
    );
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(completeWrite);

    await main(['installer.yaml', '--set', `token=${secret}`]);

    expect(app.exit).toHaveBeenCalledOnce();
    expect(app.exit).toHaveBeenCalledWith(3);
    expect(stderr.mock.calls.map(([text]) => String(text))).toContain(
      'RUNE-101 (exit 3): The setup could not be started.\n',
    );
    expect(stderr.mock.calls.map(([text]) => String(text)).join('')).not.toContain(secret);
    expect(dialog.showErrorBox).toHaveBeenCalledOnce();
    expect(dialog.showErrorBox).toHaveBeenCalledWith(
      'RUNE setup failed',
      'RUNE-101 (exit 3): The setup could not be started.',
    );
    expect(vi.mocked(dialog.showErrorBox).mock.calls.flat().join('')).not.toContain(secret);
  });

  it('writes an actual windowed manifest-open failure to the configured result', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'rune-windowed-open-failure-'));
    const manifestPath = join(dir, 'missing-installer.yaml');
    const resultPath = join(dir, 'result.json');
    vi.spyOn(process.stderr, 'write').mockImplementation(completeWrite);

    await main([manifestPath, '--result', resultPath]);

    expect(app.exit).toHaveBeenCalledWith(3);
    expect(deliveredResult(resultPath)).toMatchObject({
      status: 'config_error',
      exitCode: 3,
      mode: 'gui',
      product: null,
      manifest: { path: manifestPath, sha256: null, schemaVersion: null },
    });
    expect(dialog.showErrorBox).toHaveBeenCalledWith(
      'RUNE setup failed',
      'RUNE-101 (exit 3): The setup could not be started.',
    );
  });

  it('keeps authenticated metadata for an actual headless input-open failure', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'rune-headless-input-failure-'));
    const manifestPath = join(dir, 'installer.yaml');
    const resultPath = join(dir, 'result.json');
    writeFileSync(
      manifestPath,
      [
        'schemaVersion: 1',
        'product:',
        '  name: Input failure',
        '  version: 1.0.0',
        'inputs:',
        '  token:',
        '    type: secret',
        'steps: []',
        '',
      ].join('\n'),
      'utf8',
    );
    vi.spyOn(process.stderr, 'write').mockImplementation(completeWrite);

    await main([manifestPath, '--non-interactive', '--result', resultPath]);

    expect(app.exit).toHaveBeenCalledWith(4);
    expect(deliveredResult(resultPath)).toMatchObject({
      status: 'input_error',
      exitCode: 4,
      mode: 'non-interactive',
      product: { name: 'Input failure', version: '1.0.0' },
      manifest: { path: manifestPath, schemaVersion: 1 },
      inputs: [],
    });
    expect(dialog.showErrorBox).not.toHaveBeenCalled();
  });

  it('writes an actual windowed values-open failure without exposing its candidate', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'rune-windowed-values-failure-'));
    const manifestPath = join(dir, 'installer.yaml');
    const valuesPath = join(dir, 'values.yaml');
    const resultPath = join(dir, 'result.json');
    const candidate = 'unregistered-values-candidate';
    writeFileSync(
      manifestPath,
      [
        'schemaVersion: 1',
        'product:',
        '  name: Values failure',
        '  version: 1.0.0',
        'inputs: {}',
        'steps: []',
        '',
      ].join('\n'),
      'utf8',
    );
    writeFileSync(valuesPath, `${candidate}: value\n`, 'utf8');
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(completeWrite);

    await main([manifestPath, '--values', valuesPath, '--result', resultPath]);

    expect(app.exit).toHaveBeenCalledWith(4);
    expect(deliveredResult(resultPath)).toMatchObject({
      status: 'input_error',
      exitCode: 4,
      mode: 'gui',
      product: { name: 'Values failure', version: '1.0.0' },
    });
    expect(stderr.mock.calls.map(([text]) => String(text)).join('')).not.toContain(candidate);
    expect(vi.mocked(dialog.showErrorBox).mock.calls.flat().join('')).not.toContain(candidate);
  });

  it('serializes a startup failure to stdout for a headless result stream', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'rune-headless-open-stdout-'));
    const manifestPath = join(dir, 'missing-installer.yaml');
    const stdout = vi.spyOn(process.stdout, 'write').mockImplementation(((
      _chunk: unknown,
      callback: () => void,
    ) => {
      callback();
      return true;
    }) as typeof process.stdout.write);
    vi.spyOn(process.stderr, 'write').mockImplementation(completeWrite);

    await main([manifestPath, '--non-interactive', '--result', '-']);

    expect(app.exit).toHaveBeenCalledWith(3);
    expect(stdout).toHaveBeenCalledOnce();
    const result = JSON.parse(String(stdout.mock.calls[0]?.[0])) as RunResult;
    expect(resultValidator.safeParse(result).success).toBe(true);
    expect(result).toMatchObject({
      status: 'config_error',
      exitCode: 3,
      mode: 'non-interactive',
    });
  });

  it('lets one RUNE-407 delivery failure override the startup error without naming the path', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'rune-open-delivery-failure-'));
    const manifestPath = join(dir, 'missing-installer.yaml');
    const blockedDirectory = join(dir, 'blocked-parent');
    const resultPath = join(blockedDirectory, 'result.json');
    writeFileSync(blockedDirectory, 'occupied', 'utf8');
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(completeWrite);

    await main([manifestPath, '--result', resultPath]);

    expect(app.exit).toHaveBeenCalledWith(1);
    expect(existsSync(resultPath)).toBe(false);
    const diagnostic = stderr.mock.calls.map(([text]) => String(text)).join('');
    expect(diagnostic).toContain('RUNE-101 (exit 3): The setup could not be started.');
    expect(diagnostic).toContain('could not write the result file');
    expect(diagnostic).not.toContain(resultPath);
    expect(dialog.showErrorBox).toHaveBeenCalledOnce();
    expect(dialog.showErrorBox).toHaveBeenCalledWith(
      'RUNE setup failed',
      'RUNE-407 (exit 1): The setup could not be started.',
    );
  });

  it('does not write a configured result for an unsupported platform error', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'rune-platform-open-failure-'));
    const resultPath = join(dir, 'result.json');
    vi.spyOn(Session, 'open').mockRejectedValue(new PlatformError('unsupported host'));
    vi.spyOn(process.stderr, 'write').mockImplementation(completeWrite);

    await main(['installer.yaml', '--non-interactive', '--result', resultPath]);

    expect(app.exit).toHaveBeenCalledWith(2);
    expect(existsSync(resultPath)).toBe(false);
  });

  it('does not turn a hard Session.open crash into a configured result', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'rune-crashed-open-'));
    const resultPath = join(dir, 'result.json');
    vi.spyOn(Session, 'open').mockRejectedValue(new Error('Session.open crashed'));
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(completeWrite);

    await main(['installer.yaml', '--non-interactive', '--result', resultPath]);

    expect(app.exit).toHaveBeenCalledWith(70);
    expect(existsSync(resultPath)).toBe(false);
    expect(stderr.mock.calls.map(([text]) => String(text))).toContain(
      'RUNE-500 (exit 70): The setup could not be started.\n',
    );
  });

  it('writes one serialized headless result to stdout for --result -', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'rune-headless-stdout-'));
    const manifestPath = join(dir, 'installer.yaml');
    const accidentalPath = join(process.cwd(), '-');
    expect(existsSync(accidentalPath)).toBe(false);
    writeFileSync(
      manifestPath,
      [
        'schemaVersion: 1',
        'product:',
        '  name: Stdout result',
        '  version: 1.0.0',
        'inputs: {}',
        'steps: []',
        '',
      ].join('\n'),
      'utf8',
    );
    const stdout = vi.spyOn(process.stdout, 'write').mockImplementation(((
      _chunk: unknown,
      callback: () => void,
    ) => {
      callback();
      return true;
    }) as typeof process.stdout.write);
    vi.spyOn(process.stderr, 'write').mockImplementation(completeWrite);

    await main([manifestPath, '--result', '-', '--non-interactive']);

    expect(app.exit).toHaveBeenCalledWith(0);
    expect(stdout).toHaveBeenCalledOnce();
    const result = JSON.parse(String(stdout.mock.calls[0]?.[0]));
    expect(result).toMatchObject({
      status: 'succeeded',
      mode: 'non-interactive',
      nothingExecuted: true,
    });
    expect(existsSync(accidentalPath)).toBe(false);
  });

  it('keeps a headless result path as an atomically written file', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'rune-headless-result-file-'));
    const manifestPath = join(dir, 'installer.yaml');
    const resultPath = join(dir, 'result.json');
    writeFileSync(
      manifestPath,
      [
        'schemaVersion: 1',
        'product:',
        '  name: File result',
        '  version: 1.0.0',
        'inputs: {}',
        'steps: []',
        '',
      ].join('\n'),
      'utf8',
    );
    const stdout = vi.spyOn(process.stdout, 'write').mockImplementation(completeWrite);
    vi.spyOn(process.stderr, 'write').mockImplementation(completeWrite);

    await main([manifestPath, '--non-interactive', '--result', resultPath]);

    expect(app.exit).toHaveBeenCalledWith(0);
    expect(stdout).not.toHaveBeenCalled();
    expect(JSON.parse(readFileSync(resultPath, 'utf8'))).toMatchObject({
      status: 'succeeded',
      mode: 'non-interactive',
    });
  });
});

describe('the GUI shell native window', () => {
  it('uses the configured logo as the native window icon', () => {
    const logo = 'C:\\workspace\\assets\\rune-icon.png';

    expect(windowOptions({ logo }).icon).toBe(logo);
  });

  it('omits the native window icon when no logo is configured', () => {
    expect(windowOptions({})).not.toHaveProperty('icon');
  });
});

describe('windowed result delivery', () => {
  it('routes renderer cancellation through native close and waits for result delivery', async () => {
    const { invocation, resultPath, session } = await windowedFixture();
    const plan = session.plan();
    const executionStarted = deferred<void>();
    const cancelRequested = deferred<void>();
    const deliveryStarted = deferred<void>();
    const releaseDelivery = deferred<void>();
    const cancelled = createFailureResult({
      error: new CancelledError(),
      manifestPath: invocation.manifestPath,
      dryRun: false,
      session,
      plan,
    });
    vi.spyOn(Session.prototype, 'execute').mockImplementation(async () => {
      executionStarted.resolve();
      await cancelRequested.promise;
      return cancelled;
    });
    const cancel = vi.spyOn(Session.prototype, 'cancel').mockImplementation(() => {
      cancelRequested.resolve();
    });
    const deliverResult = vi.fn(async (result: RunResult) => {
      deliveryStarted.resolve();
      await releaseDelivery.promise;
      await writeResult(result, resultPath);
    });
    electronHarness.duringLoad = async () => {
      const execution = Promise.resolve(bridgeHandler('rune:execute')());
      await executionStarted.promise;

      await bridgeHandler('rune:cancel')();
      expect(electronHarness.closeAttempts).toBe(1);
      expect(electronHarness.closed).toBe(false);

      await deliveryStarted.promise;
      expect(existsSync(resultPath)).toBe(false);
      releaseDelivery.resolve();
      await execution;
    };

    await expect(
      windowedRun(session, invocation, new FakeSigtermSource(), vi.fn(), undefined, deliverResult),
    ).resolves.toBe(6);
    expect(cancel).toHaveBeenCalledTimes(2);
    expect(deliverResult).toHaveBeenCalledOnce();
    expect(electronHarness.closed).toBe(true);
    expect(electronHarness.closeAttempts).toBe(2);
    expect(JSON.parse(readFileSync(resultPath, 'utf8'))).toMatchObject({
      status: 'cancelled',
      exitCode: 6,
      mode: 'gui',
    });
  });

  it('keeps rune.execute pending until the configured result exists', async () => {
    const { invocation, resultPath, session } = await windowedFixture();
    const deliveryStarted = deferred<void>();
    const releaseDelivery = deferred<void>();
    const deliverResult = vi.fn(async (result: RunResult) => {
      deliveryStarted.resolve();
      await releaseDelivery.promise;
      await writeResult(result, resultPath);
    });
    let executeSettled = false;
    electronHarness.duringLoad = async () => {
      const execute = bridgeHandler('rune:execute');
      const done = bridgeHandler('rune:done');
      const execution = Promise.resolve(execute()).then((result) => {
        expect(existsSync(resultPath)).toBe(true);
        executeSettled = true;
        return result;
      });

      await deliveryStarted.promise;
      expect(executeSettled).toBe(false);
      expect(existsSync(resultPath)).toBe(false);

      releaseDelivery.resolve();
      await execution;
      expect(existsSync(resultPath)).toBe(true);
      await done();
    };

    await expect(
      windowedRun(session, invocation, new FakeSigtermSource(), vi.fn(), undefined, deliverResult),
    ).resolves.toBe(0);
    expect(deliverResult).toHaveBeenCalledOnce();
    expect(JSON.parse(readFileSync(resultPath, 'utf8'))).toMatchObject({
      status: 'succeeded',
      exitCode: 0,
      mode: 'gui',
    });
  });

  it('defers a native close until the pending result write finishes', async () => {
    const { invocation, resultPath, session } = await windowedFixture();
    const deliveryStarted = deferred<void>();
    const releaseDelivery = deferred<void>();
    const deliverResult = vi.fn(async (result: RunResult) => {
      deliveryStarted.resolve();
      await releaseDelivery.promise;
      await writeResult(result, resultPath);
    });
    electronHarness.duringLoad = async () => {
      const execution = Promise.resolve(bridgeHandler('rune:execute')());
      await deliveryStarted.promise;

      electronHarness.window?.close();
      expect(electronHarness.closed).toBe(false);
      expect(existsSync(resultPath)).toBe(false);

      releaseDelivery.resolve();
      await execution;
    };

    await expect(
      windowedRun(session, invocation, new FakeSigtermSource(), vi.fn(), undefined, deliverResult),
    ).resolves.toBe(0);
    expect(deliverResult).toHaveBeenCalledOnce();
    expect(electronHarness.closed).toBe(true);
    expect(electronHarness.closeAttempts).toBe(2);
    expect(existsSync(resultPath)).toBe(true);
  });

  it('reports a failed result write once without returning a successful result', async () => {
    const { directory, invocation, session } = await windowedFixture();
    const blockedParent = join(directory, 'blocked-parent');
    const resultPath = join(blockedParent, 'result.json');
    writeFileSync(blockedParent, 'not a directory', 'utf8');
    const failedInvocation = { ...invocation, result: resultPath };
    const deliverResult = vi.fn((result: RunResult) => writeResult(result, resultPath));
    const displayFatal = vi.fn();
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(completeWrite);
    electronHarness.duringLoad = async () => {
      await expect(Promise.resolve(bridgeHandler('rune:execute')())).rejects.toThrow('RUNE-407');
    };

    await expect(
      windowedRun(
        session,
        failedInvocation,
        new FakeSigtermSource(),
        displayFatal,
        undefined,
        deliverResult,
      ),
    ).resolves.toBe(1);
    expect(deliverResult).toHaveBeenCalledOnce();
    expect(displayFatal).toHaveBeenCalledOnce();
    expect(displayFatal).toHaveBeenCalledWith(
      expect.objectContaining({ code: 'RUNE-407' }),
      session,
    );
    expect(stderr.mock.calls.map(([text]) => String(text)).join('')).toContain('blocked-parent');
    expect(existsSync(resultPath)).toBe(false);
  });

  it('defers native close while writing an input-error result exactly once', async () => {
    const { invocation, resultPath, session } = await windowedFixture([
      'inputs:',
      '  requiredValue:',
      '    type: text',
      '    required: true',
    ]);
    const deliveryStarted = deferred<void>();
    const releaseDelivery = deferred<void>();
    const deliverResult = vi.fn(async (result: RunResult) => {
      deliveryStarted.resolve();
      await releaseDelivery.promise;
      await writeResult(result, resultPath);
    });
    vi.spyOn(process.stderr, 'write').mockImplementation(completeWrite);
    electronHarness.duringLoad = async () => {
      const execution = Promise.resolve(bridgeHandler('rune:execute')());
      await deliveryStarted.promise;

      electronHarness.window?.close();
      expect(electronHarness.closed).toBe(false);
      expect(deliverResult).toHaveBeenCalledOnce();
      expect(existsSync(resultPath)).toBe(false);

      releaseDelivery.resolve();
      await expect(execution).rejects.toThrow('RUNE-201');
    };

    await expect(
      windowedRun(session, invocation, new FakeSigtermSource(), vi.fn(), undefined, deliverResult),
    ).resolves.toBe(4);
    expect(deliverResult).toHaveBeenCalledOnce();
    expect(electronHarness.closed).toBe(true);
    expect(electronHarness.closeAttempts).toBe(2);
    expect(JSON.parse(readFileSync(resultPath, 'utf8'))).toMatchObject({
      status: 'input_error',
      exitCode: 4,
      error: { code: 'RUNE-201' },
    });
  });
});

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T | PromiseLike<T>) => void;
} {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

const resultValidator = z.fromJSONSchema(
  resultJsonSchema() as Parameters<typeof z.fromJSONSchema>[0],
);

function deliveredResult(path: string): RunResult {
  const result = JSON.parse(readFileSync(path, 'utf8')) as RunResult;
  expect(resultValidator.safeParse(result).success).toBe(true);
  return result;
}

function bridgeHandler(channel: string): (...args: unknown[]) => unknown {
  const handler = electronHarness.handlers.get(channel);
  if (handler === undefined) {
    throw new Error(`${channel} was not registered`);
  }
  return handler;
}

async function windowedFixture(inputLines: readonly string[] = ['inputs: {}']): Promise<{
  directory: string;
  invocation: ShellInvocation;
  resultPath: string;
  session: Session;
}> {
  const directory = mkdtempSync(join(tmpdir(), 'rune-windowed-delivery-'));
  const manifestPath = join(directory, 'installer.yaml');
  const resultPath = join(directory, 'result.json');
  writeFileSync(
    manifestPath,
    [
      'schemaVersion: 1',
      'product:',
      '  name: Windowed delivery',
      '  version: 1.0.0',
      ...inputLines,
      'steps: []',
      '',
    ].join('\n'),
    'utf8',
  );
  const session = await Session.open(manifestPath, { environment: {}, mode: 'gui' });
  return {
    directory,
    invocation: {
      manifestPath,
      values: [],
      overrides: {},
      locale: undefined,
      result: resultPath,
      logFile: undefined,
      nonInteractive: false,
    },
    resultPath,
    session,
  };
}
