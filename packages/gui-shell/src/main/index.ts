/**
 * Electron main process of the RUNE GUI shell (docs/architecture.md §9.4): hosts
 * `@rune/engine` in-process, owns the one Session, registers the IPC handlers, creates
 * the window, and exits with the engine's exit code. The renderer drives the engine
 * exclusively through the bridge (§9.2); nothing engine-side is reachable another way.
 */

import { join } from 'node:path';

import { BrowserWindow, app, ipcMain, type WebContents } from 'electron';

import {
  CancelledError,
  RUNE_VERSION,
  RuneError,
  Session,
  exitCodeFor,
  writeResult,
  type RunEvent,
  type RunResult,
} from '@rune/engine';

import { parseShellArgv, type ShellInvocation } from './argv.js';
import { project, projectPlan, projectTheme } from './serialize.js';

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

export interface SigtermSource {
  on(signal: 'SIGTERM', listener: () => void): void;
  off(signal: 'SIGTERM', listener: () => void): void;
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

export async function main(
  argv: readonly string[] = process.argv.slice(app.isPackaged ? 1 : 2),
): Promise<void> {
  let exitCode: number;
  try {
    const invocation = parseShellArgv(argv);
    await app.whenReady();
    const session = await openSession(invocation);

    exitCode = invocation.nonInteractive
      ? await headlessRun(session, invocation)
      : await windowedRun(session, invocation);
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    exitCode = exitCodeFor(error);
  }
  app.exit(exitCode);
}

async function openSession(invocation: ShellInvocation): Promise<Session> {
  return Session.open(invocation.manifestPath, {
    values: invocation.values,
    overrides: invocation.overrides,
    locale: invocation.locale,
    logFile: invocation.logFile,
    mode: invocation.nonInteractive ? 'non-interactive' : 'gui',
  });
}

export function headlessRun(
  session: Session,
  invocation: ShellInvocation,
  signals: SigtermSource = process,
): Promise<number> {
  return withSigtermHandler(
    () => session.cancel(),
    () => executeHeadless(session, invocation),
    signals,
  );
}

async function executeHeadless(session: Session, invocation: ShellInvocation): Promise<number> {
  try {
    const result = await session.execute();
    for (const warning of session.warnings()) {
      process.stderr.write(`warning: ${warning}` + String.fromCharCode(10));
    }
    if (result.nothingExecuted) {
      process.stderr.write('warning: nothing was executed' + String.fromCharCode(10));
    }
    deliver(result, invocation);
    return result.exitCode;
  } catch (error) {
    return failWith(error, invocation, session);
  }
}

async function windowedRun(session: Session, invocation: ShellInvocation): Promise<number> {
  const window = new BrowserWindow({
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
  window.once('ready-to-show', () => window.show());

  let running = false;
  let closeRequested = false;
  let outcome: RunResult | undefined;
  let fatalCode: number | undefined;
  let renderedDone = false;

  registerBridge(session, {
    events: window.webContents,
    onExecuteStart: () => {
      running = true;
    },
    onExecuteEnd: (result) => {
      running = false;
      outcome = result;
      deliver(result, invocation);
      if (closeRequested) {
        // The shell finishes its own cancel (§9.4): the close that started it completes.
        window.close();
      }
    },
    onExecuteError: (error) => {
      // Errors from execute are FATAL: main, not the renderer, maps them (§9.2).
      running = false;
      process.stderr.write(
        `${error instanceof Error ? error.message : String(error)}` + String.fromCharCode(10),
      );
      fatalCode = error instanceof RuneError ? exitCodeFor(error) : 70;
      window.close();
    },
    onRendererDone: () => {
      renderedDone = true;
      window.close();
    },
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
      outcome = tryDescribeCancelled(session);
      if (outcome !== undefined) {
        deliver(outcome, invocation);
      }
    }
  });
  const closed = new Promise<void>((resolve) => window.on('closed', () => resolve()));

  await withSigtermHandler(closeWindowOnSigterm(window), async () => {
    await window.loadFile(join(app.getAppPath(), 'src', 'renderer', 'index.html'));
    await closed;
  });

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
    onExecuteEnd?: (result: RunResult) => void;
    onExecuteError?: (error: unknown) => void;
    onRendererDone?: () => void;
  },
  register: (channel: string, handler: (...args: unknown[]) => unknown) => void = (c, h) =>
    ipcMain.handle(c, (_event, ...args: unknown[]) => h(...args)),
): void {
  const mask = (text: string): string => session.mask(text);
  const handle = (channel: string, handler: (...args: unknown[]) => unknown): void => {
    register(channel, async (...args: unknown[]) => {
      try {
        return project(await handler(...args), mask);
      } catch (error) {
        throw bridgeError(error, mask);
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
  handle('rune:allInputs', () => session.allInputs());
  handle('rune:setValue', (id, raw) => session.setValue(String(id), raw));
  handle('rune:plan', () => projectPlan(session.plan(), mask));
  handle('rune:getStrings', () => Object.fromEntries(session.getStrings().entries));
  handle('rune:getThemeConfig', () => projectTheme(session.getThemeConfig()));
  handle('rune:warnings', () => session.warnings());
  handle('rune:cancel', () => {
    session.cancel();
    return undefined;
  });
  handle('rune:execute', async () => {
    hooks.onExecuteStart?.();
    try {
      const result = await session.execute((event: RunEvent) => {
        hooks.events.send(EVENT_CHANNEL, project(event, mask));
      });
      hooks.onExecuteEnd?.(result);
      return result;
    } catch (error) {
      hooks.onExecuteError?.(error);
      throw error;
    }
  });
  handle('rune:done', () => {
    hooks.onRendererDone?.();
    return undefined;
  });
}

function bridgeError(error: unknown, mask: (text: string) => string): Error {
  if (error instanceof RuneError) {
    return new Error(mask(`${error.code} (exit ${exitCodeFor(error)}): ${error.message}`));
  }
  if (error instanceof Error) {
    return new Error(mask(error.message));
  }
  try {
    return new Error(mask(String(error)));
  } catch {
    return new Error('Unknown error');
  }
}

function deliver(result: RunResult, invocation: ShellInvocation): void {
  if (invocation.result !== undefined) {
    writeResult(result, invocation.result);
  }
}

function failWith(error: unknown, invocation: ShellInvocation, session: Session): number {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  // Only a cancellation has a truthful result to leave behind here; the failure shells
  // for other owned outcomes arrive with the rune run --gui wiring.
  if (error instanceof CancelledError) {
    const cancelled = tryDescribeCancelled(session);
    if (cancelled !== undefined) {
      deliver(cancelled, invocation);
    }
  }
  return error instanceof RuneError ? exitCodeFor(error) : 70;
}

function tryDescribeCancelled(session: Session | undefined): RunResult | undefined {
  try {
    return session?.describeCancelled();
  } catch {
    return undefined;
  }
}

// Under vitest the module is imported for its exports; only Electron runs the app.
if (
  process.versions['electron'] !== undefined &&
  (process as { type?: string }).type === 'browser'
) {
  void main();
}
