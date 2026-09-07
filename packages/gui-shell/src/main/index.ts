/**
 * Electron main process of the RUNE GUI shell (docs/architecture.md §9.4): hosts
 * `@rune/engine` in-process, owns the one Session, registers the IPC handlers, creates
 * the window, and exits with the engine's exit code. The renderer drives the engine
 * exclusively through the bridge (§9.2); nothing engine-side is reachable another way.
 */

import { join, resolve } from 'node:path';

import { BrowserWindow, app, dialog, type BrowserWindowConstructorOptions } from 'electron';

import {
  CancelToken,
  CancelledError,
  InternalError,
  PlatformError,
  RESULT_LOG_COLLISION_MESSAGE,
  RuneError,
  Session,
  UsageError,
  createFailureResult,
  exitCodeFor,
  formatIssues,
  formatSessionTerminalLine,
  sameSinkPath,
  serializeResult,
  writeResult,
  type ExecutionPlan,
  type RunResult,
  type ThemeConfig,
} from '@rune/engine';

import {
  isShellVersionProbe,
  parseShellArgv,
  shellVersionProbeOutput,
  type ShellInvocation,
} from './argv.js';
import { registerBridge } from './bridge.js';
import { windowTheme } from './serialize.js';
import { shellProgressObserver, writeSessionChromeDiagnostic } from './progress.js';
import {
  fallbackOutput,
  guardShellStreams,
  type ShellProcessStreams,
  type ShellStreams,
} from './streams.js';
import { createEventDelivery } from './eventDelivery.js';
import { takeStartupGate, type StartupGate } from './startup.js';

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

