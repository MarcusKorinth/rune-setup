import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { describe, expect, it, vi } from 'vitest';

import { InputError, RuneError, Session } from '@rune/engine';

vi.mock('electron', () => ({
  app: {},
  BrowserWindow: class {},
  ipcMain: { handle: vi.fn() },
}));

import { BRIDGE_CHANNELS, EVENT_CHANNEL, registerBridge } from '../src/main/index.js';
import type { BridgeEvent, BridgeInput, BridgePlan } from '../src/preload/types.js';

function fixture(): string {
  const dir = mkdtempSync(join(tmpdir(), 'rune-bridge-'));
  const path = join(dir, 'installer.yaml');
  const assetDir = join(dir, 'theme assets #1');
  mkdirSync(assetDir);
  writeFileSync(join(assetDir, 'logo #1.png'), 'not-a-real-png');
  writeFileSync(join(assetDir, 'banner #1.png'), 'not-a-real-png');
  writeFileSync(join(assetDir, 'custom #1.css'), ':root {}');
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
      '  logo: "theme assets #1/logo #1.png"',
      '  banner: "theme assets #1/banner #1.png"',
      '  theme: "theme assets #1/custom #1.css"',
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

function rejectedFixture(): string {
  const dir = mkdtempSync(join(tmpdir(), 'rune-bridge-rejection-'));
  const path = join(dir, 'installer.yaml');
  writeFileSync(
    path,
    [
      'schemaVersion: 1',
      'product:',
      '  name: Example',
      '  version: "1.0.0"',
      'inputs:',
      '  token:',
      '    type: secret',
      '  code:',
      '    type: text',
      '    required: false',
      '    pattern: "[A-Z]+"',
      '    default: prefix-super-secret-value',
      'steps: []',
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
    const manifestPath = fixture();
    const session = await Session.open(manifestPath, {
      environment: {},
      mode: 'gui',
      overrides: { token: 'super-secret-value' },
    });
    const bridge = await bridgeOver(session);

    const opened = (await bridge.call('rune:open')) as {
      product: { name: string };
    };
    const strings = (await bridge.call('rune:getStrings')) as Record<string, string>;
    const theme = (await bridge.call('rune:getThemeConfig')) as {
      windowTitle: string;
      logo: string;
      banner: string;
      theme: string;
    };
    const assetDir = join(dirname(manifestPath), 'theme assets #1');

    expect(opened.product.name).toBe('Example ***');
    expect(strings['product.description']).toBe('Description ***');
    expect(strings['gui.windowTitle']).toBe('Window ***');
    expect(theme.windowTitle).toBe('Window ***');
    expect(theme.logo).toBe(pathToFileURL(join(assetDir, 'logo #1.png')).href);
    expect(theme.banner).toBe(pathToFileURL(join(assetDir, 'banner #1.png')).href);
    expect(theme.theme).toBe(pathToFileURL(join(assetDir, 'custom #1.css')).href);
    expect(theme.logo).toContain('%20');
    expect(theme.logo).toContain('%23');
    expect(JSON.stringify({ opened, strings, theme })).not.toContain('super-secret-value');
  });

  it('masks theme asset paths before encoding them as file URLs', async () => {
    const secret = 'theme assets #1';
    const session = await Session.open(fixture(), {
      environment: {},
      mode: 'gui',
      overrides: { token: secret },
    });
    const rawTheme = session.getThemeConfig();
    const bridge = await bridgeOver(session);

    const theme = (await bridge.call('rune:getThemeConfig')) as {
      logo: string;
      banner: string;
      theme: string;
    };
    const pairs = [
      [rawTheme.logo, theme.logo],
      [rawTheme.banner, theme.banner],
      [rawTheme.theme, theme.theme],
    ] as const;

    for (const [rawPath, url] of pairs) {
      expect(rawPath).toBeDefined();
      if (rawPath === undefined) {
        throw new Error('the fixture theme asset path was absent');
      }
      expect(existsSync(rawPath)).toBe(true);
      expect(rawPath).toContain(secret);
      expect(url).toBe(pathToFileURL(session.mask(rawPath)).href);
      expect(url).toContain('%20');
      expect(url).toContain('%23');
      expect(url).not.toContain(secret);
      expect(decodeURIComponent(url)).not.toContain(secret);
    }
  });

  it('preserves absent unanswered fields and disabled-input provenance', async () => {
    const session = await Session.open(fixture(), {
      environment: {},
      mode: 'gui',
      overrides: { databasePort: '5432' },
    });
    const bridge = await bridgeOver(session);

    const inputs = (await bridge.call('rune:allInputs')) as readonly BridgeInput[];
    const unanswered = inputs.find((input) => input.id === 'token');
    const disabled = inputs.find((input) => input.id === 'databasePort');

    expect(unanswered).toMatchObject({ id: 'token', enabled: true, spec: { type: 'secret' } });
    expect(unanswered).not.toHaveProperty('value');
    expect(unanswered).not.toHaveProperty('source');
    expect(unanswered).not.toHaveProperty('ignored');
    expect(disabled).toMatchObject({
      id: 'databasePort',
      enabled: false,
      value: '',
      ignored: 'set',
    });
    expect(disabled).not.toHaveProperty('source');
  });

  it('projects recoverable rejection state as plain data through the common masking sink', async () => {
    const session = await Session.open(rejectedFixture(), {
      environment: {},
      mode: 'gui',
      overrides: { token: 'super-secret-value' },
    });
    const bridge = await bridgeOver(session);

    const all = (await bridge.call('rune:allInputs')) as readonly BridgeInput[];
    const pending = (await bridge.call('rune:pendingInputs')) as readonly BridgeInput[];
    const rejected = all.find((input) => input.id === 'code');

    expect(rejected).toMatchObject({
      id: 'code',
      enabled: true,
      rejection: {
        source: 'default',
        problem: {
          code: 'RUNE-202',
          message: 'code (from the manifest default): "prefix-***" does not match [A-Z]+',
        },
        candidate: 'prefix-***',
      },
    });
    expect(rejected).not.toHaveProperty('value');
    expect(rejected).not.toHaveProperty('source');
    expect(pending).toEqual([rejected]);
    expect(JSON.parse(JSON.stringify({ all, pending }))).toEqual({ all, pending });
    expect(JSON.stringify({ all, pending })).not.toContain('super-secret-value');
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

  it('includes located RuneError issues once and masks them at the rejection sink', async () => {
    const session = await Session.open(fixture(), {
      environment: {},
      mode: 'gui',
      overrides: { token: 'super-secret-value' },
    });
    const located = new RuneError('RUNE-202', 'invalid value super-secret-value', {
      location: { file: 'answers.yaml', line: 7, column: 9 },
    });
    const aggregate = InputError.fromIssues('RUNE-202', [
      {
        code: 'RUNE-202',
        message: 'first invalid value',
        location: { file: 'answers.yaml', line: 7, column: 9 },
      },
      {
        code: 'RUNE-202',
        message: 'second invalid value',
        location: { file: 'answers.yaml', line: 8, column: 9 },
      },
    ]);
    vi.spyOn(session, 'warnings')
      .mockImplementationOnce(() => {
        throw located;
      })
      .mockImplementationOnce(() => {
        throw aggregate;
      });
    const bridge = await bridgeOver(session);

    const locatedRejection = await rejectedBy(bridge.call('rune:warnings'));
    const aggregateRejection = await rejectedBy(bridge.call('rune:warnings'));

    expect(locatedRejection.message).toBe('RUNE-202 (exit 4): answers.yaml:7:9: invalid value ***');
    expect(locatedRejection.message).not.toContain('super-secret-value');
    expect(aggregateRejection.message).toBe(
      'RUNE-202 (exit 4): answers.yaml:7:9: first invalid value\n' +
        'answers.yaml:8:9: second invalid value',
    );
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

    const inputs = (await bridge.call('rune:allInputs')) as readonly BridgeInput[];
    expect(inputs.find((input) => input.id === 'token')?.value).toBeNull();

    const plan = (await bridge.call('rune:plan')) as BridgePlan;

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
    const plan = (await bridge.call('rune:plan')) as BridgePlan;

    const result = (await bridge.call('rune:execute')) as { status: string; mode: string };

    expect(result.status).toBe('succeeded');
    expect(result.mode).toBe('gui');
    expect(bridge.sent.length).toBeGreaterThan(0);
    expect(bridge.sent[0]).toEqual({
      channel: EVENT_CHANNEL,
      payload: { kind: 'runStarted', plan },
    });
    const started = bridge.sent[0]?.payload as BridgeEvent | undefined;
    if (started?.kind !== 'runStarted') {
      throw new Error('the first event was not runStarted');
    }
    const use = started.plan.steps[0];
    if (use?.state !== 'PENDING') {
      throw new Error('the first planned step was not pending');
    }
    expect(use.command).toEqual({
      argv: ['***', '--token', '***', '***'],
      cwd: '***',
      env: { TOKEN: '***', LITERAL: '***' },
      timeoutSeconds: null,
      successExitCodes: [0],
    });
    expect(use.command.argv).not.toContain(null);
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
