/**
 * Electron main process of the RUNE GUI shell (docs/architecture.md §9.4): hosts
 * `@rune/engine` in-process, owns the one Session, registers the IPC handlers, creates
 * the window, and exits with the engine's exit code. The renderer drives the engine
 * exclusively through the bridge (§9.2); nothing engine-side is reachable another way.
 */

import { join } from 'node:path';

import {
  BrowserWindow,
  app,
  dialog,
  ipcMain,
  type BrowserWindowConstructorOptions,
  type WebContents,
} from 'electron';

import {
  CancelToken,
  CancelledError,
  InternalError,
  PlatformError,
  RUNE_VERSION,
  RuneError,
  Session,
  UsageError,
  createFailureResult,
  exitCodeFor,
  formatIssues,
  formatSessionTerminalLine,
  serializeResult,
  writeResult,
  type RunEvent,
  type RunResult,
  type ThemeConfig,
} from '@rune/engine';

import { parseShellArgv, type ShellInvocation } from './argv.js';
import { project, projectEvent, projectPlan, projectResult, projectTheme } from './serialize.js';

/** The §9.2 channel names — one per facade method, pinned by the bridge unit test. */
export const BRIDGE_CHANNELS = [
  'rune:open',
  'rune:pendingInputs',
  'rune:allInputs',
  'rune:setValue',
  'rune:plan',
  'rune:describe',
  'rune:execute',
  'rune:cancel',
  'rune:getStrings',
  'rune:getThemeConfig',
  'rune:warnings',
  'rune:done',
] as const;

export const EVENT_CHANNEL = 'rune:event';

export interface SigtermSource {
  on(signal: 'SIGTERM', listener: () => void): void;
  off(signal: 'SIGTERM', listener: () => void): void;
}

/** Keeps one early SIGTERM until the selected shell lifecycle is ready to receive it. */
class LatchedSigtermSource implements SigtermSource {
  #listener: (() => void) | undefined;
  #requested = false;

  on(_signal: 'SIGTERM', listener: () => void): void {
    this.#listener = listener;
    if (this.#requested) {
      listener();
    }
  }

  off(_signal: 'SIGTERM', listener: () => void): void {
    if (this.#listener === listener) {
      this.#listener = undefined;
    }
  }

  request(): void {
    if (this.#requested) {
      return;
    }
    this.#requested = true;
    this.#listener?.();
  }
}

/** Keeps a process signal listener scoped to exactly one asynchronous shell run. */
export async function withSigtermHandler<T>(
  action: () => void,
  run: () => Promise<T>,
  source: SigtermSource = process,
): Promise<T> {
  const listener = (): void => action();
  source.on('SIGTERM', listener);
  try {
    return await run();
  } finally {
    source.off('SIGTERM', listener);
  }
}

/** SIGTERM in windowed mode enters the ordinary close-window state machine. */
export function closeWindowOnSigterm(window: Pick<BrowserWindow, 'close'>): () => void {
  return () => window.close();
}

export function windowOptions(theme: Pick<ThemeConfig, 'logo'>): BrowserWindowConstructorOptions {
  return {
    width: 900,
    height: 640,
    show: false,
    autoHideMenuBar: true,
    ...(theme.logo === undefined ? {} : { icon: theme.logo }),
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      preload: join(app.getAppPath(), 'dist', 'preload', 'index.cjs'),
    },
  };
}

