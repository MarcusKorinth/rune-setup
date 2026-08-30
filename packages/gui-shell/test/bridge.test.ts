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

import { BRIDGE_CHANNELS, EVENT_CHANNEL, registerBridge } from '../src/main/index.js';

function fixture(): string {
  const dir = mkdtempSync(join(tmpdir(), 'rune-bridge-'));
  const path = join(dir, 'installer.yaml');
  writeFileSync(
    path,
    [
      'schemaVersion: 1',
      'product:',
      '  name: "Example super-secret-value"',
      '  version: "1.0.0"',
      '  description: "Description super-secret-value"',
      'gui:',
      '  windowTitle: "Window super-secret-value"',
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
      '      command: "${token}"',
      '      args: ["--token", "${token}", "super-secret-value"]',
      '      cwd: "${token}"',
      '      env:',
      '        TOKEN: "${token}"',
      '        LITERAL: super-secret-value',
      '  - id: skipped',
      '    when: "${installDatabase}"',
      '    run:',
      '      command: echo',
      '',
    ].join('\n'),
    'utf8',
  );
  return path;
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

  it('reports a rejected execute completion through the same fatal boundary', async () => {
    const session = await Session.open(fixture(), {
      environment: {},
      mode: 'gui',
      overrides: { token: 'super-secret-value' },
      runner: { run: async () => ({ kind: 'exited', exitCode: 0 }) },
    });
    const deliveryError = new Error('writeResult failed for super-secret-value');
    const calls: string[] = [];
    const onExecuteStart = vi.fn(() => calls.push('start'));
    const onExecuteEnd = vi.fn(() => {
      calls.push('end');
      throw deliveryError;
    });
    const onExecuteError = vi.fn((error: unknown) => {
      calls.push('error');
      expect(error).toBe(deliveryError);
    });
    const handlers = new Map<string, (...args: unknown[]) => unknown>();
    registerBridge(
      session,
      {
        events: { send: () => undefined },
        onExecuteStart,
        onExecuteEnd,
        onExecuteError,
      },
      (channel, handler) => handlers.set(channel, handler),
    );

    const error = await rejectedBy(Promise.resolve(handlers.get('rune:execute')?.()));

    expect(error.message).toBe('writeResult failed for ***');
    expect(onExecuteStart).toHaveBeenCalledTimes(1);
    expect(onExecuteEnd).toHaveBeenCalledTimes(1);
    expect(onExecuteError).toHaveBeenCalledTimes(1);
    expect(calls).toEqual(['start', 'end', 'error']);
  });

  it('is a 1:1 projection: exactly the pinned channels, nothing else', async () => {
    const session = await Session.open(fixture(), { environment: {}, mode: 'gui' });
    const bridge = await bridgeOver(session);

    expect(bridge.channels.sort()).toEqual([...BRIDGE_CHANNELS].sort());
  });

  it('masks every successful return through the common registration sink', async () => {
    const session = await Session.open(fixture(), {
      environment: {},
      mode: 'gui',
      overrides: { token: 'super-secret-value' },
    });
    const bridge = await bridgeOver(session);

    const opened = (await bridge.call('rune:open')) as {
      product: { name: string };
    };
    const strings = (await bridge.call('rune:getStrings')) as Record<string, string>;
    const theme = (await bridge.call('rune:getThemeConfig')) as { windowTitle: string };

    expect(opened.product.name).toBe('Example ***');
    expect(strings['product.description']).toBe('Description ***');
    expect(strings['gui.windowTitle']).toBe('Window ***');
    expect(theme.windowTitle).toBe('Window ***');
    expect(JSON.stringify({ opened, strings, theme })).not.toContain('super-secret-value');
  });

  it('masks and normalizes every rejection through the injectable registration sink', async () => {
    const session = await Session.open(fixture(), {
      environment: {},
      mode: 'gui',
      overrides: { token: 'super-secret-value' },
    });
    vi.spyOn(session, 'warnings').mockImplementation(() => {
      throw new Error('generic failure contains super-secret-value');
    });
    vi.spyOn(session, 'getThemeConfig').mockImplementation(() =>
      throwValue('non-Error failure contains super-secret-value'),
    );
    const bridge = await bridgeOver(session);

    const runeError = await rejectedBy(bridge.call('rune:setValue', 'super-secret-value', true));
    const genericError = await rejectedBy(bridge.call('rune:warnings'));
    const nonError = await rejectedBy(bridge.call('rune:getThemeConfig'));

    expect(runeError.message).toContain('RUNE-203 (exit 4)');
    expect(runeError.message).toContain('"***" names no input');
    expect(genericError.message).toBe('generic failure contains ***');
    expect(nonError.message).toBe('non-Error failure contains ***');
    for (const error of [runeError, genericError, nonError]) {
      expect(error).toBeInstanceOf(Error);
      expect(error.message).not.toContain('super-secret-value');
    }
  });

  it('projects Session.plan exactly once as plain masked plan data', async () => {
    const session = await Session.open(fixture(), {
      environment: {},
      mode: 'gui',
      overrides: { token: 'super-secret-value' },
    });
    const planSpy = vi.spyOn(session, 'plan');
    const describeSpy = vi.spyOn(session, 'describe');
    const bridge = await bridgeOver(session);

    const inputs = (await bridge.call('rune:allInputs')) as readonly {
      id: string;
      value: unknown;
    }[];
    expect(inputs.find((input) => input.id === 'token')?.value).toBeNull();

    const plan = (await bridge.call('rune:plan')) as Record<string, unknown> & {
      steps: readonly Record<string, unknown>[];
    };

    expect(planSpy).toHaveBeenCalledTimes(1);
    expect(describeSpy).not.toHaveBeenCalled();
    expect(plan).toMatchObject({
      manifestPath: session.manifestPath,
      preview: false,
      failFast: true,
      steps: [
        {
          id: 'use',
          title: 'use',
          state: 'PENDING',
          command: {
            argv: ['***', '--token', '***', '***'],
            cwd: '***',
            env: { TOKEN: '***', LITERAL: '***' },
            timeoutSeconds: null,
            successExitCodes: [0],
          },
        },
        {
          id: 'skipped',
          title: 'skipped',
          state: 'SKIPPED',
          skipReason: 'condition false: ${installDatabase}',
        },
      ],
    });
    for (const resultOnlyField of [
      'status',
      'exitCode',
      'nothingExecuted',
      'stepsTotal',
      'stepsSucceeded',
      'stepsFailed',
      'stepsSkipped',
      'product',
    ]) {
      expect(plan).not.toHaveProperty(resultOnlyField);
    }
    expect(plan.steps[0]).not.toHaveProperty('exitCode');
    expect(plan.steps[0]).not.toHaveProperty('durationMs');
    expect(plan.steps[0]).not.toHaveProperty('outputTail');
    expect(plan.steps[1]).not.toHaveProperty('command');
    expect(JSON.parse(JSON.stringify(plan))).toEqual(plan);
    expect(JSON.stringify(plan)).not.toContain('super-secret-value');
    expect(JSON.stringify(inputs)).not.toContain('super-secret-value');
    expect(JSON.stringify(plan)).toContain('***');
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

async function rejectedBy(promise: Promise<unknown>): Promise<Error> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof Error) {
      return error;
    }
    throw new Error('bridge rejection was not normalized to Error');
  }
  throw new Error('bridge call unexpectedly resolved');
}

function throwValue(value: unknown): never {
  throw value;
}
