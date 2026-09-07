import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { Writable } from 'node:stream';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ExecutionError, Session, type RunEvent, type RunResult } from '@rune/engine';

const electronHarness = vi.hoisted(() => ({
  handlers: new Map<string, (...args: unknown[]) => unknown>(),
  eventAck: undefined as ((event: { sender: unknown }, sequence: unknown) => void) | undefined,
  sent: [] as Array<{ channel: string; payload: unknown }>,
  duringLoad: undefined as (() => Promise<void>) | undefined,
  closeDuringLoad: false,
  emitRendererGone: undefined as (() => void) | undefined,
  onClosed: undefined as (() => void) | undefined,
  closed: false,
}));

vi.mock('electron', () => {
  class FakeWebContents {
    readonly send = vi.fn((channel: string, payload: unknown) => {
      const envelope = payload as { sequence: number; event: unknown };
      electronHarness.sent.push({ channel, payload: envelope.event });
      electronHarness.eventAck?.({ sender: this }, envelope.sequence);
    });
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
      on: vi.fn(
        (_channel: string, listener: (event: { sender: unknown }, sequence: unknown) => void) => {
          electronHarness.eventAck = listener;
        },
      ),
      off: vi.fn(
        (_channel: string, listener: (event: { sender: unknown }, sequence: unknown) => void) => {
          if (electronHarness.eventAck === listener) electronHarness.eventAck = undefined;
        },
      ),
      handle: vi.fn((channel: string, handler: (...args: unknown[]) => unknown) => {
        electronHarness.handlers.set(channel, (...args: unknown[]) => handler({}, ...args));
      }),
    },
  };
});

import { app, dialog } from 'electron';

import { headlessRun, main } from '../src/main/index.js';
import type { ShellInvocation } from '../src/main/argv.js';
import { completeWrite } from './stream-fixture.js';
import { guardShellStreams } from '../src/main/streams.js';

afterEach(() => {
  vi.restoreAllMocks();
});

beforeEach(() => {
  vi.clearAllMocks();
  electronHarness.handlers.clear();
  electronHarness.sent = [];
  electronHarness.duringLoad = undefined;
  electronHarness.closeDuringLoad = false;
  electronHarness.emitRendererGone = undefined;
  electronHarness.onClosed = undefined;
  electronHarness.closed = false;
});