export function windowOptions(
  theme: Pick<ThemeConfig, 'logo' | 'windowTitle'>,
): BrowserWindowConstructorOptions {
  return {
    width: 900,
    height: 640,
    show: false,
    autoHideMenuBar: true,
    ...(theme.logo === undefined ? {} : { icon: theme.logo }),
    ...(theme.windowTitle === undefined ? {} : { title: theme.windowTitle }),
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
  processStreams: ShellProcessStreams = { stdout: process.stdout, stderr: process.stderr },
  startup: StartupGate | undefined = takeStartupGate(),
): Promise<void> {
  // Install both error owners before argv parsing or Electron readiness can emit a diagnostic.
  const output = guardShellStreams(processStreams);
  if (isShellVersionProbe(argv)) {
    await output.stdout.writeAndWait(shellVersionProbeOutput());
    // Use Electron's initialized message-loop exit path on Windows.
    if (process.platform === 'win32') await app.whenReady();
    const exitCode = output.stdout.failed() ? 70 : 0;
    output.dispose();
    app.exit(exitCode);
    return;
  }

  let exitCode: number;
  let invocation: ShellInvocation | undefined;
  let openingSession = false;
  let windowed = false;
  let activeSession: Session | undefined;
  let fatalDisplayed = false;
  const displayFatal = (error: unknown, session: Session | undefined): void => {
    if (!windowed || fatalDisplayed) {
      return;
    }
    fatalDisplayed = true;
    showWindowedFatal(error, session);
  };
  const routedSignals = new LatchedSigtermSource();
  const routeSignal = (): void => routedSignals.request();
  // Electron's native POSIX signal handler requests app.quit(). Keep the existing
  // cancellation and result owners alive until main deliberately calls app.exit().
  const routeNativeQuit = (event: { preventDefault(): void }): void => {
    event.preventDefault();
    routedSignals.request();
  };
  signals.on('SIGTERM', routeSignal);
  app.on('before-quit', routeNativeQuit);
  try {
    if (startup !== undefined && (await startup()) === 'cancel') {
      routedSignals.request();
    }
    const parsedInvocation = parseShellArgv(argv);
    if (
      parsedInvocation.result !== undefined &&
      parsedInvocation.result !== '-' &&
      parsedInvocation.logFile !== undefined &&
      sameSinkPath(resolve(parsedInvocation.result), resolve(parsedInvocation.logFile))
    ) {
      // Refuse explicit flag collisions before even a malformed manifest can produce a result.
      throw new UsageError(RESULT_LOG_COLLISION_MESSAGE);
    }
    invocation = parsedInvocation;
    windowed = !parsedInvocation.nonInteractive;
    await app.whenReady();
    openingSession = true;
    const session = await openSession(parsedInvocation);
    openingSession = false;
    activeSession = session;

    exitCode = await (parsedInvocation.nonInteractive
      ? headlessRun(session, parsedInvocation, routedSignals, output)
      : windowedRun(session, parsedInvocation, routedSignals, displayFatal, output));
  } catch (error) {
    if (windowed && activeSession !== undefined && invocation !== undefined) {
      // The host is alive with authenticated Session context, so this remains a configured run.
      const failure = await failWith(
        new InternalError('the setup window could not be started', { cause: error }),
        invocation,
        activeSession,
        output,
      );
      displayFatal(failure.error, undefined);
      exitCode = failure.exitCode;
    } else if (
      openingSession &&
      invocation !== undefined &&
      !(error instanceof UsageError) &&
      !(error instanceof PlatformError)
    ) {
      const failure =
        error instanceof RuneError
          ? error
          : new InternalError('the setup could not be started', { cause: error });
      output.stderr.write(`${describeWindowedFatal(failure, undefined)}\n`);
      const deliveryError = await deliverOpenFailure(failure, invocation, output);
      if (deliveryError === undefined) {
        displayFatal(failure, undefined);
        exitCode = exitCodeFor(failure);
      } else {
        writeOpenDeliveryDiagnostic(deliveryError, output);
        displayFatal(deliveryError, undefined);
        exitCode = exitCodeFor(deliveryError);
      }
    } else {
      const message =
        windowed || openingSession
          ? describeWindowedFatal(error, activeSession)
          : error instanceof Error
            ? error.message
            : String(error);
      output.stderr.write(`${message}\n`);
      displayFatal(error, undefined);
      exitCode = exitCodeFor(error);
    }
  } finally {
    // Startup failures can deliver a result asynchronously too; keep cancellation latched
    // through that delivery instead of restoring the native signal action in the catch path.
    signals.off('SIGTERM', routeSignal);
    app.off('before-quit', routeNativeQuit);
  }
  const effectiveExitCode = output.stdout.failed() ? 70 : exitCode;
  output.dispose();
  app.exit(effectiveExitCode);
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
  output?: ShellStreams,
): Promise<number> {
  const ownedOutput =
    output ?? guardShellStreams({ stdout: process.stdout, stderr: process.stderr });
  const cancel = new CancelToken();
  const run = withSigtermHandler(
    () => {
      // Preserve Session.cancel() as the public shell action (§9.4). The explicit token also
      // remembers a signal that arrived before execute() installed it on the Session.
      cancel.cancel();
      session.cancel();
    },
    () => executeHeadless(session, invocation, cancel, ownedOutput),
    signals,
  );
  if (output !== undefined) {
    return run;
  }
  return run
    .then((code) => (ownedOutput.stdout.failed() ? 70 : code))
    .finally(() => ownedOutput.dispose());
}

async function executeHeadless(
  session: Session,
  invocation: ShellInvocation,
  cancel: CancelToken,
  output: ShellStreams,
): Promise<number> {
  let plan: ExecutionPlan | undefined;
  let terminalResult: RunResult | undefined;
  let result: RunResult;
  try {
    plan = session.plan();
    const progress = shellProgressObserver(session, output);
    result = await session.execute((event) => {
      if (event.kind === 'runFinished') {
        terminalResult = event.result;
      }
      return progress(event);
    }, cancel);
  } catch (error) {
    return (await failWith(error, invocation, session, output, terminalResult, plan)).exitCode;
  }

  for (const warning of session.warnings()) {
    await writeSessionChromeDiagnostic(session, output, 'rune.warning', { message: warning });
  }
  if (result.nothingExecuted) {
    await writeSessionChromeDiagnostic(session, output, 'rune.warning', {
      message: session.getStrings().chrome('rune.result.nothingExecuted'),
    });
  }
  try {
    await deliver(result, invocation, output);
  } catch (error) {
    writeDeliveryDiagnostic(session, error, output);
    return error instanceof RuneError ? exitCodeFor(error) : 70;
  }
  return result.exitCode;
}

export async function windowedRun(
  session: Session,
  invocation: ShellInvocation,
  signals: SigtermSource,
  displayFatal: (error: unknown, session: Session | undefined) => void,
  output: ShellStreams = fallbackOutput(),
  deliverResult: (result: RunResult, invocation: ShellInvocation) => Promise<void> = (
    result,
    target,
  ) => deliver(result, target, output),
): Promise<number> {
  const window = new BrowserWindow(windowOptions(windowTheme(session)));
  const events = createEventDelivery(window.webContents);
  window.once('ready-to-show', () => window.show());
  window.once('closed', () => events.dispose());

  let running = false;
  let closeRequested = false;
  let outcome: RunResult | undefined;
  let fatalCode: number | undefined;
  let renderedDone = false;
  let rendererGone = false;
  let sigtermRequested = false;
  let closeFinalizing = false;
  let deliveryOwned = false;
  let deliveryPending = false;
  let delivery: Promise<void> | undefined;
  const deliverOutcome = (result: RunResult): Promise<void> => {
    if (delivery === undefined) {
      // Claim the terminal outcome before the delivery callback can run or throw.
      deliveryOwned = true;
      deliveryPending = true;
      delivery = Promise.resolve()
        .then(() => deliverResult(result, invocation))
        .finally(() => {
          deliveryPending = false;
        });
    }
    return delivery;
  };

  registerBridge(session, {
    output,
    events,
    onExecuteStart: () => {
      if (closeRequested || closeFinalizing) {
        throw new CancelledError();
      }
      running = true;
    },
    onExecuteEnd: async (result) => {
      running = false;
      if (rendererGone) {
        // A renderer crash is a hard shell failure, not an ordinary cancelled outcome.
        window.close();
        return;
      }
      try {
        await deliverOutcome(result);
        outcome = result;
      } catch (error) {
        writeDeliveryDiagnostic(session, error, output);
        fatalCode = error instanceof RuneError ? exitCodeFor(error) : 70;
        displayFatal(error, session);
        throw error;
      } finally {
        if (closeRequested || fatalCode !== undefined) {
          // The shell finishes its own cancel (§9.4), or closes after a failed delivery.
          window.close();
        }
      }
    },
    onExecuteError: async (error, plan, terminalResult) => {
      // Errors from execute are FATAL: main, not the renderer, maps them (§9.2).
      running = false;
      if (rendererGone) {
        // The renderer crash already owns the fatal classification and diagnostic.
        window.close();
        return;
      }
      const failure = await failWith(
        error,
        invocation,
        session,
        output,
        terminalResult,
        plan,
        deliverOutcome,
      );
      fatalCode = failure.exitCode;
      displayFatal(failure.error, plan === undefined ? undefined : session);
      window.close();
    },
    onCancelRequested: () => window.close(),
    onRendererDone: () => {
      if (outcome === undefined || deliveryPending) {
        return;
      }
      renderedDone = true;
      window.close();
    },
  });

  window.webContents.on('render-process-gone', () => {
    events.dispose();
    if (rendererGone || renderedDone) {
      return;
    }
    rendererGone = true;
    if (deliveryOwned) {
      // The claimed attempt decides the result and exit code; renderer loss only closes.
      window.close();
      return;
    }
    const error = new InternalError('the renderer process exited unexpectedly');
    fatalCode = exitCodeFor(error);
    if (running) {
      // Synchronous planning cannot interleave with this event, and its failure hook clears
      // running before awaiting. A true value therefore proves a completed-plan masker is active.
      writeSessionDiagnostic(session, describeWindowedFatal(error, session), output);
      session.cancel();
      displayFatal(error, session);
      return;
    }
    output.stderr.write(`${describeWindowedFatal(error, undefined)}\n`);
    displayFatal(error, undefined);
    window.close();
  });

  window.on('close', (event) => {
    if (deliveryPending || (deliveryOwned && outcome === undefined && fatalCode === undefined)) {
      event.preventDefault();
      closeRequested = true;
      return;
    }
    if (running) {
      event.preventDefault();
      closeRequested = true;
      events.dispose();
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
        let hasPlan = false;
        try {
          const cancelled = describeCancelled(session, invocation);
          hasPlan = cancelled.hasPlan;
          await deliverOutcome(cancelled.result);
          outcome = cancelled.result;
        } catch (error) {
          if (hasPlan) {
            writeDeliveryDiagnostic(session, error, output);
          } else {
            writeOpenDeliveryDiagnostic(error, output);
          }
          fatalCode = error instanceof RuneError ? exitCodeFor(error) : 70;
          displayFatal(error, hasPlan ? session : undefined);
        } finally {
          window.close();
        }
      })();
    }
  });
  const closed = new Promise<void>((resolve) => window.on('closed', () => resolve()));

  try {
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
  } finally {
    events.dispose();
  }

  if (fatalCode !== undefined) {
    return fatalCode;
  }
  if (outcome !== undefined) {
    return outcome.exitCode;
  }
  // Closed before Proceed with inputs still missing: cancelled, nothing planned.
  return renderedDone ? 0 : 6;
}

