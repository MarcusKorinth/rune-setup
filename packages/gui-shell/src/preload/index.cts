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
  BridgePlan,
  BridgeResult,
  BridgeTheme,
  RuneBridge,
} from './types.js';

export type { RuneBridge } from './types.js';

// A sandboxed preload is CommonJS by necessity, and the import-equals form does not
// survive every TypeScript transformer — the plain require does. Outside Electron the
// electron package resolves to a path string, so everything below stays inert under test.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const electron = require('electron') as Partial<typeof ElectronModule>;

/** The one ipcRenderer surface the bridge touches — the seam the unit test drives. */
export interface BridgeIpc {
  invoke(channel: string, ...args: unknown[]): Promise<unknown>;
  on(channel: string, listener: (event: unknown, payload: unknown) => void): unknown;
}

/** Builds `window.rune` over one ipcRenderer — exactly one channel per facade method. */
export function buildBridge(ipc: BridgeIpc): RuneBridge {
  return {
    open: () =>
      ipc.invoke('rune:open') as Promise<{
        runeVersion: string;
        inputTypes: readonly string[];
        product: { readonly name: string; readonly version: string };
      }>,
    pendingInputs: () => ipc.invoke('rune:pendingInputs') as Promise<readonly BridgeInput[]>,
    allInputs: () => ipc.invoke('rune:allInputs') as Promise<readonly BridgeInput[]>,
    setValue: (id, raw) =>
      ipc.invoke('rune:setValue', id, raw) as Promise<
        readonly { inputId: string; enabled: boolean }[]
      >,
    plan: () => ipc.invoke('rune:plan') as Promise<BridgePlan>,
    execute: () => ipc.invoke('rune:execute') as Promise<BridgeResult>,
    cancel: () => ipc.invoke('rune:cancel') as Promise<void>,
    getStrings: () => ipc.invoke('rune:getStrings') as Promise<Readonly<Record<string, string>>>,
    getThemeConfig: () => ipc.invoke('rune:getThemeConfig') as Promise<BridgeTheme>,
    warnings: () => ipc.invoke('rune:warnings') as Promise<readonly string[]>,
    done: () => ipc.invoke('rune:done') as Promise<void>,
    onEvent: (listener) => {
      ipc.on('rune:event', (_event, payload) => listener(payload as BridgeEvent));
    },
  };
}

if (electron.contextBridge !== undefined && electron.ipcRenderer !== undefined) {
  electron.contextBridge.exposeInMainWorld('rune', buildBridge(electron.ipcRenderer));
}
