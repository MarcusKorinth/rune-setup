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
  'rune:done',
] as const;

export const EVENT_CHANNEL = 'rune:event';

async function main(): Promise<void> {
  const invocation = parseShellArgv(process.argv.slice(app.isPackaged ? 1 : 2));

  await app.whenReady();

  let session: Session;
  try {
    session = await openSession(invocation);
  } catch (error) {
    // A manifest or input error before any window exists: named on stderr, exit code
    // from the one table, result file written by the host as §10 demands.
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    app.exit(error instanceof RuneError ? exitCodeFor(error) : 70);
    return;
  }

  if (invocation.nonInteractive) {
    // The headless path (§9.4): no window, the same engine walk the CLI does.
    app.exit(await headlessRun(session, invocation));
    return;
  }

  app.exit(await windowedRun(session, invocation));
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

async function headlessRun(session: Session, invocation: ShellInvocation): Promise<number> {
  try {
    const result = await session.execute();
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
  let outcome: RunResult | undefined;
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
    },
    onRendererDone: () => {
      renderedDone = true;
      window.close();
    },
  });

  // SIGTERM is the §9.4 cancel request from `rune run --gui`; the window close during a
  // run is the same path — Session.cancel(), then the ordinary RunFinished.
  process.on('SIGTERM', () => session.cancel());
  window.on('close', (event) => {
    if (running) {
      event.preventDefault();
      session.cancel();
      return;
    }
    if (outcome === undefined && !renderedDone) {
      // Closed before Proceed: a cancelled result over the plan when one exists (§10).
      outcome = tryDescribeCancelled(session);
      if (outcome !== undefined) {
        deliver(outcome, invocation);
      }
    }
  });

  await window.loadFile(join(app.getAppPath(), 'src', 'renderer', 'index.html'));
  await new Promise<void>((resolve) => window.on('closed', () => resolve()));

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
    onRendererDone?: () => void;
  },
  register: (channel: string, handler: (...args: unknown[]) => unknown) => void = (c, h) =>
    ipcMain.handle(c, (_event, ...args: unknown[]) => h(...args)),
): void {
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
  register('rune:pendingInputs', () => project(session.pendingInputs()));
  register('rune:allInputs', () => project(session.allInputs()));
  register('rune:setValue', (id, raw) => project(session.setValue(String(id), raw)));
  register('rune:plan', () => project(session.describe()));
  register('rune:getStrings', () => project(Object.fromEntries(session.getStrings().entries)));
  register('rune:getThemeConfig', () => project(session.getThemeConfig()));
  register('rune:cancel', () => {
    session.cancel();
    return undefined;
  });
  register('rune:execute', async () => {
    hooks.onExecuteStart?.();
    const result = await session.execute((event: RunEvent) => {
      hooks.events.send(EVENT_CHANNEL, project(event));
    });
    hooks.onExecuteEnd?.(result);
    return project(result);
  });
  register('rune:done', () => {
    hooks.onRendererDone?.();
    return undefined;
  });
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
