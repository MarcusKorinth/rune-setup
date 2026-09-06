import { existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ExecutionError, Session, type RunEvent, type RunResult } from '@rune/engine';

const electronHarness = vi.hoisted(() => ({
  handlers: new Map<string, (...args: unknown[]) => unknown>(),
  duringLoad: undefined as (() => Promise<void>) | undefined,
  closeDuringLoad: false,
  emitRendererGone: undefined as (() => void) | undefined,
  onClosed: undefined as (() => void) | undefined,
  closed: false,
}));

vi.mock('electron', () => {
  class FakeWebContents {
    readonly send = vi.fn();
    readonly #listeners = new Map<string, Array<(...args: unknown[]) => void>>();

    on(event: string, listener: (...args: unknown[]) => void): void {
      const listeners = this.#listeners.get(event) ?? [];
      listeners.push(listener);
      this.#listeners.set(event, listeners);
    }

    emit(event: string, ...args: unknown[]): void {
      for (const listener of this.#listeners.get(event) ?? []) {
        listener(...args);
      }
    }
  }

  class FakeBrowserWindow {
    readonly webContents = new FakeWebContents();
    readonly #listeners = new Map<string, Array<(...args: unknown[]) => void>>();

    constructor() {
      electronHarness.emitRendererGone = () => {
        this.webContents.emit('render-process-gone', {}, { reason: 'crashed', exitCode: 1 });
      };
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
      let prevented = false;
      this.#emit('close', {
        preventDefault: () => {
          prevented = true;
        },
      });
      if (!prevented) {
        electronHarness.closed = true;
        electronHarness.onClosed?.();
        this.#emit('closed');
      }
    }

    async loadFile(): Promise<void> {
      if (electronHarness.closeDuringLoad) {
        this.close();
      }
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
      whenReady: vi.fn(async () => undefined),
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

import { headlessRun, main } from '../src/main/index.js';
import type { ShellInvocation } from '../src/main/argv.js';

afterEach(() => {
  vi.restoreAllMocks();
});

beforeEach(() => {
  vi.clearAllMocks();
  electronHarness.handlers.clear();
  electronHarness.duringLoad = undefined;
  electronHarness.closeDuringLoad = false;
  electronHarness.emitRendererGone = undefined;
  electronHarness.onClosed = undefined;
  electronHarness.closed = false;
});

describe('the GUI shell stderr diagnostics', () => {
  it('renders masked headless progress without contaminating result stdout', async () => {
    const secret = 'console-secret';
    const manifestPath = manifest([
      'inputs:',
      '  token:',
      '    type: secret',
      'steps:',
      '  - id: report',
      `    title: "Report ${secret}"`,
      '    run:',
      '      command: report',
    ]);
    const session = await Session.open(manifestPath, {
      environment: {},
      mode: 'non-interactive',
      overrides: { token: secret },
    });
    mockSuccessfulExecution(session, [
      { stream: 'stdout', line: `stdout ${secret}` },
      { stream: 'stderr', line: `stderr ${secret}` },
    ]);
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const stdout = vi.spyOn(process.stdout, 'write').mockImplementation(((
      _chunk: unknown,
      callback: () => void,
    ) => {
      callback();
      return true;
    }) as typeof process.stdout.write);

    await expect(headlessRun(session, { ...invocation(manifestPath), result: '-' })).resolves.toBe(
      0,
    );

    const diagnostics = stderr.mock.calls.map(([text]) => String(text)).join('');
    const resultText = stdout.mock.calls.map(([text]) => String(text)).join('');
    expect(diagnostics).toMatch(
      /^running 1 steps on \w+\r?\n\[1\/1\] Report \*\*\*\r?\n {2}stdout \*\*\*\r?\n {2}stderr \*\*\*\r?\n {2}-> SUCCEEDED \(exit 0\) after \d+ms\r?\n$/,
    );
    expect(diagnostics).not.toContain(secret);
    expect(JSON.parse(resultText)).toMatchObject({ status: 'succeeded', exitCode: 0 });
    expect(resultText).not.toContain('running 1 steps');
    expect(resultText).not.toContain(secret);
  });

  it('masks registered secrets in headless warnings', async () => {
    const manifestPath = manifest([
      'inputs:',
      '  enabled:',
      '    type: boolean',
      '    default: false',
      '  token:',
      '    type: secret',
      '  warningInput:',
      '    type: text',
      '    when: "${enabled}"',
      'steps: []',
    ]);
    const session = await Session.open(manifestPath, {
      environment: {},
      mode: 'non-interactive',
      overrides: { token: 'warningInput', warningInput: 'discarded' },
    });
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);

    await expect(headlessRun(session, invocation(manifestPath))).resolves.toBe(0);

    const output = stderr.mock.calls.map(([text]) => String(text)).join('');
    expect(output).toContain('warning: *** was set from --set');
    expect(output).not.toContain('warningInput');
  });

  it('masks registered secrets when a headless run rejects', async () => {
    const manifestPath = manifest([
      'inputs:',
      '  token:',
      '    type: secret',
      'steps:',
      '  - id: fail',
      '    run:',
      '      command: fail',
    ]);
    const session = await Session.open(manifestPath, {
      environment: {},
      mode: 'non-interactive',
      overrides: { token: 'headless-secret' },
    });
    vi.spyOn(Session.prototype, 'execute').mockRejectedValue(
      new Error('runner rejected headless-secret'),
    );
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);

    await expect(headlessRun(session, invocation(manifestPath))).resolves.toBe(70);

    expect(stderr).toHaveBeenCalledWith('runner rejected ***\n');
    expect(stderr.mock.calls.flat().join('')).not.toContain('headless-secret');
    expect(dialog.showErrorBox).not.toHaveBeenCalled();
  });

  it('shows one named and masked error when renderer execution rejects', async () => {
    const secret = 'execute-secret';
    const manifestPath = manifest([
      'inputs:',
      '  token:',
      '    type: secret',
      'steps:',
      '  - id: fail',
      '    run:',
      '      command: fail',
    ]);
    vi.spyOn(Session.prototype, 'execute').mockRejectedValue(
      new ExecutionError('RUNE-403', `cannot start ${secret}`),
    );
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    electronHarness.duringLoad = async () => {
      const execute = electronHarness.handlers.get('rune:execute');
      if (execute === undefined) {
        throw new Error('the execute handler was not registered');
      }
      try {
        await execute();
      } catch {
        // Main owns the fatal error; the bridge also rejects to the renderer.
      }
    };

    await main([manifestPath, '--set', `token=${secret}`]);

    expect(app.exit).toHaveBeenCalledWith(1);
    expect(dialog.showErrorBox).toHaveBeenCalledOnce();
    expect(dialog.showErrorBox).toHaveBeenCalledWith(
      'RUNE setup failed',
      'RUNE-403 (exit 1): cannot start ***',
    );
    expect(stderr.mock.calls.flat().join('')).not.toContain(secret);
  });

  it('masks registered secrets when windowed result delivery rejects', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'rune-shell-windowed-diagnostic-'));
    const manifestPath = manifest(['inputs:', '  token:', '    type: secret', 'steps: []'], dir);
    const secret = 'windowed-secret';
    const blockedDirectory = join(dir, `blocked-${secret}`);
    writeFileSync(blockedDirectory, 'not a directory', 'utf8');
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    electronHarness.duringLoad = async () => {
      const execute = electronHarness.handlers.get('rune:execute');
      const done = electronHarness.handlers.get('rune:done');
      if (execute === undefined || done === undefined) {
        throw new Error('the execute or done handler was not registered');
      }
      await execute();
      await done();
    };

    await main([
      manifestPath,
      '--set',
      `token=${secret}`,
      '--result',
      join(blockedDirectory, 'result.json'),
    ]);

    const output = stderr.mock.calls.map(([text]) => String(text)).join('');
    expect(app.exit).toHaveBeenCalledWith(1);
    expect(output).toContain('blocked-***');
    expect(output).not.toContain(secret);
    expect(dialog.showErrorBox).toHaveBeenCalledOnce();
    const dialogText = String(vi.mocked(dialog.showErrorBox).mock.calls[0]?.[1]);
    expect(dialogText).toContain('RUNE-407 (exit 1)');
    expect(dialogText).toContain('blocked-***');
    expect(dialogText).not.toContain(secret);
  });

  it('turns failed pre-Proceed result delivery into a masked fatal exit', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'rune-shell-close-diagnostic-'));
    const manifestPath = manifest(['inputs:', '  token:', '    type: secret', 'steps: []'], dir);
    const secret = 'close-secret';
    const blockedDirectory = join(dir, `blocked-${secret}`);
    const resultPath = join(blockedDirectory, 'cancelled.json');
    writeFileSync(blockedDirectory, 'not a directory', 'utf8');
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    electronHarness.closeDuringLoad = true;

    await expect(
      main([manifestPath, '--set', `token=${secret}`, '--result', resultPath]),
    ).resolves.toBeUndefined();

    const output = stderr.mock.calls.map(([text]) => String(text)).join('');
    expect(app.exit).toHaveBeenCalledOnce();
    expect(app.exit).toHaveBeenCalledWith(1);
    expect(output).toContain('blocked-***');
    expect(output).not.toContain(secret);
    expect(existsSync(resultPath)).toBe(false);
    expect(dialog.showErrorBox).toHaveBeenCalledOnce();
    const dialogText = String(vi.mocked(dialog.showErrorBox).mock.calls[0]?.[1]);
    expect(dialogText).toContain('RUNE-407 (exit 1)');
    expect(dialogText).toContain('blocked-***');
    expect(dialogText).not.toContain(secret);
  });

  it('treats a renderer crash before Proceed as a hard failure without a result', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'rune-shell-renderer-gone-before-run-'));
    const manifestPath = manifest(['inputs:', '  token:', '    type: secret', 'steps: []'], dir);
    const resultPath = join(dir, 'result.json');
    const secret = 'renderer-gone-secret';
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    electronHarness.duringLoad = async () => {
      electronHarness.emitRendererGone?.();
      electronHarness.emitRendererGone?.();
    };

    await main([manifestPath, '--set', `token=${secret}`, '--result', resultPath]);

    expect(app.exit).toHaveBeenCalledOnce();
    expect(app.exit).toHaveBeenCalledWith(70);
    expect(existsSync(resultPath)).toBe(false);
    expect(dialog.showErrorBox).toHaveBeenCalledOnce();
    expect(dialog.showErrorBox).toHaveBeenCalledWith(
      'RUNE setup failed',
      expect.stringContaining('RUNE-500 (exit 70): the renderer process exited unexpectedly'),
    );
    const diagnostics = stderr.mock.calls.flat().join('');
    expect(diagnostics).toContain('RUNE-500 (exit 70)');
    expect(diagnostics).not.toContain(secret);
  });

  it('awaits renderer-crash cancellation before closing and writes no result', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'rune-shell-renderer-gone-during-run-'));
    const manifestPath = manifest(
      ['inputs: {}', 'steps:', '  - id: wait', '    run:', '      command: wait'],
      dir,
    );
    const resultPath = join(dir, 'result.json');
    const started = deferred<void>();
    const cancelled = deferred<void>();
    const settlement = deferred<{ readonly kind: 'cancelled' }>();
    const order: string[] = [];
    const session = await Session.open(manifestPath, {
      environment: {},
      mode: 'gui',
    });
    vi.spyOn(Session.prototype, 'execute').mockImplementation(async () => {
      order.push('started');
      started.resolve();
      await settlement.promise;
      return session.describe();
    });
    const cancel = vi.spyOn(Session.prototype, 'cancel').mockImplementation(() => {
      order.push('cancelled');
      cancelled.resolve();
    });
    vi.spyOn(Session, 'open').mockResolvedValue(session);
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    electronHarness.onClosed = () => order.push('closed');
    electronHarness.duringLoad = async () => {
      const execute = electronHarness.handlers.get('rune:execute');
      if (execute === undefined) {
        throw new Error('the execute handler was not registered');
      }
      const execution = Promise.resolve(execute());
      await started.promise;

      electronHarness.emitRendererGone?.();
      await cancelled.promise;
      expect(electronHarness.closed).toBe(false);
      expect(existsSync(resultPath)).toBe(false);

      order.push('settling');
      settlement.resolve({ kind: 'cancelled' });
      await execution;
    };

    await main([manifestPath, '--result', resultPath]);

    expect(cancel).toHaveBeenCalledOnce();
    expect(order).toEqual(['started', 'cancelled', 'settling', 'closed']);
    expect(app.exit).toHaveBeenCalledOnce();
    expect(app.exit).toHaveBeenCalledWith(70);
    expect(existsSync(resultPath)).toBe(false);
    expect(dialog.showErrorBox).toHaveBeenCalledOnce();
  });
});

