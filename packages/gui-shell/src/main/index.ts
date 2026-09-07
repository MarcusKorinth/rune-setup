/**
 * Electron main process of the RUNE GUI shell (docs/architecture.md §9.4): hosts
 * `@rune/engine` in-process, owns the one Session, registers the IPC handlers, creates
 * the window, and exits with the engine's exit code. The renderer drives the engine
 * exclusively through the bridge (§9.2); nothing engine-side is reachable another way.
 */

import { join, resolve } from 'node:path';

import {
  BrowserWindow,
  app,
  dialog,
  ipcMain,
  type BrowserWindowConstructorOptions,
} from 'electron';

import {
  CancelToken,
  CancelledError,
  InternalError,
  PlatformError,
  RESULT_LOG_COLLISION_MESSAGE,
  RUNE_VERSION,
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
  type ChromeKey,
  type ExecutionPlan,
  type RunEvent,
  type RunResult,
  type ThemeConfig,
} from '@rune/engine';

import {
  isShellVersionProbe,
  parseShellArgv,
  shellVersionProbeOutput,
  type ShellInvocation,
} from './argv.js';
import type { BridgeReply } from '../preload/types.js';
import {
  project,
  projectEvent,
  projectError,
  projectPlan,
  projectResult,
  projectTheme,
  projectWarnings,
} from './serialize.js';
import { guardShellStreams, type ShellProcessStreams, type ShellStreams } from './streams.js';
import { createEventDelivery } from './eventDelivery.js';
import { takeStartupGate, type StartupGate } from './startup.js';

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
  let initialMainFrameNavigationStarted = false;
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

  const handleRendererLoss = (): void => {
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
  };

  window.webContents.on('render-process-gone', handleRendererLoss);
  window.webContents.on('did-start-navigation', (details) => {
    if (!details.isMainFrame || details.isSameDocument) {
      return;
    }
    if (!initialMainFrameNavigationStarted) {
      initialMainFrameNavigationStarted = true;
      return;
    }
    handleRendererLoss();
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

/** Wires every facade method to its one channel; the §9.2 serializer guards each return. */
export function registerBridge(
  session: Session,
  hooks: {
    output?: ShellStreams;
    events: { send(channel: string, payload: unknown): unknown };
    onExecuteStart?: () => void;
    onExecuteEnd?: (result: RunResult) => void | Promise<void>;
    onExecuteError?: (
      error: unknown,
      plan?: ExecutionPlan,
      terminalResult?: RunResult,
    ) => void | Promise<void>;
    onCancelRequested?: () => void;
    onRendererDone?: () => void | Promise<void>;
  },
  register: (channel: string, handler: (...args: unknown[]) => unknown) => void = (c, h) =>
    ipcMain.handle(c, (_event, ...args: unknown[]) => h(...args)),
): void {
  const output = hooks.output ?? fallbackOutput();
  const maskError = (text: string): string => formatSessionTerminalLine(session.getStrings(), text);
  const rejectedEdits = new Map<
    string,
    { readonly safeError: string; readonly rawCandidate?: string }
  >();
  const handle = (channel: string, handler: (...args: unknown[]) => unknown): void => {
    register(channel, async (...args: unknown[]): Promise<BridgeReply<unknown>> => {
      try {
        const value = project(await handler(...args));
        return { ok: true, ...(value === undefined ? {} : { value }) };
      } catch (error) {
        return { ok: false, error: projectError(error, maskError) };
      }
    });
  };

  handle('rune:open', () => ({
    runeVersion: RUNE_VERSION,
    inputTypes: [...new Set(Object.values(session.manifest.inputs).map((spec) => spec.type))],
    product: {
      name: session.manifest.product.name,
      version: session.manifest.product.version,
    },
  }));
  handle('rune:pendingInputs', () => session.pendingInputs());
  handle('rune:allInputs', () => {
    const inputs = session.allInputs();
    for (const input of inputs) {
      if (!input.enabled) {
        rejectedEdits.delete(input.id);
      }
    }
    const strings = session.getStrings();
    return inputs.map((input) => {
      const rejected = rejectedEdits.get(input.id);
      if (rejected === undefined) {
        return input;
      }
      const candidate =
        rejected.rawCandidate === undefined
          ? {}
          : { candidate: formatSessionTerminalLine(strings, rejected.rawCandidate) };
      return {
        ...input,
        editRejection: {
          ...candidate,
          displayText: formatSessionTerminalLine(strings, rejected.safeError),
        },
      };
    });
  });
  handle('rune:setValue', (id, raw) => {
    const inputId = String(id);
    const current = session.allInputs().find((input) => input.id === inputId);
    try {
      const changes = session.setValue(inputId, raw);
      rejectedEdits.delete(inputId);
      for (const change of changes) {
        if (!change.enabled) {
          rejectedEdits.delete(change.inputId);
        }
      }
      return changes;
    } catch (error) {
      if (current !== undefined) {
        const safeError = projectError(error, maskError).displayText;
        if (
          typeof raw === 'string' &&
          (current.spec.type === 'text' ||
            current.spec.type === 'file' ||
            current.spec.type === 'directory')
        ) {
          rejectedEdits.set(inputId, { safeError, rawCandidate: raw });
        } else {
          rejectedEdits.set(inputId, { safeError });
        }
      }
      throw error;
    }
  });
  handle('rune:plan', () => projectPlan(session.plan(), session.getStrings()));
  handle('rune:describe', () => projectResult(session.describe(), session.getStrings()));
  handle('rune:getStrings', () => {
    const strings = session.getStrings();
    const product = session.manifest.product;
    return {
      locale: strings.locale ?? null,
      entries: strings.entries,
      displayProduct: {
        name: formatSessionTerminalLine(strings, product.name),
        version: formatSessionTerminalLine(strings, product.version),
        welcome:
          strings.productDescription() ??
          formatSessionTerminalLine(strings, `${product.name} ${product.version}`),
      },
    };
  });
  handle('rune:getThemeConfig', () => projectTheme(windowTheme(session)));
  handle('rune:warnings', () => projectWarnings(session.warnings(), session.getStrings()));
  handle('rune:cancel', () => {
    session.cancel();
    hooks.onCancelRequested?.();
    return undefined;
  });
  handle('rune:execute', async () => {
    hooks.onExecuteStart?.();
    let plan: ExecutionPlan | undefined;
    let terminalResult: RunResult | undefined;
    let result: RunResult;
    try {
      plan = session.plan();
      const consoleObserver = shellProgressObserver(session, output);
      result = await session.execute(async (event: RunEvent) => {
        if (event.kind === 'runFinished') {
          // Session can publish the engine-owned failed terminal before rejecting when its
          // log sink fails during finalization. Retain that authoritative result for delivery.
          terminalResult = event.result;
        }
        // Keep the terminal sink independent of renderer delivery. The engine owns the
        // observer exception boundary, so neither sink can corrupt the run.
        try {
          await consoleObserver(event);
        } finally {
          await hooks.events.send(EVENT_CHANNEL, projectEvent(event, session.getStrings()));
        }
      });
    } catch (error) {
      await hooks.onExecuteError?.(error, plan, terminalResult);
      throw error;
    }
    // Completion owns result delivery. Its rejection must bypass the engine-failure hook,
    // because §10 permits exactly one attempt to deliver a configured result.
    await hooks.onExecuteEnd?.(result);
    return projectResult(result, session.getStrings());
  });
  handle('rune:done', async () => {
    await hooks.onRendererDone?.();
    return undefined;
  });
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

function windowTheme(session: Session): ThemeConfig {
  const theme = session.getThemeConfig();
  return {
    ...theme,
    windowTitle: theme.windowTitle ?? session.getStrings().chrome('rune.window.title'),
  };
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

async function writeSessionChromeDiagnostic(
  session: Session,
  output: ShellStreams,
  key: ChromeKey,
  values?: Readonly<Record<string, string | number>>,
): Promise<void> {
  const strings = session.getStrings();
  await output.stderr.writeAndWait(
    `${formatSessionTerminalLine(strings, strings.chrome(key, values))}\n`,
  );
}

/** Renders the shell's copy of the shared run-event stream to diagnostic stderr. */
function shellProgressObserver(
  session: Session,
  output: ShellStreams,
): (event: RunEvent) => Promise<void> {
  return async (event) => {
    switch (event.kind) {
      case 'runStarted':
        await writeSessionChromeDiagnostic(session, output, 'rune.progress.runStarted', {
          total: event.plan.steps.length,
          platform: event.plan.platform,
        });
        break;
      case 'stepStarted':
        await writeSessionChromeDiagnostic(session, output, 'rune.progress.step', {
          index: event.index + 1,
          total: event.total,
          title: event.title,
        });
        break;
      case 'stepOutput':
        await writeSessionChromeDiagnostic(session, output, 'rune.progress.output', {
          line: event.line,
        });
        break;
      case 'stepFinished': {
        const values = {
          state: event.state,
          durationMs: event.durationMs,
          ...(event.exitCode === undefined ? {} : { exitCode: event.exitCode }),
        };
        await writeSessionChromeDiagnostic(
          session,
          output,
          event.exitCode === undefined
            ? 'rune.progress.stepFinishedWithoutExitCode'
            : 'rune.progress.stepFinished',
          values,
        );
        break;
      }
      case 'runFinished':
        break;
    }
  };
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

let fallbackProcessOutput: ShellStreams | undefined;

function fallbackOutput(): ShellStreams {
  fallbackProcessOutput ??= guardShellStreams({ stdout: process.stdout, stderr: process.stderr });
  return fallbackProcessOutput;
}

// Under vitest the module is imported for its exports; only Electron runs the app.
if (
  process.versions['electron'] !== undefined &&
  (process as { type?: string }).type === 'browser'
) {
  void main();
}