export async function main(
  argv: readonly string[] = process.argv.slice(app.isPackaged ? 1 : 2),
  signals: SigtermSource = process,
): Promise<void> {
  let exitCode: number;
  let invocation: ShellInvocation | undefined;
  let openingSession = false;
  let windowed = false;
  let activeSession: Session | undefined;
  let fatalDisplayed = false;
  const displayFatal = (error: unknown, session = activeSession): void => {
    if (!windowed || fatalDisplayed) {
      return;
    }
    fatalDisplayed = true;
    showWindowedFatal(error, session);
  };
  try {
    const parsedInvocation = parseShellArgv(argv);
    invocation = parsedInvocation;
    windowed = !parsedInvocation.nonInteractive;
    const routedSignals = new LatchedSigtermSource();
    exitCode = await withSigtermHandler(
      () => routedSignals.request(),
      async () => {
        await app.whenReady();
        openingSession = true;
        const session = await openSession(parsedInvocation);
        openingSession = false;
        activeSession = session;

        return parsedInvocation.nonInteractive
          ? headlessRun(session, parsedInvocation, routedSignals)
          : windowedRun(session, parsedInvocation, routedSignals, displayFatal);
      },
      signals,
    );
  } catch (error) {
    if (
      openingSession &&
      invocation !== undefined &&
      error instanceof RuneError &&
      !(error instanceof UsageError) &&
      !(error instanceof PlatformError)
    ) {
      process.stderr.write(`${describeWindowedFatal(error, undefined)}\n`);
      const deliveryError = await deliverOpenFailure(error, invocation);
      if (deliveryError === undefined) {
        displayFatal(error);
        exitCode = exitCodeFor(error);
      } else {
        process.stderr.write(
          `${deliveryError instanceof RuneError && deliveryError.code === 'RUNE-407' ? 'could not write the result file' : describeWindowedFatal(deliveryError, undefined)}\n`,
        );
        displayFatal(deliveryError);
        exitCode = exitCodeFor(deliveryError);
      }
    } else {
      const message =
        windowed || openingSession
          ? describeWindowedFatal(error, activeSession)
          : error instanceof Error
            ? error.message
            : String(error);
      process.stderr.write(`${message}\n`);
      displayFatal(error);
      exitCode = exitCodeFor(error);
    }
  }
  app.exit(exitCode);
}

async function openSession(invocation: ShellInvocation): Promise<Session> {
  return Session.open(invocation.manifestPath, {
    values: invocation.values,
    overrides: invocation.overrides,
    locale: invocation.locale,
    logFile: invocation.logFile,
    ...(invocation.result === undefined || invocation.result === '-'
      ? {}
      : { resultDestination: invocation.result }),
    mode: invocation.nonInteractive ? 'non-interactive' : 'gui',
  });
}

export function headlessRun(
  session: Session,
  invocation: ShellInvocation,
  signals: SigtermSource = process,
): Promise<number> {
  const cancel = new CancelToken();
  return withSigtermHandler(
    () => {
      // Preserve Session.cancel() as the public shell action (§9.4). The explicit token also
      // remembers a signal that arrived before execute() installed it on the Session.
      cancel.cancel();
      session.cancel();
    },
    () => executeHeadless(session, invocation, cancel),
    signals,
  );
}

async function executeHeadless(
  session: Session,
  invocation: ShellInvocation,
  cancel: CancelToken,
): Promise<number> {
  let terminalResult: RunResult | undefined;
  let result: RunResult;
  try {
    const progress = shellProgressObserver(session);
    result = await session.execute((event) => {
      if (event.kind === 'runFinished') {
        terminalResult = event.result;
      }
      progress(event);
    }, cancel);
  } catch (error) {
    return failWith(error, invocation, session, terminalResult);
  }

  for (const warning of session.warnings()) {
    writeSessionDiagnostic(session, `warning: ${warning}`);
  }
  if (result.nothingExecuted) {
    writeSessionDiagnostic(session, 'warning: nothing was executed');
  }
  try {
    await deliver(result, invocation);
  } catch (error) {
    writeSessionDiagnostic(session, error instanceof Error ? error.message : String(error));
    return error instanceof RuneError ? exitCodeFor(error) : 70;
  }
  return result.exitCode;
}

