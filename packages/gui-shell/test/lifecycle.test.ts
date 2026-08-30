import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ManifestError, Session } from '@rune/engine';

vi.mock('electron', () => ({
  app: {
    exit: vi.fn(),
    getAppPath: vi.fn(() => 'C:\\rune-shell'),
    isPackaged: false,
    whenReady: vi.fn(),
  },
  BrowserWindow: class {},
  ipcMain: { handle: vi.fn() },
}));

import { app } from 'electron';

import {
  closeWindowOnSigterm,
  headlessRun,
  main,
  withSigtermHandler,
  windowOptions,
  type SigtermSource,
} from '../src/main/index.js';
import type { ShellInvocation } from '../src/main/argv.js';

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
      runner: {
        run: async (request) => {
          started.resolve();
          return new Promise((resolve) => {
            request.cancel.onCancel(() => resolve({ kind: 'cancelled' }));
          });
        },
      },
    });
    const cancel = vi.spyOn(session, 'cancel');
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
      runner: {
        run: vi.fn(async () => {
          throw new Error('a latched cancellation must stop before the runner');
        }),
      },
    });
    const open = vi.spyOn(Session, 'open').mockResolvedValue(session);
    const ready = deferred<void>();
    vi.mocked(app.whenReady).mockReturnValue(ready.promise);
    const signals = new FakeSigtermSource();
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true);

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
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);

    await main(['--unknown']);

    expect(app.whenReady).not.toHaveBeenCalled();
    expect(app.exit).toHaveBeenCalledOnce();
    expect(app.exit).toHaveBeenCalledWith(2);
    expect(stderr).toHaveBeenCalledWith('unknown flag --unknown\n');
  });

  it('maps an unhandled readiness failure to one internal exit', async () => {
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    vi.mocked(app.whenReady).mockRejectedValue(new Error('Electron readiness failed'));

    await main(['installer.yaml']);

    expect(app.exit).toHaveBeenCalledOnce();
    expect(app.exit).toHaveBeenCalledWith(70);
    expect(stderr).toHaveBeenCalledWith('Electron readiness failed\n');
  });

  it('maps a RuneError from readiness through the shared exit table', async () => {
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    vi.mocked(app.whenReady).mockRejectedValue(
      new ManifestError('RUNE-101', 'the shell manifest is invalid'),
    );

    await main(['installer.yaml']);

    expect(app.exit).toHaveBeenCalledOnce();
    expect(app.exit).toHaveBeenCalledWith(3);
    expect(stderr).toHaveBeenCalledWith('the shell manifest is invalid\n');
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
    const stdout = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true);

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
    const stdout = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true);

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
