/**
 * Electron main process of the RUNE GUI shell (docs/architecture.md §9.4): hosts
 * `@rune/engine` in-process, owns the one Session, registers the IPC handlers, creates
 * the window, and exits with the engine's exit code. The renderer drives the engine
 * exclusively through the bridge (§9.2); nothing engine-side is reachable another way.
 */

import { join } from 'node:path';

import { BrowserWindow, app, ipcMain, type WebContents } from 'electron';

import {
  CancelToken,
  CancelledError,
  createCompletedRunFailureResult,
  createFailureResult,
  InternalError,
  RUNE_VERSION,
  RuneError,
  Session,
  exitCodeFor,
  writeResult,
  type ExecutionPlan,
  type RunEvent,
  type RunResult,
} from '@rune/engine';

import {
  isShellVersionProbe,
  parseShellArgv,
  shellVersionProbeOutput,
  type ShellInvocation,
} from './argv.js';
import { project } from './serialize.js';

/** The §9.2 channel names — one per facade method, pinned by the bridge unit test. */
export const BRIDGE_CHANNELS = [
  'rune:open',
  'rune:pendingInputs',
  'rune:allInputs',
  'rune:setValue',
  'rune:plan',
  'rune:execute',
  'rune:cancel',
  'rune:getStrings',
  'rune:getThemeConfig',
  'rune:warnings',
  'rune:done',
] as const;

export const EVENT_CHANNEL = 'rune:event';

type ResultWriter = (result: RunResult, path: string) => unknown;
type SigtermSubscriber = (listener: () => void) => () => void;

interface WorkflowMainOptions {
  readonly whenReady?: () => Promise<void>;
  readonly open?: (invocation: ShellInvocation) => Promise<Session>;
  readonly writer?: ResultWriter;
  readonly subscribeToSigterm?: SigtermSubscriber;
}

/** Test seam for the Electron startup boundary outside the regular workflow lifecycle. */
export interface ShellMainOptions {
  readonly argv?: readonly string[];
  readonly packaged?: boolean;
  readonly exit?: (code: number) => void;
  readonly runWorkflow?: (invocation: ShellInvocation) => Promise<number>;
  readonly writeStderr?: (message: string) => void;
}

/** Buffers the one §9.4 cancel request until the window/session lifecycle can receive it. */
class SigtermRelay {
  readonly #unsubscribe: () => void;
  #requested = false;
  #delivered = false;
  #target: (() => void) | undefined;

  constructor(subscribe: SigtermSubscriber = subscribeToSigterm) {
    this.#unsubscribe = subscribe(() => this.#request());
  }

  connect(target: () => void): () => void {
    this.#target = target;
    this.#deliver();
    return () => {
      if (this.#target === target) {
        this.#target = undefined;
      }
    };
  }

  dispose(): void {
    this.#target = undefined;
    this.#unsubscribe();
  }

  #request(): void {
    if (this.#requested) {
      return;
    }
    this.#requested = true;
    this.#deliver();
  }

  #deliver(): void {
    if (!this.#requested || this.#delivered || this.#target === undefined) {
      return;
    }
    this.#delivered = true;
    this.#target();
  }
}

function subscribeToSigterm(listener: () => void): () => void {
  process.on('SIGTERM', listener);
  return () => process.removeListener('SIGTERM', listener);
}

/**
 * Owns the shell process boundary. Workflow results already carry their §10 exit code;
 * only failures that escape startup or the Electron lifecycle become internal errors.
 */
export async function runShell(options: ShellMainOptions = {}): Promise<void> {
  const exit = options.exit ?? ((code: number) => app.exit(code));
  const writeStderr = options.writeStderr ?? ((message: string) => process.stderr.write(message));

  try {
    const argv = (options.argv ?? process.argv).slice((options.packaged ?? app.isPackaged) ? 1 : 2);
    if (isShellVersionProbe(argv)) {
      await new Promise<void>((resolve) =>
        process.stdout.write(shellVersionProbeOutput(), () => resolve()),
      );
      exit(0);
      return;
    }
    const invocation = parseShellArgv(argv);

    exit(await (options.runWorkflow ?? runWorkflow)(invocation));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    writeStderr(`internal shell error: ${message}\n`);
    exit(70);
  }
}