async function windowedRun(
  session: Session,
  invocation: ShellInvocation,
  signals: SigtermSource,
  displayFatal: (error: unknown, session?: Session) => void,
): Promise<number> {
  const window = new BrowserWindow(windowOptions(session.getThemeConfig()));
  window.once('ready-to-show', () => window.show());

  let running = false;
  let closeRequested = false;
  let outcome: RunResult | undefined;
  let fatalCode: number | undefined;
  let renderedDone = false;
  let rendererGone = false;
  let sigtermRequested = false;
  let closeFinalizing = false;
  let delivery: Promise<void> | undefined;
  const deliverOutcome = (result: RunResult): Promise<void> => {
    delivery ??= deliver(result, invocation);
    return delivery;
  };

  registerBridge(session, {
    events: window.webContents,
    onExecuteStart: () => {
      running = true;
    },
    onExecuteEnd: async (result) => {
      running = false;
      if (rendererGone) {
        // A renderer crash is a hard shell failure, not an ordinary cancelled outcome.
        window.close();
        return;
      }
      outcome = result;
      if (closeRequested) {
        // The shell finishes its own cancel (§9.4): the close that started it completes.
        try {
          await deliverOutcome(result);
        } catch (error) {
          outcome = undefined;
          writeSessionDiagnostic(session, error instanceof Error ? error.message : String(error));
          fatalCode = error instanceof RuneError ? exitCodeFor(error) : 70;
          displayFatal(error, session);
        }
        window.close();
      }
    },
    onExecuteError: async (error) => {
      // Errors from execute are FATAL: main, not the renderer, maps them (§9.2).
      running = false;
      if (rendererGone) {
        // The renderer crash already owns the fatal classification and diagnostic.
        window.close();
        return;
      }
      fatalCode = await failWith(error, invocation, session);
      displayFatal(error, session);
      window.close();
    },
    onRendererDone: async () => {
      renderedDone = true;
      if (outcome !== undefined) {
        try {
          await deliverOutcome(outcome);
        } catch (error) {
          outcome = undefined;
          writeSessionDiagnostic(session, error instanceof Error ? error.message : String(error));
          fatalCode = error instanceof RuneError ? exitCodeFor(error) : 70;
          displayFatal(error, session);
        }
      }
      window.close();
    },
  });

  window.webContents.on('render-process-gone', () => {
    if (rendererGone || renderedDone) {
      return;
    }
    rendererGone = true;
    const error = new InternalError('the renderer process exited unexpectedly');
    fatalCode = exitCodeFor(error);
    writeSessionDiagnostic(session, describeWindowedFatal(error, session));

    if (running) {
      // Let the engine settle its cooperative cancellation before closing the host window.
      session.cancel();
      displayFatal(error, session);
      return;
    }
    displayFatal(error, session);
    window.close();
  });

  window.on('close', (event) => {
    if (running) {
      event.preventDefault();
      closeRequested = true;
      session.cancel();
      return;
    }
    if (outcome === undefined && fatalCode === undefined && !renderedDone) {
      // Closed before Proceed: a cancelled result over the plan when one exists (§10).
      event.preventDefault();
      if (closeFinalizing) {
        return;
      }
      closeFinalizing = true;
      void (async () => {
        try {
          const cancelled = describeCancelled(session, invocation);
          await deliverOutcome(cancelled);
          outcome = cancelled;
        } catch (error) {
          writeSessionDiagnostic(session, error instanceof Error ? error.message : String(error));
          fatalCode = error instanceof RuneError ? exitCodeFor(error) : 70;
          displayFatal(error, session);
        } finally {
          window.close();
        }
      })();
    }
  });
  const closed = new Promise<void>((resolve) => window.on('closed', () => resolve()));

  await withSigtermHandler(
    () => {
      sigtermRequested = true;
      closeWindowOnSigterm(window)();
    },
    async () => {
      if (!sigtermRequested) {
        try {
          await window.loadFile(join(app.getAppPath(), 'src', 'renderer', 'index.html'));
        } catch (error) {
          if (!sigtermRequested && !rendererGone) {
            throw error;
          }
        }
      }
      await closed;
    },
    signals,
  );

  if (fatalCode !== undefined) {
    return fatalCode;
  }
  if (outcome !== undefined) {
    return outcome.exitCode;
  }
  // Closed before Proceed with inputs still missing: cancelled, nothing planned.
  return renderedDone ? 0 : 6;
}

