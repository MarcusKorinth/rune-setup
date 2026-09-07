import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import type { BridgeIpc } from '../src/preload/index.cts';
import type { BridgeEvent } from '../src/preload/types.js';

// @ts-expect-error tsc addresses the compiled file as .cjs; vitest resolves the source
import { buildBridge } from '../src/preload/index.cts';

function fakeIpc() {
  return {
    invoke: vi.fn<BridgeIpc['invoke']>().mockResolvedValue(undefined),
    on: vi.fn<BridgeIpc['on']>(),
    send: vi.fn<BridgeIpc['send']>(),
  };
}

describe('the preload bridge', () => {
  it('loads in plain Node without an installed Electron package', () => {
    const directory = mkdtempSync(join(tmpdir(), 'rune-preload-'));
    try {
      const entry = join(directory, 'preload.cjs');
      copyFileSync(new URL('../dist/preload/index.cjs', import.meta.url), entry);
      const result = spawnSync(process.execPath, [entry], {
        cwd: directory,
        encoding: 'utf8',
        timeout: 5000,
        shell: false,
      });
      expect(result.error).toBeUndefined();
      expect(result.stderr).toBe('');
      expect(result.status).toBe(0);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('exposes exactly the facade projection - no method more, none less', () => {
    const api = buildBridge(fakeIpc());
    expect(Object.keys(api).sort()).toEqual(
      [
        'open',
        'pendingInputs',
        'allInputs',
        'setValue',
        'plan',
        'describe',
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
    await api.describe();
    expect(ipc.invoke).toHaveBeenCalledWith('rune:describe');

    const seen: unknown[] = [];
    api.onEvent((event) => seen.push(event));
    expect(ipc.on).toHaveBeenCalledWith('rune:event', expect.any(Function));
    const listener = ipc.on.mock.calls[0]?.[1] as (event: unknown, payload: unknown) => void;
    const runStarted = {
      kind: 'runStarted',
      plan: {
        planSchemaVersion: 1,
        manifestPath: 'installer.yaml',
        manifestSha256: 'a'.repeat(64),
        locale: null,
        platform: 'linux',
        preview: false,
        resolvedInputs: [],
        executionOptions: { failFast: true },
        steps: [],
      },
      displayText: 'running 0 steps on linux',
    } satisfies BridgeEvent;
    listener(undefined, { sequence: 1, event: runStarted });
    expect(seen).toEqual([runStarted]);
    expect(ipc.send).toHaveBeenCalledWith('rune:eventAck', 1);
  });

  it('acknowledges only after synchronous renderer processing, including a thrown listener', () => {
    const ipc = fakeIpc();
    const calls: string[] = [];
    ipc.send.mockImplementation(() => {
      calls.push('ack');
    });
    buildBridge(ipc).onEvent(() => {
      calls.push('render');
      throw new Error('renderer failed');
    });
    const listener = ipc.on.mock.calls[0]![1];
    expect(() => listener(undefined, { sequence: 4, event: { kind: 'stepOutput' } })).toThrow(
      'renderer failed',
    );
    expect(calls).toEqual(['render', 'ack']);
    expect(ipc.send).toHaveBeenCalledWith('rune:eventAck', 4);
  });

  it('sends one acknowledgement after every synchronous subscriber has processed the event', () => {
    const ipc = fakeIpc();
    const calls: string[] = [];
    ipc.send.mockImplementation(() => {
      calls.push('ack');
    });
    const bridge = buildBridge(ipc);
    bridge.onEvent(() => {
      calls.push('first');
    });
    bridge.onEvent(() => {
      calls.push('second');
    });
    expect(ipc.on).toHaveBeenCalledOnce();
    ipc.on.mock.calls[0]![1](undefined, { sequence: 1, event: { kind: 'stepOutput' } });
    expect(calls).toEqual(['first', 'second', 'ack']);
    expect(ipc.send).toHaveBeenCalledOnce();
  });
});