/** Runs one ordinary shell invocation; the standalone version probe never enters here. */
export async function runWorkflow(
  invocation: ShellInvocation,
  options: WorkflowMainOptions = {},
): Promise<number> {
  // Start before Electron readiness/session open so either shell mode can buffer the one
  // cooperative cancellation request required by §7/§9.4.
  const relay = new SigtermRelay(options.subscribeToSigterm);
  const writer = options.writer ?? writeResult;

  try {
    try {
      await (options.whenReady ?? (() => app.whenReady()))();
    } catch (error) {
      // Electron failed before a session or window exists. This is still an ordinary
      // internal-error outcome for a configured invocation (§10).
      process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
      await deliverFailure(asRuneError(error), invocation, writer);
      return 70;
    }

    let session: Session;
    try {
      session = await (options.open ?? openSession)(invocation);
    } catch (error) {
      // A manifest or input error before any window exists: named on stderr, exit code from
      // the one table, and the §10 zero-counter result file — both hosts write it.
      process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
      const failure = asRuneError(error);
      const result = failureResultFor(failure, invocation);
      return (await deliverSafely(result, invocation, writer)) ? result.exitCode : 70;
    }

    if (invocation.nonInteractive) {
      // The headless path (§9.4): no window, the same engine walk the CLI does.
      const code = await headlessRun(session, invocation, writer, relay);
      return code;
    }

    const code = await windowedRun(session, invocation, writer, relay);
    return code;
  } finally {
    relay.dispose();
  }
}

export async function openSession(invocation: ShellInvocation): Promise<Session> {
  return Session.open(invocation.manifestPath, {
    values: invocation.values,
    overrides: invocation.overrides,
    locale: invocation.locale,
    logFile: invocation.logFile,
    mode: invocation.nonInteractive ? 'non-interactive' : 'gui',
  });
}

export async function headlessRun(
  session: Session,
  invocation: ShellInvocation,
  writer: ResultWriter = writeResult,
  cancellation?: SigtermRelay,
): Promise<number> {
  const relay = cancellation ?? new SigtermRelay();
  const ownsRelay = cancellation === undefined;
  const cancel = new CancelToken();
  const disconnectCancellation = relay.connect(() => cancel.cancel());
  try {
    const result = await session.execute(undefined, cancel);
    for (const warning of session.warnings()) {
      process.stderr.write(`warning: ${warning}` + String.fromCharCode(10));
    }
    if (result.nothingExecuted) {
      process.stderr.write('warning: nothing was executed' + String.fromCharCode(10));
    }
    return (await deliverSafely(result, invocation, writer, session)) ? result.exitCode : 70;
  } catch (error) {
    return await failWith(error, invocation, session, writer);
  } finally {
    disconnectCancellation();
    if (ownsRelay) {
      relay.dispose();
    }
  }
}

