import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import ts from 'typescript';
import { describe, expect, it, vi } from 'vitest';

import type { BridgeIpc } from '../src/preload/index.cts';
import type { BridgeError, BridgeEvent } from '../src/preload/types.js';

// @ts-expect-error tsc addresses the compiled file as .cjs; vitest resolves the source
import { buildBridge } from '../src/preload/index.cts';

function fakeIpc() {
  return {
    invoke: vi.fn<BridgeIpc['invoke']>().mockResolvedValue({ ok: true }),
    on: vi.fn<BridgeIpc['on']>(),
    send: vi.fn<BridgeIpc['send']>(),
  };
}

describe('the preload bridge', () => {
  it('loads in plain Node without an installed Electron package', () => {
    const directory = mkdtempSync(join(tmpdir(), 'rune-preload-'));
    try {
      const entry = join(directory, 'preload.cjs');
      const source = readFileSync(new URL('../src/preload/index.cts', import.meta.url), 'utf8');
      const compiled = ts.transpileModule(source, {
        compilerOptions: {
          module: ts.ModuleKind.NodeNext,
          target: ts.ScriptTarget.ES2022,
          verbatimModuleSyntax: false,
        },
        fileName: 'preload.cts',
      });
      writeFileSync(entry, compiled.outputText);
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

  const failure: BridgeError = {
    kind: 'rune-error',
    code: 'RUNE-202',
    message: 'invalid value',
    location: { file: 'answers.yaml', line: 7, column: 9 },
    exitCode: 4,
    displayText: 'RUNE-202 (exit 4): answers.yaml:7:9: invalid value',
  };

  it('preserves plain failure metadata on every method and strips extra fields', async () => {
    const ipc = fakeIpc();
    ipc.invoke.mockResolvedValue({
      ok: false,
      error: {
        ...failure,
        stack: 'private stack',
        cause: 'private cause',
        location: { ...failure.location, privateValue: 'private location metadata' },
      },
    });
    const api = buildBridge(ipc);
    const { onEvent: _onEvent, setValue, ...withoutArguments } = api;
    for (const call of [...Object.values(withoutArguments), () => setValue('id', 'raw')]) {
      await expect(call()).rejects.toEqual(failure);
    }
  });

  it.each([
    undefined,
    null,
    {},
    [],
    { ok: 'true' },
    { ok: false },
    { ok: false, error: { ...failure, exitCode: NaN } },
    { ok: false, error: { ...failure, location: { file: 'bad', line: 0, column: 1 } } },
    { ok: false, error: { ...failure, code: 'unexpected' } },
  ])('fails closed on malformed reply %#', async (reply) => {
    const ipc = fakeIpc();
    ipc.invoke.mockResolvedValue(reply);
    await expect(buildBridge(ipc).plan()).rejects.toEqual({
      kind: 'rune-error',
      code: 'RUNE-500',
      message: 'An unexpected shell error occurred.',
      location: null,
      exitCode: 70,
      displayText: 'RUNE-500 (exit 70): An unexpected shell error occurred.',
    });
  });

  it('suppresses untrusted Electron transport errors', async () => {
    const ipc = fakeIpc();
    ipc.invoke.mockRejectedValue(new Error('Error invoking remote method: private-token'));
    await expect(buildBridge(ipc).plan()).rejects.toMatchObject({
      code: 'RUNE-500',
      exitCode: 70,
      displayText: 'RUNE-500 (exit 70): An unexpected shell error occurred.',
    });
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