function describeWindowedFatal(error: unknown, session: Session | undefined): string {
  const code = error instanceof RuneError ? error.code : 'RUNE-500';
  const prefix = `${code} (exit ${exitCodeFor(error)})`;
  if (session === undefined) {
    // Opening or planning may fail without a complete authenticated masker. Keep this
    // sink useful without echoing data whose secret transformations are not available.
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
    dialog.showErrorBox(
      session?.getStrings().chrome('rune.dialog.fatal.title') ?? 'RUNE',
      describeWindowedFatal(error, session),
    );
  } catch {
    // A failed native dialog must not replace the original error or its exit code.
  }
}

class StdoutDeliveryError extends Error {}

async function deliver(
  result: RunResult,
  invocation: ShellInvocation,
  output: ShellStreams,
): Promise<void> {
  if (invocation.result === '-') {
    // Headless result streams own stdout (§4.1, §10); everything else stays on stderr.
    const outcome = await output.stdout.writeAndWait(serializeResult(result));
    if (outcome === 'failed') {
      throw new StdoutDeliveryError();
    }
    return;
  }
  if (invocation.result !== undefined) {
    await writeResult(result, invocation.result);
  }
}

async function deliverOpenFailure(
  error: RuneError,
  invocation: ShellInvocation,
  output: ShellStreams,
): Promise<unknown | undefined> {
  try {
    const result = createFailureResult({
      error,
      manifestPath: invocation.manifestPath,
      dryRun: false,
      mode: invocation.nonInteractive ? 'non-interactive' : 'gui',
    });
    await deliver(result, invocation, output);
    return undefined;
  } catch (deliveryError) {
    return deliveryError;
  }
}