export async function windowedRun(
  session: Session,
  invocation: ShellInvocation,
  writer: ResultWriter = writeResult,
  cancellation?: SigtermRelay,
): Promise<number> {
  const relay = cancellation ?? new SigtermRelay();
  const ownsRelay = cancellation === undefined;
  let window: BrowserWindow;
  try {
    window = new BrowserWindow({
      width: 900,
      height: 640,
      show: false,
      autoHideMenuBar: true,
      webPreferences: {
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        preload: join(app.getAppPath(), 'dist', 'preload', 'index.cjs'),
      },
    });
  } catch (error) {
    if (ownsRelay) {
      relay.dispose();
    }
    return await failWith(error, invocation, session, writer);
  }
  window.once('ready-to-show', () => window.show());

  const closed = new Promise<void>((resolve) => window.on('closed', () => resolve()));

  let running = false;
  let closeRequested = false;
  let outcome: RunResult | undefined;
  let fatalCode: number | undefined;
  let renderedDone = false;
  let windowLoaded = false;
  let rendererLost = false;
  let resolveRendererLost: (() => void) | undefined;
  const rendererLostSignal = new Promise<void>((resolve) => {
    resolveRendererLost = resolve;
  });

  const destroyAfterRendererLoss = (): void => {
    if (!window.isDestroyed()) {
      window.destroy();
    }
  };

  const onRendererLost = (): void => {
    if (rendererLost) {
      return;
    }
    rendererLost = true;
    resolveRendererLost?.();
    // Once the engine outcome is durably delivered it remains authoritative: losing only
    // the Result-page renderer cannot rewrite the workflow behind the caller's back.
    if (outcome !== undefined) {
      destroyAfterRendererLoss();
      return;
    }
    if (running) {
      session.cancel();
    } else {
      // Main, the Session and the writer are still alive, so this is an ordinary owned
      // internal-error outcome rather than the resultless main-process crash of §10.
      fatalCode = 70;
      void deliverFailure(
        new InternalError('the renderer became unavailable'),
        invocation,
        writer,
        session,
      ).then(destroyAfterRendererLoss);
    }
  };
  window.webContents.on('render-process-gone', onRendererLost);

  registerBridge(session, {
    events: window.webContents,
    onExecuteStart: () => {
      running = true;
    },
    onExecuteEnd: async (result) => {
      if (rendererLost) {
        running = false;
        const internalResult = createCompletedRunFailureResult(
          new InternalError('the renderer became unavailable'),
          result,
        );
        if (await deliverSafely(internalResult, invocation, writer, session)) {
          outcome = internalResult;
        } else {
          fatalCode = 70;
        }
        destroyAfterRendererLoss();
        return;
      }
      if (!(await deliverSafely(result, invocation, writer, session))) {
        running = false;
        fatalCode = 70;
        window.close();
        return;
      }
      running = false;
      outcome = result;
      if (rendererLost) {
        destroyAfterRendererLoss();
        return;
      }
      if (closeRequested) {
        // The shell finishes its own cancel (§9.4): the close that started it completes.
        window.close();
      }
    },
    onExecuteError: async (error) => {
      // Errors from execute are FATAL: main, not the renderer, maps them (§9.2).
      running = false;
      if (rendererLost) {
        fatalCode = 70;
        await deliverFailure(
          new InternalError('the renderer became unavailable'),
          invocation,
          writer,
          session,
        );
        destroyAfterRendererLoss();
        return;
      }
      const message = error instanceof Error ? error.message : String(error);
      process.stderr.write(session.mask(message) + String.fromCharCode(10));
      const failure = asRuneError(error);
      const result = failureResultFor(failure, invocation, session);
      fatalCode = (await deliverSafely(result, invocation, writer, session)) ? result.exitCode : 70;
      window.close();
    },
    onRendererDone: () => {
      renderedDone = true;
      window.close();
    },
  });

  // A relayed SIGTERM keeps the existing §9.4 behavior: running means CancelToken;
  // otherwise it is the close-window path. Before load completes, defer only the close.
  const disconnectCancellation = relay.connect(() => {
    if (running) {
      closeRequested = true;
      session.cancel();
    } else if (windowLoaded) {
      window.close();
    } else {
      closeRequested = true;
    }
  });
  let cancellationDeliveryStarted = false;
  window.on('close', (event) => {
    if (running) {
      event.preventDefault();
      closeRequested = true;
      session.cancel();
      return;
    }
    if (outcome === undefined && fatalCode === undefined && !renderedDone) {
      event.preventDefault();
      if (cancellationDeliveryStarted) {
        return;
      }
      cancellationDeliveryStarted = true;
      // Closed before Proceed: use the plan when one exists, otherwise the honest
      // zero-counter cancellation shell (§10).
      const cancelled = cancellationResultFor(invocation, session);
      void deliverSafely(cancelled, invocation, writer, session).then((delivered) => {
        if (delivered) {
          outcome = cancelled;
        } else {
          fatalCode = 70;
        }
        if (!window.isDestroyed()) {
          window.destroy();
        }
      });
    }
  });

  try {
    const loaded = window.loadFile(join(app.getAppPath(), 'src', 'renderer', 'index.html'));
    await Promise.race([loaded, rendererLostSignal]);
    if (!rendererLost) {
      windowLoaded = true;
      if (closeRequested) {
        window.close();
      }
    }
    await closed;
  } catch (error) {
    if (rendererLost) {
      await closed;
      return outcome?.exitCode ?? 70;
    }
    const code = await failWith(error, invocation, session, writer);
    if (!window.isDestroyed()) {
      window.destroy();
    }
    return code;
  } finally {
    window.webContents.removeListener('render-process-gone', onRendererLost);
    disconnectCancellation();
    if (ownsRelay) {
      relay.dispose();
    }
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
    events: Pick<WebContents, 'send'>;
    onExecuteStart?: () => void;
    onExecuteEnd?: (result: RunResult) => unknown;
    onExecuteError?: (error: unknown) => unknown;
    onRendererDone?: () => void;
  },
  register: (channel: string, handler: (...args: unknown[]) => unknown) => void = (c, h) =>
    ipcMain.handle(c, async (_event, ...args: unknown[]) => {
      try {
        return await h(...args);
      } catch (error) {
        // Electron serializes only the message across invoke; carry the RUNE code and the
        // exit code the CLI would have used inside it (§9.2).
        if (error instanceof RuneError) {
          throw new Error(
            session.mask(`${error.code} (exit ${exitCodeFor(error)}): ${error.message}`),
          );
        }
        throw error;
      }
    }),
): void {
  const mask = (text: string): string => session.mask(text);
  register('rune:open', () =>
    project({
      runeVersion: RUNE_VERSION,
      inputTypes: [...new Set(Object.values(session.manifest.inputs).map((spec) => spec.type))],
      product: {
        name: session.manifest.product.name,
        version: session.manifest.product.version,
      },
    }),
  );
  register('rune:pendingInputs', () => project(session.pendingInputs(), mask));
  register('rune:allInputs', () => project(session.allInputs(), mask));
  register('rune:setValue', (id, raw) => project(session.setValue(String(id), raw), mask));
  register('rune:plan', () => project(session.describe(), mask));
  register('rune:getStrings', () => project(session.getStrings().entries));
  register('rune:getThemeConfig', () => project(session.getThemeConfig()));
  register('rune:warnings', () => project(session.warnings(), mask));
  register('rune:cancel', () => {
    session.cancel();
    return undefined;
  });
  register('rune:execute', async () => {
    hooks.onExecuteStart?.();
    let result: RunResult;
    try {
      result = await session.execute((event: RunEvent) => {
        hooks.events.send(EVENT_CHANNEL, project(event, mask));
      });
    } catch (error) {
      await hooks.onExecuteError?.(error);
      throw error;
    }
    await hooks.onExecuteEnd?.(result);
    return project(result, mask);
  });
  register('rune:done', () => {
    hooks.onRendererDone?.();
    return undefined;
  });
}