describe('the GUI shell stderr diagnostics', () => {
  it('backpressures headless progress on a slow stderr sink and retains every line', async () => {
    const manifestPath = manifest([
      'inputs: {}',
      'steps:',
      '  - id: report',
      '    run:',
      '      command: report',
    ]);
    const session = await Session.open(manifestPath, { environment: {}, mode: 'non-interactive' });
    mockSuccessfulExecution(session, [
      { stream: 'stdout', line: 'first retained line' },
      { stream: 'stderr', line: 'second retained line' },
    ]);
    const chunks: string[] = [];
    let release: (() => void) | undefined;
    const stderr = new Writable({
      write(chunk: Buffer, _encoding, callback) {
        chunks.push(chunk.toString());
        if (chunks.length === 1) release = callback;
        else callback();
      },
    });
    const output = guardShellStreams({
      stderr,
      stdout: new Writable({
        write(_chunk, _encoding, callback) {
          callback();
        },
      }),
    });
    const running = headlessRun(session, invocation(manifestPath), undefined, output);
    try {
      await vi.waitFor(() => expect(chunks).toHaveLength(1));
      await new Promise<void>((resolve) => setImmediate(resolve));
      // A producer that only queues writes would already have buffered all later events.
      expect(stderr.writableLength).toBe(Buffer.byteLength(chunks[0]!));
      release?.();
      await expect(running).resolves.toBe(0);
      expect(chunks.join('')).toContain('  first retained line\n  second retained line\n');
      expect(stderr.writableLength).toBe(0);
    } finally {
      output.dispose();
    }
  });

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
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(completeWrite);
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
      /^running 1 steps on \w+\r?\nStep 1 of 1: Report \*\*\*\r?\n {2}stdout \*\*\*\r?\n {2}stderr \*\*\*\r?\n {2}-> SUCCEEDED \(exit 0\) after \d+ms\r?\n$/,
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
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(completeWrite);

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
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(completeWrite);

    await expect(headlessRun(session, invocation(manifestPath))).resolves.toBe(70);

    expect(stderr.mock.calls.map(([text]) => String(text))).toContain('runner rejected ***\n');
    expect(stderr.mock.calls.map(([text]) => String(text)).join('')).not.toContain(
      'headless-secret',
    );
    expect(dialog.showErrorBox).not.toHaveBeenCalled();
  });

  it('preserves the plan topology when headless log preparation fails', async () => {
    const fixture = blockedLogFixture('rune-shell-headless-log-failure-');
    const session = await Session.open(fixture.manifestPath, {
      environment: {},
      mode: 'non-interactive',
      logFile: fixture.logPath,
    });
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(completeWrite);

    await expect(
      headlessRun(session, {
        ...invocation(fixture.manifestPath),
        result: fixture.resultPath,
        logFile: fixture.logPath,
      }),
    ).resolves.toBe(1);

    expect(JSON.parse(readFileSync(fixture.resultPath, 'utf8'))).toMatchObject({
      status: 'failed',
      exitCode: 1,
      error: { code: 'RUNE-406' },
      stepsTotal: 2,
      stepsExecuted: 0,
      stepsSucceeded: 0,
      stepsFailed: 0,
      stepsCancelled: 0,
      stepsSkipped: 1,
      stepsNotRun: 1,
      nothingExecuted: true,
      steps: [
        { id: 'runnable', state: 'NOT_RUN' },
        { id: 'skipped', state: 'SKIPPED' },
      ],
    });
    expect(existsSync(fixture.sentinelPath)).toBe(false);
    expect(stderr.mock.calls.map(([text]) => String(text)).join('')).toContain('log file');
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
    const localeDir = join(dirname(manifestPath), 'locales');
    mkdirSync(localeDir);
    writeFileSync(
      join(localeDir, 'de.yaml'),
      `rune.dialog.fatal.title: "RUNE Fehler ${secret}"\n`,
      'utf8',
    );
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(completeWrite);
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

    await main([manifestPath, '--locale', 'de', '--set', `token=${secret}`]);

    expect(app.exit).toHaveBeenCalledWith(1);
    expect(dialog.showErrorBox).toHaveBeenCalledOnce();
    expect(dialog.showErrorBox).toHaveBeenCalledWith(
      'RUNE Fehler ***',
      'RUNE-403 (exit 1): cannot start ***',
    );
    expect(stderr.mock.calls.map(([text]) => String(text)).join('')).not.toContain(secret);
  });

  it('preserves the plan topology when windowed log preparation fails', async () => {
    const fixture = blockedLogFixture('rune-shell-windowed-log-failure-');
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(completeWrite);
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

    await main([
      fixture.manifestPath,
      '--log-file',
      fixture.logPath,
      '--result',
      fixture.resultPath,
    ]);

    expect(app.exit).toHaveBeenCalledWith(1);
    expect(JSON.parse(readFileSync(fixture.resultPath, 'utf8'))).toMatchObject({
      status: 'failed',
      exitCode: 1,
      error: { code: 'RUNE-406' },
      stepsTotal: 2,
      stepsExecuted: 0,
      stepsSucceeded: 0,
      stepsFailed: 0,
      stepsCancelled: 0,
      stepsSkipped: 1,
      stepsNotRun: 1,
      nothingExecuted: true,
      steps: [
        { id: 'runnable', state: 'NOT_RUN' },
        { id: 'skipped', state: 'SKIPPED' },
      ],
    });
    expect(existsSync(fixture.sentinelPath)).toBe(false);
    expect(dialog.showErrorBox).toHaveBeenCalledOnce();
    expect(stderr.mock.calls.map(([text]) => String(text)).join('')).toContain('log file');
  });

  it('delivers the terminal result after a windowed late log close failure', async () => {
    const manifestPath = manifest([
      'inputs: {}',
      'steps:',
      '  - id: completed',
      '    run:',
      '      command: echo',
    ]);
    const resultPath = join(dirname(manifestPath), 'result.json');
    const session = await Session.open(manifestPath, { environment: {}, mode: 'gui' });
    const plan = session.plan();
    const described = session.describe();
    if (described.status !== 'planned') {
      throw new Error('the fixture did not produce a planned result');
    }
    const completedSteps = described.steps.map((step) =>
      step.state === 'PENDING'
        ? { ...step, state: 'SUCCEEDED' as const, exitCode: 0, durationMs: 1 }
        : step,
    );
    const terminalResult = {
      ...described,
      status: 'failed' as const,
      exitCode: 1,
      dryRun: false,
      error: { code: 'RUNE-406' as const, message: 'the log close failed', location: null },
      steps: completedSteps,
      stepsExecuted: 1,
      stepsSucceeded: 1,
      stepsFailed: 0,
      stepsCancelled: 0,
      stepsSkipped: 0,
      stepsNotRun: 0,
      nothingExecuted: false,
    } satisfies RunResult;
    vi.spyOn(Session, 'open').mockResolvedValue(session);
    vi.spyOn(Session.prototype, 'execute').mockImplementation(async (observer) => {
      await observer?.({ kind: 'runStarted', plan });
      await observer?.({
        kind: 'stepStarted',
        stepId: 'completed',
        index: 0,
        total: 1,
        title: 'completed',
      });
      await observer?.({
        kind: 'stepFinished',
        stepId: 'completed',
        state: 'SUCCEEDED',
        exitCode: 0,
        durationMs: 1,
      });
      await observer?.({ kind: 'runFinished', result: terminalResult });
      throw new ExecutionError('RUNE-406', 'the log close failed');
    });
    vi.spyOn(process.stderr, 'write').mockImplementation(completeWrite);
    electronHarness.duringLoad = async () => {
      const execute = electronHarness.handlers.get('rune:execute');
      if (execute === undefined) {
        throw new Error('the execute handler was not registered');
      }
      await expect(execute()).rejects.toThrow('RUNE-406');
    };

    await main([manifestPath, '--result', resultPath]);

    expect(app.exit).toHaveBeenCalledWith(1);
    const serialized = JSON.parse(readFileSync(resultPath, 'utf8'));
    expect(serialized).toMatchObject({
      status: 'failed',
      exitCode: 1,
      error: { code: 'RUNE-406' },
      stepsExecuted: 1,
      stepsSucceeded: 1,
      stepsFailed: 0,
      stepsNotRun: 0,
      nothingExecuted: false,
      steps: [{ id: 'completed', state: 'SUCCEEDED', exitCode: 0 }],
    });
    const terminalEvent = electronHarness.sent.find(
      (event) => (event.payload as { kind?: unknown }).kind === 'runFinished',
    );
    expect(terminalEvent).toEqual({
      channel: 'rune:event',
      payload: {
        kind: 'runFinished',
        result: {
          ...serialized,
          displaySummary:
            'failed: 1 succeeded, 0 failed, 0 skipped, 0 cancelled, 0 not run (exit 1)',
          steps: [{ ...serialized.steps[0], displayTitle: 'completed (exit 0)' }],
        },
      },
    });
  });

  it('masks registered secrets when windowed result delivery rejects', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'rune-shell-windowed-diagnostic-'));
    const manifestPath = manifest(['inputs:', '  token:', '    type: secret', 'steps: []'], dir);
    const secret = 'windowed-secret';
    const blockedDirectory = join(dir, `blocked-${secret}`);
    writeFileSync(blockedDirectory, 'not a directory', 'utf8');
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(completeWrite);
    electronHarness.duringLoad = async () => {
      const execute = electronHarness.handlers.get('rune:execute');
      if (execute === undefined) {
        throw new Error('the execute handler was not registered');
      }
      await expect(execute()).rejects.toThrow('RUNE-407');
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
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(completeWrite);
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
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(completeWrite);
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
      'RUNE',
      'RUNE-500 (exit 70): The setup could not be started.',
    );
    const diagnostics = stderr.mock.calls.map(([text]) => String(text)).join('');
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
    vi.spyOn(process.stderr, 'write').mockImplementation(completeWrite);
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

