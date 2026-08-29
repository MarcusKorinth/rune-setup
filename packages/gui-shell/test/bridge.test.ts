import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import { Session } from '@rune/engine';

vi.mock('electron', () => ({
  app: {},
  BrowserWindow: class {},
  ipcMain: { handle: vi.fn() },
}));

import { BRIDGE_CHANNELS, EVENT_CHANNEL, openSession, registerBridge } from '../src/main/index.js';

function fixture(): string {
  const dir = mkdtempSync(join(tmpdir(), 'rune-bridge-'));
  const path = join(dir, 'installer.yaml');
  writeFileSync(
    path,
    [
      'schemaVersion: 1',
      'product:',
      '  name: Example',
      '  version: "1.0.0"',
      'inputs:',
      '  installDatabase:',
      '    type: boolean',
      '    default: false',
      '  databasePort:',
      '    type: text',
      '    when: "${installDatabase}"',
      '  token:',
      '    type: secret',
      'steps:',
      '  - id: use',
      '    run:',
      '      command: deploy',
      '      args: ["--token", "${token}"]',
      '',
    ].join('\n'),
    'utf8',
  );
  return path;
}

function missingGuiAssetFixture(): string {
  const dir = mkdtempSync(join(tmpdir(), 'rune-gui-assets-'));
  const path = join(dir, 'installer.yaml');
  writeFileSync(
    path,
    [
      'schemaVersion: 1',
      'product:',
      '  name: Example',
      '  version: "1.0.0"',
      'gui:',
      '  logo: assets/missing.png',
      'inputs: {}',
      'steps: []',
      '',
    ].join('\n'),
    'utf8',
  );
  return path;
}

function shellInvocation(manifestPath: string, nonInteractive: boolean) {
  return {
    manifestPath,
    values: [],
    overrides: {},
    locale: undefined,
    result: undefined,
    logFile: undefined,
    nonInteractive,
  };
}

async function bridgeOver(session: Session): Promise<{
  channels: string[];
  call: (channel: string, ...args: unknown[]) => Promise<unknown>;
  sent: { channel: string; payload: unknown }[];
}> {
  const handlers = new Map<string, (...args: unknown[]) => unknown>();
  const sent: { channel: string; payload: unknown }[] = [];
  registerBridge(
    session,
    { events: { send: (channel: string, payload: unknown) => sent.push({ channel, payload }) } },
    (channel, handler) => handlers.set(channel, handler),
  );
  return {
    channels: [...handlers.keys()],
    call: async (channel, ...args) => {
      const handler = handlers.get(channel);
      if (handler === undefined) {
        throw new Error(`no handler for ${channel}`);
      }
      return handler(...args);
    },
    sent,
  };
}

describe('the IPC bridge', () => {
  it('checks GUI assets for windowed sessions but ignores them headlessly', async () => {
    const manifestPath = missingGuiAssetFixture();

    await expect(openSession(shellInvocation(manifestPath, false))).rejects.toThrow(
      /gui\.logo.*does not exist/,
    );
    await expect(openSession(shellInvocation(manifestPath, true))).resolves.toBeInstanceOf(Session);
  });

  it('reports a rejected execute through onExecuteError — fatal in main, never a wedge', async () => {
    // Required input left unanswered: execute() throws at plan time.
    const session = await Session.open(fixture(), { environment: {}, mode: 'gui' });
    session.setValue('installDatabase', true);
    const errors: unknown[] = [];
    const handlers = new Map<string, (...args: unknown[]) => unknown>();
    registerBridge(
      session,
      { events: { send: () => undefined }, onExecuteError: (error) => errors.push(error) },
      (channel, handler) => handlers.set(channel, handler),
    );

    await expect(handlers.get('rune:execute')?.()).rejects.toThrow(/token|databasePort/);
    expect(errors).toHaveLength(1);
  });

  it('is a 1:1 projection: exactly the pinned channels, nothing else', async () => {
    const session = await Session.open(fixture(), { environment: {}, mode: 'gui' });
    const bridge = await bridgeOver(session);

    expect(bridge.channels.sort()).toEqual([...BRIDGE_CHANNELS].sort());
  });

  it('never lets a secret cross towards the renderer', async () => {
    const session = await Session.open(fixture(), {
      environment: {},
      mode: 'gui',
      overrides: { token: 'super-secret-value' },
    });
    const bridge = await bridgeOver(session);

    const inputs = (await bridge.call('rune:allInputs')) as readonly {
      id: string;
      value: unknown;
    }[];
    expect(inputs.find((input) => input.id === 'token')?.value).toBeNull();

    await bridge.call('rune:setValue', 'installDatabase', true);
    await bridge.call('rune:setValue', 'databasePort', '5432');
    const plan = await bridge.call('rune:plan');
    expect(JSON.stringify(plan)).not.toContain('super-secret-value');
    expect(JSON.stringify(inputs)).not.toContain('super-secret-value');
  });

  it('returns the InputStateChanged list as the resolved value of setValue', async () => {
    const session = await Session.open(fixture(), { environment: {}, mode: 'gui' });
    const bridge = await bridgeOver(session);

    const changes = await bridge.call('rune:setValue', 'installDatabase', true);
    expect(changes).toEqual([{ inputId: 'databasePort', enabled: true }]);
  });

  it('pushes every run event through the serializer, pre-masked', async () => {
    const session = await Session.open(fixture(), {
      environment: {},
      mode: 'gui',
      overrides: { token: 'super-secret-value' },
      runner: {
        run: async (request) => {
          request.onOutput('stdout', 'the token is super-secret-value');
          return { kind: 'exited', exitCode: 0 };
        },
      },
    });
    session.setValue('installDatabase', false);
    const bridge = await bridgeOver(session);

    const result = (await bridge.call('rune:execute')) as { status: string; mode: string };

    expect(result.status).toBe('succeeded');
    expect(result.mode).toBe('gui');
    expect(bridge.sent.length).toBeGreaterThan(0);
    for (const { channel, payload } of bridge.sent) {
      expect(channel).toBe(EVENT_CHANNEL);
      // JSON-safe plain data only — a raw engine object would not survive this round trip.
      expect(JSON.parse(JSON.stringify(payload))).toEqual(payload);
    }
    expect(JSON.stringify(bridge.sent)).not.toContain('super-secret-value');
    expect(JSON.stringify(bridge.sent)).toContain('***');
  });
});
