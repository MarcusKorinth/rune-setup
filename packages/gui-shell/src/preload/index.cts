/**
 * Preload script of the RUNE GUI shell (docs/architecture.md §9.2): exposes the IPC
 * bridge `window.rune` through `contextBridge` — a 1:1 projection of the Session facade
 * plus `onEvent` for the pushed run events. CommonJS on purpose: a sandboxed preload
 * cannot load ES modules.
 *
 * Every method maps to exactly one channel; nothing exists on the bridge that the
 * in-process facade lacks (invariant 11). Payloads arrive already projected and masked by
 * main's serializer — this file adds no logic, only the exposure.
 */

import type * as ElectronModule from 'electron';

import type {
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Builds `window.rune` over one ipcRenderer — exactly one channel per facade method. */
export function buildBridge(ipc: BridgeIpc): RuneBridge {
  const listeners: Array<(event: BridgeEvent) => void> = [];
  return {
    open: () =>
      ipc.invoke('rune:open') as Promise<{
        runeVersion: string;
        inputTypes: readonly BridgeInputType[];
        product: { readonly name: string; readonly version: string };
      }>,
    pendingInputs: () => ipc.invoke('rune:pendingInputs') as Promise<readonly BridgeInput[]>,
    allInputs: () => ipc.invoke('rune:allInputs') as Promise<readonly BridgeInput[]>,
    setValue: (id, raw) =>
      ipc.invoke('rune:setValue', id, raw) as Promise<
        readonly { inputId: string; enabled: boolean }[]
      >,
    plan: () => ipc.invoke('rune:plan') as Promise<BridgePlan>,
    describe: () => ipc.invoke('rune:describe') as Promise<BridgeResult>,
    execute: () => ipc.invoke('rune:execute') as Promise<BridgeResult>,
    cancel: () => ipc.invoke('rune:cancel') as Promise<void>,
    getStrings: () => ipc.invoke('rune:getStrings') as Promise<BridgeStrings>,
    getThemeConfig: () => ipc.invoke('rune:getThemeConfig') as Promise<BridgeTheme>,
    warnings: () => ipc.invoke('rune:warnings') as Promise<readonly BridgeWarning[]>,
    done: () => ipc.invoke('rune:done') as Promise<void>,
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