/** Wires every facade method to its one channel; the §9.2 serializer guards each return. */
export function registerBridge(
  session: Session,
  hooks: {
    events: Pick<WebContents, 'send'>;
    onExecuteStart?: () => void;
    onExecuteEnd?: (result: RunResult) => void | Promise<void>;
    onExecuteError?: (error: unknown) => void | Promise<void>;
    onRendererDone?: () => void | Promise<void>;
  },
  register: (channel: string, handler: (...args: unknown[]) => unknown) => void = (c, h) =>
    ipcMain.handle(c, (_event, ...args: unknown[]) => h(...args)),
): void {
  const mask = (text: string): string => formatSessionTerminalLine(session.getStrings(), text);
  const handle = (channel: string, handler: (...args: unknown[]) => unknown): void => {
    register(channel, async (...args: unknown[]) => {
      try {
        return project(await handler(...args));
      } catch (error) {
        throw bridgeError(error, mask);
      }
    });
  };

  handle('rune:open', () => ({
    runeVersion: RUNE_VERSION,
    inputTypes: [...new Set(Object.values(session.manifest.inputs).map((spec) => spec.type))],
    product: {
      name: mask(session.manifest.product.name),
      version: mask(session.manifest.product.version),
    },
  }));
  handle('rune:pendingInputs', () => session.pendingInputs());
  handle('rune:allInputs', () => session.allInputs());
  handle('rune:setValue', (id, raw) => session.setValue(String(id), raw));
  handle('rune:plan', () => projectPlan(session.plan(), mask));
  handle('rune:describe', () => projectResult(session.describe(), mask));
  handle('rune:getStrings', () => session.getStrings().entries);
  handle('rune:getThemeConfig', () => projectTheme(session.getThemeConfig(), mask));
  handle('rune:warnings', () => session.warnings());
  handle('rune:cancel', () => {
    session.cancel();
    return undefined;
  });
  handle('rune:execute', async () => {
    hooks.onExecuteStart?.();
    try {
      const consoleObserver = shellProgressObserver(session);
      const result = await session.execute((event: RunEvent) => {
        // Keep the terminal sink independent of renderer delivery. The engine owns the
        // observer exception boundary, so neither sink can corrupt the run.
        try {
          consoleObserver(event);
        } finally {
          hooks.events.send(EVENT_CHANNEL, projectEvent(event, mask));
        }
      });
      await hooks.onExecuteEnd?.(result);
      return projectResult(result, mask);
    } catch (error) {
      await hooks.onExecuteError?.(error);
      throw error;
    }
  });
  handle('rune:done', async () => {
    await hooks.onRendererDone?.();
    return undefined;
  });
}

function bridgeError(error: unknown, mask: (text: string) => string): Error {
  if (error instanceof RuneError) {
    return new Error(
      mask(`${error.code} (exit ${exitCodeFor(error)}): ${formatIssues(error.issues)}`),
    );
  }
  if (error instanceof Error) {
    return new Error(mask(error.message));
  }
  try {
    return new Error(mask(String(error)));
  } catch {
    return new Error('RUNE-500 (exit 70): An unexpected shell error occurred.');
  }
}

function describeWindowedFatal(error: unknown, session: Session | undefined): string {
  const code = error instanceof RuneError ? error.code : 'RUNE-500';
  const prefix = `${code} (exit ${exitCodeFor(error)})`;
  if (session === undefined) {
    // Session.open may fail before input secrets can be registered. Keep this sink useful
    // without echoing manifest, values-file, or command-line data that cannot yet be masked.
    return `${prefix}: The setup could not be started.`;
  }
  const details =
    error instanceof RuneError
      ? formatIssues(error.issues)
      : error instanceof Error
        ? error.message
        : 'An unexpected shell error occurred.';
  return formatSessionTerminalLine(session.getStrings(), `${prefix}: ${details}`);
}

