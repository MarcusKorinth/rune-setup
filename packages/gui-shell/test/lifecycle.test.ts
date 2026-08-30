import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import { Session } from '@rune/engine';

vi.mock('electron', () => ({
  app: {},
  BrowserWindow: class {},
  ipcMain: { handle: vi.fn() },
}));

import {
  closeWindowOnSigterm,
  headlessRun,
  withSigtermHandler,
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

describe('the GUI shell SIGTERM lifecycle', () => {
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
