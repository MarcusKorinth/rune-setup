/**
 * Preload script of the RUNE GUI shell (docs/architecture.md §9.2): exposes the IPC
 * bridge `window.rune` through `contextBridge` — a 1:1 projection of the Session facade
 * plus `onEvent` for the pushed run events. CommonJS on purpose: a sandboxed preload
 * cannot load ES modules.
 *
 * Every method maps to exactly one channel; nothing exists on the bridge that the
 * in-process facade lacks (invariant 11). Payloads arrive already projected and masked by
 * main's serializer — this file unwraps the transport without adding engine behavior.
 */

import type * as ElectronModule from 'electron';

import type {
  BridgeError,
  BridgeEvent,
  BridgeInput,
  BridgeInputType,
  BridgePlan,
  BridgeResult,
  BridgeStrings,
  BridgeTheme,
  BridgeWarning,
  RuneBridge,
} from './types.js';

export type { RuneBridge } from './types.js';

/** The one ipcRenderer surface the bridge touches — the seam the unit test drives. */
export interface BridgeIpc {
  invoke(channel: string, ...args: unknown[]): Promise<unknown>;
  on(channel: string, listener: (event: unknown, payload: unknown) => void): unknown;
  send(channel: string, ...args: unknown[]): void;
}

function unexpectedError(): BridgeError {
  return {
    kind: 'rune-error',
    code: 'RUNE-500',
    message: 'An unexpected shell error occurred.',
    location: null,
    exitCode: 70,
    displayText: 'RUNE-500 (exit 70): An unexpected shell error occurred.',
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isLocation(value: unknown): value is BridgeError['location'] {
  return (
    value === null ||
    (isRecord(value) &&
      typeof value.file === 'string' &&
      Number.isSafeInteger(value.line) &&
      (value.line as number) > 0 &&
      Number.isSafeInteger(value.column) &&
      (value.column as number) > 0)
  );
}

/** Plain rejection data survives contextBridge; native Error custom fields do not. */
export async function invokeBridge<T>(
  ipc: Pick<BridgeIpc, 'invoke'>,
  channel: string,
  ...args: unknown[]
): Promise<T> {
  let reply: unknown;
  try {
    reply = await ipc.invoke(channel, ...args);
  } catch {
    throw unexpectedError();
  }
  if (isRecord(reply)) {
    if (reply.ok === true) {
      return reply.value as T;
    }
    const error = reply.error;
    if (
      reply.ok === false &&
      isRecord(error) &&
      error.kind === 'rune-error' &&
      typeof error.code === 'string' &&
      /^RUNE-\d{3}$/u.test(error.code) &&
      typeof error.message === 'string' &&
      typeof error.displayText === 'string' &&
      Number.isSafeInteger(error.exitCode) &&
      isLocation(error.location)
    ) {
      // Copy the allowlist so even accidental extra fields cannot reach the renderer.
      throw {
        kind: 'rune-error',
        code: error.code,
        message: error.message,
        location:
          error.location === null
            ? null
            : {
                file: error.location.file,
                line: error.location.line,
                column: error.location.column,
              },
        exitCode: error.exitCode,
        displayText: error.displayText,
      };
    }
  }
  throw unexpectedError();
}

/** Builds `window.rune` over one ipcRenderer — exactly one channel per facade method. */
export function buildBridge(ipc: BridgeIpc): RuneBridge {
  const invoke = <T,>(channel: string, ...args: unknown[]): Promise<T> =>
    invokeBridge<T>(ipc, channel, ...args);
  const listeners: Array<(event: BridgeEvent) => void> = [];
  return {
    open: () =>
      invoke('rune:open') as Promise<{
        runeVersion: string;
        inputTypes: readonly BridgeInputType[];
        product: { readonly name: string; readonly version: string };
      }>,
    pendingInputs: () => invoke('rune:pendingInputs') as Promise<readonly BridgeInput[]>,
    allInputs: () => invoke('rune:allInputs') as Promise<readonly BridgeInput[]>,
    setValue: (id, raw) =>
      invoke('rune:setValue', id, raw) as Promise<readonly { inputId: string; enabled: boolean }[]>,
    plan: () => invoke('rune:plan') as Promise<BridgePlan>,
    describe: () => invoke('rune:describe') as Promise<BridgeResult>,
    execute: () => invoke('rune:execute') as Promise<BridgeResult>,
    cancel: () => invoke('rune:cancel') as Promise<void>,
    getStrings: () => invoke('rune:getStrings') as Promise<BridgeStrings>,
    getThemeConfig: () => invoke('rune:getThemeConfig') as Promise<BridgeTheme>,
    warnings: () => invoke('rune:warnings') as Promise<readonly BridgeWarning[]>,
    done: () => invoke('rune:done') as Promise<void>,
    onEvent: (listener) => {
      listeners.push(listener);
      if (listeners.length !== 1) return;
      ipc.on('rune:event', (_event, payload) => {
        if (!isRecord(payload) || !Number.isSafeInteger(payload.sequence)) return;
        try {
          for (const receive of [...listeners]) {
            receive(payload.event as BridgeEvent);
          }
        } finally {
          // Receipt follows synchronous renderer processing, not an animation frame. This
          // private transport acknowledgement exposes no additional facade operation.
          ipc.send('rune:eventAck', payload.sequence);
        }
      });
    },
  };
}

// Loading Electron from plain Node may download its binary. Only the sandboxed
// renderer preload needs the runtime module; bridge consumers can use the helpers alone.
if (process.type === 'renderer') {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const electron = require('electron') as typeof ElectronModule;
  electron.contextBridge.exposeInMainWorld('rune', buildBridge(electron.ipcRenderer));
}