function blockedLogFixture(prefix: string): {
  readonly manifestPath: string;
  readonly logPath: string;
  readonly resultPath: string;
  readonly sentinelPath: string;
} {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  const blockedParent = join(dir, 'blocked-parent');
  const sentinelPath = join(dir, 'runner-started');
  writeFileSync(blockedParent, 'not a directory', 'utf8');
  return {
    manifestPath: manifest(
      [
        'inputs:',
        '  enabled:',
        '    type: boolean',
        '    default: false',
        'steps:',
        '  - id: runnable',
        '    run:',
        `      command: ${JSON.stringify(process.execPath)}`,
        `      args: ${JSON.stringify([
          '-e',
          `require('node:fs').writeFileSync(${JSON.stringify(sentinelPath)}, 'started')`,
        ])}`,
        '  - id: skipped',
        '    when: "${enabled}"',
        '    run:',
        `      command: ${JSON.stringify(process.execPath)}`,
      ],
      dir,
    ),
    logPath: join(blockedParent, 'run.log'),
    resultPath: join(dir, 'result.json'),
    sentinelPath,
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
    await observer?.({ kind: 'runStarted', plan });
    for (const [index, step] of plan.steps.entries()) {
      if (step.state === 'SKIPPED') {
        await observer?.({
          kind: 'stepFinished',
          stepId: step.id,
          state: step.state,
          exitCode: undefined,
          durationMs: 0,
        });
        continue;
      }
      await observer?.({
        kind: 'stepStarted',
        stepId: step.id,
        index,
        total: plan.steps.length,
        title: step.title,
      });
      for (const line of output) {
        await observer?.({ kind: 'stepOutput', stepId: step.id, ...line } as RunEvent);
      }
      await observer?.({
        kind: 'stepFinished',
        stepId: step.id,
        state: 'SUCCEEDED',
        exitCode: 0,
        durationMs: 1,
      });
    }
    await observer?.({ kind: 'runFinished', result });
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