async function failWith(
  error: unknown,
  invocation: ShellInvocation,
  session: Session,
  output: ShellStreams,
  terminalResult?: RunResult,
  plan?: ExecutionPlan,
  deliverResult: (result: RunResult, invocation: ShellInvocation) => Promise<void> = (
    result,
    target,
  ) => deliver(result, target, output),
): Promise<{ readonly exitCode: number; readonly error: unknown }> {
  const failure =
    error instanceof RuneError
      ? error
      : new InternalError('an unexpected error escaped the shell run', { cause: error });
  writeSessionDiagnostic(session, error instanceof Error ? error.message : String(error), output);

  try {
    const result =
      terminalResult ??
      createFailureResult({
        error: failure,
        manifestPath: invocation.manifestPath,
        dryRun: false,
        session,
        ...(plan === undefined ? {} : { plan }),
      });
    await deliverResult(result, invocation);
  } catch (deliveryError) {
    if (plan === undefined) {
      writeOpenDeliveryDiagnostic(deliveryError, output);
    } else {
      writeDeliveryDiagnostic(session, deliveryError, output);
    }
    return {
      exitCode: deliveryError instanceof RuneError ? exitCodeFor(deliveryError) : 70,
      error: deliveryError,
    };
  }
  return { exitCode: exitCodeFor(failure), error: failure };
}

function describeCancelled(
  session: Session,
  invocation: ShellInvocation,
): { readonly result: RunResult; readonly hasPlan: boolean } {
  let plan: ReturnType<Session['plan']> | undefined;
  try {
    plan = session.plan();
  } catch (error) {
    if (error instanceof InternalError || !(error instanceof RuneError)) {
      throw error;
    }
  }
  return {
    result: createFailureResult({
      error: new CancelledError(),
      manifestPath: invocation.manifestPath,
      dryRun: false,
      session,
      ...(plan === undefined ? {} : { plan }),
    }),
    hasPlan: plan !== undefined,
  };
}

/** Writes one shell-owned diagnostic through the Session's authenticated terminal sink. */
function writeSessionDiagnostic(session: Session, message: string, output: ShellStreams): void {
  output.stderr.write(`${formatSessionTerminalLine(session.getStrings(), message)}\n`);
}

function writeDeliveryDiagnostic(session: Session, error: unknown, output: ShellStreams): void {
  if (error instanceof StdoutDeliveryError) {
    return;
  }
  writeSessionDiagnostic(session, error instanceof Error ? error.message : String(error), output);
}

function writeOpenDeliveryDiagnostic(error: unknown, output: ShellStreams): void {
  if (error instanceof StdoutDeliveryError) {
    return;
  }
  output.stderr.write(
    `${error instanceof RuneError && error.code === 'RUNE-407' ? 'could not write the result file' : describeWindowedFatal(error, undefined)}\n`,
  );
}

// Under vitest the module is imported for its exports; only Electron runs the app.
if (
  process.versions['electron'] !== undefined &&
  (process as { type?: string }).type === 'browser'
) {
  void main();
}