function manifest(lines: readonly string[], directory?: string): string {
  const dir = directory ?? mkdtempSync(join(tmpdir(), 'rune-shell-diagnostic-'));
  const path = join(dir, 'installer.yaml');
  writeFileSync(
    path,
    [
      'schemaVersion: 1',
      'product:',
      '  name: Diagnostic fixture',
      '  version: 1.0.0',
      ...lines,
      '',
    ].join('\n'),
    'utf8',
  );
  return path;
}

function invocation(manifestPath: string): ShellInvocation {
  return {
    manifestPath,
    values: [],
    overrides: {},
    locale: undefined,
    result: undefined,
    logFile: undefined,
    nonInteractive: true,
  };
}

function mockSuccessfulExecution(
  session: Session,
  output: readonly { readonly stream: 'stdout' | 'stderr'; readonly line: string }[],
): void {
  const plan = session.plan();
  const described = session.describe();
  const steps = described.steps.map((step) =>
    step.state === 'PENDING'
      ? { ...step, state: 'SUCCEEDED' as const, exitCode: 0, durationMs: 1 }
      : step,
  );
  const succeeded = steps.filter((step) => step.state === 'SUCCEEDED').length;
  const result = {
    ...described,
    status: 'succeeded',
    exitCode: 0,
    dryRun: false,
    error: null,
    steps,
    stepsExecuted: succeeded,
    stepsSucceeded: succeeded,
    stepsNotRun: 0,
    nothingExecuted: succeeded === 0,
  } as RunResult;

  vi.spyOn(Session.prototype, 'execute').mockImplementation(async (observer) => {
    observer?.({ kind: 'runStarted', plan });
    for (const [index, step] of plan.steps.entries()) {
      if (step.state === 'SKIPPED') {
        observer?.({
          kind: 'stepFinished',
          stepId: step.id,
          state: step.state,
          exitCode: undefined,
          durationMs: 0,
        });
        continue;
      }
      observer?.({
        kind: 'stepStarted',
        stepId: step.id,
        index,
        total: plan.steps.length,
        title: step.title,
      });
      for (const line of output) {
        observer?.({ kind: 'stepOutput', stepId: step.id, ...line } as RunEvent);
      }
      observer?.({
        kind: 'stepFinished',
        stepId: step.id,
        state: 'SUCCEEDED',
        exitCode: 0,
        durationMs: 1,
      });
    }
    observer?.({ kind: 'runFinished', result });
    return result;
  });
}

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
