import { describe, expect, it, vi } from 'vitest';

import type { BridgeEvent } from '../src/preload/types.js';

const { electron, restoreElectronRequire } = vi.hoisted(() => {
  const electron = {
    contextBridge: { exposeInMainWorld: vi.fn() },
    ipcRenderer: { invoke: vi.fn(), on: vi.fn() },
  };
  const moduleApi = process.getBuiltinModule('node:module') as unknown as {
    _load: (request: string, parent: unknown, isMain: boolean) => unknown;
  };
  const originalLoad = moduleApi._load;
  moduleApi._load = (request, parent, isMain) =>
    request === 'electron' ? electron : originalLoad(request, parent, isMain);

  return {
    electron,
    restoreElectronRequire: () => {
      moduleApi._load = originalLoad;
    },
  };
});

vi.mock('electron', () => electron);

// @ts-expect-error tsc addresses the compiled file as .cjs; vitest resolves the source
import { buildBridge } from '../src/preload/index.cts';

restoreElectronRequire();

function fakeIpc(): {
  invoke: ReturnType<typeof vi.fn>;
  on: ReturnType<typeof vi.fn>;
} {
  return { invoke: vi.fn().mockResolvedValue(undefined), on: vi.fn() };
}

describe('the preload bridge', () => {
  it('exposes exactly the facade projection - no method more, none less', () => {
    const api = buildBridge(fakeIpc());
    expect(Object.keys(api).sort()).toEqual(
      [
        'open',
        'pendingInputs',
        'allInputs',
        'setValue',
        'plan',
        'execute',
        'cancel',
        'getStrings',
        'getThemeConfig',
        'warnings',
        'done',
        'onEvent',
      ].sort(),
    );
  });

  it('maps each method to its one channel and subscribes events once', async () => {
    const ipc = fakeIpc();
    const api = buildBridge(ipc);

    await api.setValue('id', 'raw');
    expect(ipc.invoke).toHaveBeenCalledWith('rune:setValue', 'id', 'raw');
    await api.execute();
    expect(ipc.invoke).toHaveBeenCalledWith('rune:execute');
    await api.plan();
    expect(ipc.invoke).toHaveBeenCalledWith('rune:plan');

    const seen: unknown[] = [];
    api.onEvent((event) => seen.push(event));
    expect(ipc.on).toHaveBeenCalledWith('rune:event', expect.any(Function));
    const listener = ipc.on.mock.calls[0]?.[1] as (event: unknown, payload: unknown) => void;
    const runStarted = {
      kind: 'runStarted',
      plan: {
        manifestPath: 'installer.yaml',
        platform: 'linux',
        preview: false,
        failFast: true,
        steps: [],
      },
    } satisfies BridgeEvent;
    listener(undefined, runStarted);
    expect(seen).toEqual([runStarted]);
  });
});
