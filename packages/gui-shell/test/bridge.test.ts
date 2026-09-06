import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { describe, expect, it, vi } from 'vitest';

import { InputError, RuneError, Session, type RunEvent, type RunResult } from '@rune/engine';

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

function structuredProjectionFixture(): string {
  const dir = mkdtempSync(join(tmpdir(), 'rune-bridge-structured-'));
  const path = join(dir, 'installer.yaml');
  writeFileSync(
    path,
    [
      'schemaVersion: 1',
      'product:',
      '  name: COLLISION_PRODUCT',
      '  version: "1.2.3"',
      '  description: "Description DISPLAY_SECRET\\nsecond\\tline"',
      'gui:',
      '  accentColor: "#123abc"',
      '  windowTitle: "Window DISPLAY_SECRET\\nsecond\\tline"',
      'inputs:',
      '  productIdentity:',
      '    type: secret',
      '  productVersion:',
      '    type: secret',
      '  environmentName:',
      '    type: secret',
      '  accent:',
      '    type: secret',
      '  display:',
      '    type: secret',
      'steps:',
      '  - id: use',
      '    title: "Step DISPLAY_SECRET\\nsecond\\tline"',
      '    run:',
      '      command: echo',
      '      args: ["Argument public\\nsecond\\tline", "${display}"]',
      '      env:',
      '        COLLISION_ENV: "Environment public\\nsecond\\tline"',
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
      {
        events: { send: () => undefined },
        onExecuteError: (error) => {
          errors.push(error);
        },
      },
      (channel, handler) => handlers.set(channel, handler),
    );

    await expect(handlers.get('rune:execute')?.()).rejects.toThrow(/token|databasePort/);
    expect(errors).toHaveLength(1);
  });

  it('reports a rejected execute completion through the same fatal boundary', async () => {
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const session = await Session.open(fixture(), {
      environment: {},
      mode: 'gui',
      overrides: { token: 'super-secret-value' },
    });
    vi.spyOn(Session.prototype, 'execute').mockResolvedValue(session.describe());
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
    stderr.mockRestore();
  });

  it('is a 1:1 projection: exactly the pinned channels, nothing else', async () => {
    const session = await Session.open(fixture(), { environment: {}, mode: 'gui' });
    const bridge = await bridgeOver(session);

    expect(bridge.channels.sort()).toEqual([...BRIDGE_CHANNELS].sort());
  });

  it('uses the engine structured projections for successful returns', async () => {
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

    expect(opened.product.name).toBe('Example super-secret-value');
    expect(strings['product.description']).toBe('Description ***');
    expect(strings['gui.windowTitle']).toBe('Window ***');
    expect(theme.windowTitle).toBe('Window ***');
    expect(theme.logo).toBe(pathToFileURL(join(assetDir, 'logo #1.png')).href);
    expect(theme.banner).toBe(pathToFileURL(join(assetDir, 'banner #1.png')).href);
    expect(theme.theme).toBe(pathToFileURL(join(assetDir, 'custom #1.css')).href);
    expect(theme.logo).toContain('%20');
    expect(theme.logo).toContain('%23');
    expect(JSON.stringify({ strings, theme })).not.toContain('super-secret-value');
  });

  it('preserves exact identity and configuration while retaining structured masking', async () => {
    const session = await Session.open(structuredProjectionFixture(), {
      environment: {},
      mode: 'gui',
      overrides: {
        productIdentity: 'COLLISION_PRODUCT',
        productVersion: '1.2.3',
        environmentName: 'COLLISION_ENV',
        accent: '#123abc',
        display: 'DISPLAY_SECRET',
      },
    });
    const bridge = await bridgeOver(session);

    const opened = (await bridge.call('rune:open')) as {
      product: { name: string; version: string };
    };
    const strings = (await bridge.call('rune:getStrings')) as Record<string, string>;
    const theme = (await bridge.call('rune:getThemeConfig')) as {
      accentColor: string;
      windowTitle: string;
    };
    const plan = (await bridge.call('rune:plan')) as BridgePlan;
    const result = (await bridge.call('rune:describe')) as RunResult;
    const step = plan.steps[0];
    if (step?.state !== 'PENDING') {
      throw new Error('the structured projection fixture did not produce a pending step');
    }

    expect(opened.product).toEqual({ name: 'COLLISION_PRODUCT', version: '1.2.3' });
    expect(result.product).toEqual(opened.product);
    expect(theme.accentColor).toBe('#123abc');
    expect(Object.keys(step.command.env)).toEqual(['COLLISION_ENV']);
    expect(strings['product.description']).toBe('Description ***\nsecond\tline');
    expect(strings['gui.windowTitle']).toBe('Window ***\nsecond\tline');
    expect(theme.windowTitle).toBe('Window ***\nsecond\tline');
    expect(step.title).toBe('Step ***\nsecond\tline');
    expect(step.command.argv.at(-2)).toBe('Argument public\nsecond\tline');
    expect(step.command.argv.at(-1)).toBe('***');
    expect(step.command.env['COLLISION_ENV']).toBe('Environment public\nsecond\tline');
    expect(result.steps[0]?.title).toBe('Step ***\nsecond\tline');
    expect(result.steps[0]?.command?.at(-2)).toBe('Argument public\nsecond\tline');
    expect(result.steps[0]?.command?.at(-1)).toBe('***');
    expect(result.inputs.every((input) => input.secret && input.value === null)).toBe(true);

    const plain = JSON.parse(JSON.stringify({ opened, strings, theme, plan, result })) as unknown;
    expect(plain).toEqual({ opened, strings, theme, plan, result });
    const withoutExactExceptions = JSON.stringify({
      opened: { ...opened, product: { name: 'identity', version: 'identity' } },
      strings,
      theme: { ...theme, accentColor: 'identity' },
      plan: {
        ...plan,
        steps: plan.steps.map((plannedStep) =>
          plannedStep.state === 'PENDING'
            ? {
                ...plannedStep,
                command: {
                  ...plannedStep.command,
                  env: { identity: plannedStep.command.env['COLLISION_ENV'] },
                },
              }
            : plannedStep,
        ),
      },
      result: { ...result, product: { name: 'identity', version: 'identity' } },
    });
    for (const secret of [
      'COLLISION_PRODUCT',
      '1.2.3',
      'COLLISION_ENV',
      '#123abc',
      'DISPLAY_SECRET',
    ]) {
      expect(withoutExactExceptions).not.toContain(secret);
    }
  });

  it('keeps exact theme asset paths while encoding them as file URLs', async () => {
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
      expect(url).toBe(pathToFileURL(rawPath).href);
      expect(url).toContain('%20');
      expect(url).toContain('%23');
      expect(decodeURIComponent(url)).toContain(secret);
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
        issue: {
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

  it('normalizes facade and unknown rejections without exposing secrets', async () => {
    const session = await Session.open(fixture(), {
      environment: {},
      mode: 'gui',
      overrides: { token: 'super-secret-value' },
    });
    vi.spyOn(Session.prototype, 'warnings').mockImplementation(() => {
      throw new Error('generic failure contains super-secret-value');
    });
    vi.spyOn(Session.prototype, 'getThemeConfig').mockImplementation(() =>
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

  it('masks a secret formed across the bridge prefix and a real validation issue', async () => {
    const secret = '): installDatabase';
    const session = await Session.open(fixture(), {
      environment: {},
      mode: 'gui',
      overrides: { token: secret },
    });
    const bridge = await bridgeOver(session);

    const error = await rejectedBy(bridge.call('rune:setValue', 'installDatabase', 'invalid'));

    expect(error.message).toContain('RUNE-202');
    expect(error.message).toContain('exit 4');
    expect(error.message).toContain('***');
    expect(error.message).not.toContain(secret);
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
    vi.spyOn(Session.prototype, 'warnings')
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
      'RUNE-202 (exit 4): answers.yaml:7:9: first invalid value\\n' +
        'answers.yaml:8:9: second invalid value',
    );
  });

  it('projects Session.plan exactly once as plain masked plan data', async () => {
    const manifestPath = fixture();
    const session = await Session.open(manifestPath, {
      environment: {},
      mode: 'gui',
      overrides: { token: 'super-secret-value' },
    });
    const planSpy = vi.spyOn(Session.prototype, 'plan');
    const describeSpy = vi.spyOn(Session.prototype, 'describe');
    const bridge = await bridgeOver(session);

    const inputs = (await bridge.call('rune:allInputs')) as readonly BridgeInput[];
    expect(inputs.find((input) => input.id === 'token')?.value).toBeNull();

    const plan = (await bridge.call('rune:plan')) as BridgePlan;

    expect(planSpy).toHaveBeenCalledTimes(1);
    expect(describeSpy).not.toHaveBeenCalled();
    expect(plan).toMatchObject({
      manifestPath,
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
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const session = await Session.open(fixture(), {
      environment: {},
      mode: 'gui',
      overrides: { token: 'super-secret-value' },
    });
    session.setValue('installDatabase', false);
    const rawPlan = session.plan();
    const described = session.describe();
    const executionResult = {
      ...described,
      status: 'succeeded',
      exitCode: 0,
      dryRun: false,
      error: null,
      stepsExecuted: 1,
      stepsSucceeded: 1,
      nothingExecuted: false,
      steps: described.steps.map((step) =>
        step.state === 'PENDING'
          ? { ...step, state: 'SUCCEEDED' as const, exitCode: 0, durationMs: 1 }
          : step,
      ),
    } as RunResult;
    vi.spyOn(Session.prototype, 'execute').mockImplementation(async (observer) => {
      const events: RunEvent[] = [
        { kind: 'runStarted', plan: rawPlan },
        { kind: 'stepStarted', stepId: 'use', index: 0, total: 2, title: 'use' },
        { kind: 'stepOutput', stepId: 'use', stream: 'stdout', line: 'the token is ***' },
        { kind: 'stepFinished', stepId: 'use', state: 'SUCCEEDED', exitCode: 0, durationMs: 1 },
        {
          kind: 'stepFinished',
          stepId: 'skipped',
          state: 'SKIPPED',
          exitCode: undefined,
          durationMs: 0,
        },
        { kind: 'runFinished', result: executionResult },
      ];
      for (const event of events) {
        observer?.(event);
      }
      return executionResult;
    });
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
    const eventsWithoutExactProduct = bridge.sent.map(({ channel, payload }) => {
      const event = payload as BridgeEvent;
      return event.kind === 'runFinished' && event.result.product !== null
        ? {
            channel,
            payload: {
              ...event,
              result: {
                ...event.result,
                product: { name: 'identity', version: 'identity' },
              },
            },
          }
        : { channel, payload };
    });
    expect(JSON.stringify(eventsWithoutExactProduct)).not.toContain('super-secret-value');
    expect(JSON.stringify(bridge.sent)).toContain('***');
    const diagnostics = stderr.mock.calls.map(([text]) => String(text)).join('');
    expect(diagnostics).toMatch(/^running 2 steps on \w+\r?\n/);
    expect(diagnostics).toContain('[1/2] use\n');
    expect(diagnostics).toContain('  the token is ***\n');
    expect(diagnostics).toMatch(/ {2}-> SUCCEEDED \(exit 0\) after \d+ms\r?\n/);
    expect(diagnostics).toMatch(/ {2}-> SKIPPED after \d+ms\r?\n$/);
    expect(diagnostics).not.toContain('super-secret-value');
    stderr.mockRestore();
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