async function deliver(
  result: RunResult,
  invocation: ShellInvocation,
  writer: ResultWriter = writeResult,
): Promise<void> {
  if (invocation.result !== undefined) {
    await writer(result, invocation.result);
  }
}

async function deliverSafely(
  result: RunResult,
  invocation: ShellInvocation,
  writer: ResultWriter,
  session?: Session,
): Promise<boolean> {
  try {
    await deliver(result, invocation, writer);
    return true;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(
      `failed to write result: ${session?.mask(message) ?? message}` + String.fromCharCode(10),
    );
    return false;
  }
}

async function deliverFailure(
  error: RuneError,
  invocation: ShellInvocation,
  writer: ResultWriter,
  session?: Session,
): Promise<boolean> {
  return await deliverSafely(
    failureResultFor(error, invocation, session),
    invocation,
    writer,
    session,
  );
}

/** Builds the §10 zero-counter result, retaining metadata available from an opened session. */
export function failureResultFor(
  error: RuneError,
  invocation: ShellInvocation,
  session?: Session,
  plan?: ExecutionPlan,
): RunResult {
  return createFailureResult({
    error,
    mode: invocation.nonInteractive ? 'non-interactive' : 'gui',
    manifestPath: invocation.manifestPath,
    dryRun: false,
    ...(session === undefined ? {} : { session }),
    ...(plan === undefined ? {} : { plan }),
  });
}

async function failWith(
  error: unknown,
  invocation: ShellInvocation,
  session: Session,
  writer: ResultWriter,
): Promise<number> {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`${session.mask(message)}\n`);
  const failure = asRuneError(error);
  if (error instanceof CancelledError) {
    const result = cancellationResultFor(invocation, session);
    return (await deliverSafely(result, invocation, writer, session)) ? result.exitCode : 70;
  }
  const result = failureResultFor(failure, invocation, session);
  return (await deliverSafely(result, invocation, writer, session)) ? result.exitCode : 70;
}

function cancellationResultFor(invocation: ShellInvocation, session: Session): RunResult {
  let plan: ExecutionPlan | undefined;
  try {
    plan = session.plan();
  } catch {
    // Closing before all required inputs exist has no plan to preserve.
  }
  return failureResultFor(new CancelledError(), invocation, session, plan);
}

function asRuneError(error: unknown): RuneError {
  return error instanceof RuneError
    ? error
    : new InternalError('an unexpected error escaped the GUI shell', { cause: error });
}

// Under vitest the module is imported for its exports; only Electron runs the app.
if (
  process.versions['electron'] !== undefined &&
  (process as { type?: string }).type === 'browser'
) {
  void runShell();
}
