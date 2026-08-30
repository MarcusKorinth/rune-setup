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
  failureResult,
  writeResult,
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

async function main(): Promise<void> {
  const argv = process.argv.slice(app.isPackaged ? 1 : 2);
  if (isShellVersionProbe(argv)) {
    await new Promise<void>((resolve) =>
      process.stdout.write(shellVersionProbeOutput(), () => resolve()),
    );
    app.exit(0);
    return;
  }
  const invocation = parseShellArgv(argv);

  await app.whenReady();

  let session: Session;
  try {
    session = await openSession(invocation);
  } catch (error) {
    // A manifest or input error before any window exists: named on stderr, exit code from
    // the one table, and the §10 zero-counter result file — both hosts write it.
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    const code = error instanceof RuneError ? exitCodeFor(error) : 70;
    deliverFailure(code, invocation);
    app.exit(code);
    return;
  }

  if (invocation.nonInteractive) {
    // The headless path (§9.4): no window, the same engine walk the CLI does.
    app.exit(await headlessRun(session, invocation));
    return;
  }

  app.exit(await windowedRun(session, invocation));
}

export async function openSession(invocation: ShellInvocation): Promise<Session> {
  return Session.open(invocation.manifestPath, {
    values: invocation.values,
    overrides: invocation.overrides,
    locale: invocation.locale,
    logFile: invocation.logFile,
    mode: invocation.nonInteractive ? 'non-interactive' : 'gui',
    checkAssetFiles: !invocation.nonInteractive,
  });
}

export async function headlessRun(
  session: Session,
  invocation: ShellInvocation,
  writer: typeof writeResult = writeResult,
): Promise<number> {
  try {
    const result = await session.execute();
    for (const warning of session.warnings()) {
      process.stderr.write(`warning: ${warning}` + String.fromCharCode(10));
    }
    if (result.nothingExecuted) {
      process.stderr.write('warning: nothing was executed' + String.fromCharCode(10));
    }
    return deliverCompletedRun(result, invocation, session, writer) ? result.exitCode : 70;
  } catch (error) {
    return failWith(error, invocation, session);
  }
}

export async function windowedRun(
  session: Session,
  invocation: ShellInvocation,
  writer: typeof writeResult = writeResult,
): Promise<number> {
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
      if (!deliverCompletedRun(result, invocation, session, writer)) {
        running = false;
        fatalCode = 70;
        window.close();
        return;
      }
      running = false;
      outcome = result;
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
      deliverFailure(fatalCode, invocation, session);
      window.close();
    },
    onRendererDone: () => {
      renderedDone = true;
      window.close();
    },
  });

  // SIGTERM is the §9.4 cancel request from `rune run --gui`: during a run it fires the
  // CancelToken; before one it is the close-window path.
  process.on('SIGTERM', () => {
    if (running) {
      session.cancel();
    } else {
      window.close();
    }
  });
  window.on('close', (event) => {
    if (running) {
      event.preventDefault();
      closeRequested = true;
      session.cancel();
      return;
    }
    if (outcome === undefined && fatalCode === undefined && !renderedDone) {
      // Closed before Proceed: use the plan when one exists, otherwise the honest
      // zero-counter cancellation shell (§10).
      const cancelled = tryDescribeCancelled(session) ?? failureResultFor(6, invocation, session);
      if (deliverCompletedRun(cancelled, invocation, session, writer)) {
        outcome = cancelled;
      } else {
        fatalCode = 70;
      }
    }
  });

  await window.loadFile(join(app.getAppPath(), 'src', 'renderer', 'index.html'));
  await new Promise<void>((resolve) => window.on('closed', () => resolve()));

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
    ipcMain.handle(c, async (_event, ...args: unknown[]) => {
      try {
        return await h(...args);
      } catch (error) {
        // Electron serializes only the message across invoke; carry the RUNE code and the
        // exit code the CLI would have used inside it (§9.2).
        if (error instanceof RuneError) {
          throw new Error(`${error.code} (exit ${exitCodeFor(error)}): ${error.message}`);
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
  register('rune:getStrings', () => project(Object.fromEntries(session.getStrings().entries)));
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
      hooks.onExecuteError?.(error);
      throw error;
    }
    hooks.onExecuteEnd?.(result);
    return project(result, mask);
  });
  register('rune:done', () => {
    hooks.onRendererDone?.();
    return undefined;
  });
}

function deliver(
  result: RunResult,
  invocation: ShellInvocation,
  writer: typeof writeResult = writeResult,
): void {
  if (invocation.result !== undefined) {
    writer(result, invocation.result);
  }
}

function deliverCompletedRun(
  result: RunResult,
  invocation: ShellInvocation,
  session: Session,
  writer: typeof writeResult,
): boolean {
  try {
    deliver(result, invocation, writer);
    return true;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(
      `failed to write result: ${session.mask(message)}` + String.fromCharCode(10),
    );
    return false;
  }
}

function deliverFailure(exitCode: number, invocation: ShellInvocation, session?: Session): void {
  if (invocation.result === undefined) {
    return;
  }
  writeResult(failureResultFor(exitCode, invocation, session), invocation.result);
}

/** Builds the §10 zero-counter result, retaining metadata available from an opened session. */
export function failureResultFor(
  exitCode: number,
  invocation: ShellInvocation,
  session?: Session,
): RunResult {
  return failureResult({
    exitCode,
    mode: invocation.nonInteractive ? 'non-interactive' : 'gui',
    manifestPath: invocation.manifestPath,
    locale: session?.getStrings().locale ?? null,
    product:
      session === undefined
        ? undefined
        : { name: session.manifest.product.name, version: session.manifest.product.version },
  });
}

function failWith(error: unknown, invocation: ShellInvocation, session: Session): number {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  const code = error instanceof RuneError ? exitCodeFor(error) : 70;
  if (error instanceof CancelledError) {
    const cancelled = tryDescribeCancelled(session);
    if (cancelled !== undefined) {
      deliver(cancelled, invocation);
      return code;
    }
  }
  deliverFailure(code, invocation, session);
  return code;
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