function showWindowedFatal(error: unknown, session: Session | undefined): void {
  try {
    dialog.showErrorBox('RUNE setup failed', describeWindowedFatal(error, session));
  } catch {
    // A failed native dialog must not replace the original error or its exit code.
  }
}

async function deliver(result: RunResult, invocation: ShellInvocation): Promise<void> {
  if (invocation.result === '-') {
    // Headless result streams own stdout (§4.1, §10); everything else stays on stderr.
    await new Promise<void>((resolve, reject) => {
      process.stdout.write(serializeResult(result), (error?: Error | null) => {
        if (error === undefined || error === null) {
          resolve();
        } else {
          reject(error);
        }
      });
    });
    return;
  }
  if (invocation.result !== undefined) {
    await writeResult(result, invocation.result);
  }
}

async function deliverOpenFailure(
  error: RuneError,
  invocation: ShellInvocation,
): Promise<unknown | undefined> {
  try {
    const result = createFailureResult({
      error,
      manifestPath: invocation.manifestPath,
      dryRun: false,
      mode: invocation.nonInteractive ? 'non-interactive' : 'gui',
    });
    await deliver(result, invocation);
    return undefined;
  } catch (deliveryError) {
    return deliveryError;
  }
}

async function failWith(
  error: unknown,
  invocation: ShellInvocation,
  session: Session,
  terminalResult?: RunResult,
): Promise<number> {
  const failure =
    error instanceof RuneError
      ? error
      : new InternalError('an unexpected error escaped the shell run', { cause: error });
  writeSessionDiagnostic(session, error instanceof Error ? error.message : String(error));

  try {
    const result =
      terminalResult ??
      createFailureResult({
        error: failure,
        manifestPath: invocation.manifestPath,
        dryRun: false,
        session,
      });
    await deliver(result, invocation);
  } catch (deliveryError) {
    writeSessionDiagnostic(
      session,
      deliveryError instanceof Error ? deliveryError.message : String(deliveryError),
    );
    return deliveryError instanceof RuneError ? exitCodeFor(deliveryError) : 70;
  }
  return exitCodeFor(failure);
}

function describeCancelled(session: Session, invocation: ShellInvocation): RunResult {
  let plan: ReturnType<Session['plan']> | undefined;
  try {
    plan = session.plan();
  } catch (error) {
    if (error instanceof InternalError || !(error instanceof RuneError)) {
      throw error;
    }
  }
  return createFailureResult({
    error: new CancelledError(),
    manifestPath: invocation.manifestPath,
    dryRun: false,
    session,
    ...(plan === undefined ? {} : { plan }),
  });
}

/** Writes one shell-owned diagnostic through the Session's authenticated terminal sink. */
function writeSessionDiagnostic(session: Session, message: string): void {
  process.stderr.write(`${formatSessionTerminalLine(session.getStrings(), message)}\n`);
}

/** Renders the shell's copy of the shared run-event stream to diagnostic stderr. */
function shellProgressObserver(session: Session): (event: RunEvent) => void {
  return (event) => {
    switch (event.kind) {
      case 'runStarted':
        writeSessionDiagnostic(
          session,
          `running ${event.plan.steps.length} steps on ${event.plan.platform}`,
        );
        break;
      case 'stepStarted':
        writeSessionDiagnostic(session, `[${event.index + 1}/${event.total}] ${event.title}`);
        break;
      case 'stepOutput':
        writeSessionDiagnostic(session, `  ${event.line}`);
        break;
      case 'stepFinished':
        writeSessionDiagnostic(
          session,
          `  -> ${event.state}` +
            (event.exitCode === undefined ? '' : ` (exit ${event.exitCode})`) +
            ` after ${event.durationMs}ms`,
        );
        break;
      case 'runFinished':
        break;
    }
  };
}

// Under vitest the module is imported for its exports; only Electron runs the app.
if (
  process.versions['electron'] !== undefined &&
  (process as { type?: string }).type === 'browser'
) {
  void main();
}
