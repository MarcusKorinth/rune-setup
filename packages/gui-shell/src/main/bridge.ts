/** Session IPC dispatch and renderer-safe replies (docs/architecture.md §9.2). */

import { ipcMain } from 'electron';

import {
  RUNE_VERSION,
  formatSessionTerminalLine,
  type ExecutionPlan,
  type RunEvent,
  type RunResult,
  type Session,
} from '@rune/engine';

import type { BridgeReply } from '../preload/types.js';
import {
  project,
  projectEvent,
  projectError,
  projectPlan,
  projectResult,
  projectTheme,
  projectWarnings,
  windowTheme,
} from './serialize.js';
import { shellProgressObserver } from './progress.js';
import { fallbackOutput, type ShellStreams } from './streams.js';

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
