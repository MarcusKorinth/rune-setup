import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import { describe, expect, it, vi } from 'vitest';

import {
  CancelledError,
  ExecutionError,
  InputError,
  RuneError,
  Session,
  type RunEvent,
  type RunResult,
} from '@rune/engine';

vi.mock('electron', () => ({
  app: {},
  BrowserWindow: class {},
  ipcMain: { handle: vi.fn() },
}));

import { BRIDGE_CHANNELS, EVENT_CHANNEL, registerBridge } from '../src/main/index.js';
import type {
  BridgeEvent,
  BridgeInput,
  BridgePlan,
  BridgeResult,
  BridgeStrings,
} from '../src/preload/types.js';
import { completeWrite } from './stream-fixture.js';

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
      `      args: ${JSON.stringify([
        '--token',
        '${token}',
        'contains whitespace',
        '',
        '"quoted"',
        'back\\slash',
        'super-secret-value',
      ])}`,
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

function editRejectionFixture(patternHint = 'Use later-secret-42\nsecond line'): string {
  const dir = mkdtempSync(join(tmpdir(), 'rune-bridge-edit-rejection-'));
  const path = join(dir, 'installer.yaml');
  writeFileSync(
    path,
    [
      'schemaVersion: 1',
      'product:',
      '  name: Example',
      '  version: "1.0.0"',
      'inputs:',
      '  enableCode:',
      '    type: boolean',
      '    default: true',
      '  code:',
      '    type: text',
      '    required: false',
      '    when: "${enableCode}"',
      '    pattern: "[A-Z]+"',
      `    patternHint: ${JSON.stringify(patternHint)}`,
      '    default: GOOD',
      '  token:',
      '    type: secret',
      '    required: false',
      'steps: []',
      '',
    ].join('\n'),
    'utf8',
  );
  return path;
}

function controllingRejectionFixture(): string {
  const dir = mkdtempSync(join(tmpdir(), 'rune-bridge-controlling-rejection-'));
  const path = join(dir, 'installer.yaml');
  writeFileSync(
    path,
    [
      'schemaVersion: 1',
      'product:',
      '  name: Example',
      '  version: "1.0.0"',
      'inputs:',
      '  enabled:',
      '    type: boolean',
      '    default: false',
      '  booleanDependent:',
      '    type: text',
      '    required: false',
      '    when: "${enabled}"',
      '    default: "${env.MISSING_BOOLEAN}"',
      '  token:',
      '    type: secret',
      '    required: false',
      '  secretDependent:',
      '    type: text',
      '    required: false',
      '    when: "${token} == \'MISSING_SECRET\'"',
      '    default: "${env.MISSING_SECRET}"',
      'steps: []',
      '',
    ].join('\n'),
    'utf8',
  );
  return path;
}

function withoutEditRejections(inputs: readonly BridgeInput[]): unknown {
  return inputs.map(({ editRejection: _editRejection, ...input }) => input);
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

function derivedProductFixture(): {
  manifestPath: string;
  productName: string;
  relativeSecret: string;
} {
  const dir = mkdtempSync(join(tmpdir(), 'rune-bridge-derived-product-'));
  const manifestPath = join(dir, 'installer.yaml');
  const relativeSecret = 'private/../secret-target';
  const productName = resolve(dir, relativeSecret);
  writeFileSync(
    manifestPath,
    [
      'schemaVersion: 1',
      'product:',
      `  name: ${JSON.stringify(productName)}`,
      '  version: "1.0.0"',
      'inputs:',
      '  workingDirectory:',
      '    type: secret',
      'steps:',
      '  - id: use',
      '    run:',
      '      command: echo',
      '      cwd: "${workingDirectory}"',
      '',
    ].join('\n'),
    'utf8',
  );
  return { manifestPath, productName, relativeSecret };
}

function composedDisplayFixture(): string {
  const dir = mkdtempSync(join(tmpdir(), 'rune-bridge-composed-display-'));
  const localeDir = join(dir, 'locales');
  mkdirSync(localeDir);
  const path = join(dir, 'installer.yaml');
  writeFileSync(
    path,
    [
      'schemaVersion: 1',
      'product:',
      '  name: Composed display',
      '  version: "1.0.0"',
      'inputs:',
      '  runStartedBoundary:',
      '    type: secret',
      '  stepStartedBoundary:',
      '    type: secret',
      '  outputBoundary:',
      '    type: secret',
      '  summaryBoundary:',
      '    type: secret',
      '  warningBoundary:',
      '    type: secret',
      '  commandBoundary:',
      '    type: secret',
      '  titleBoundary:',
      '    type: secret',
      'steps:',
      '  - id: install',
      '    title: Install',
      '    run:',
      '      command: hello',
      '      args: [world]',
      '  - id: warning',
      '    run:',
      '      command: node',
      '      args: [noop.cjs, "${warningBoundary}"]',
      '',
    ].join('\n'),
    'utf8',
  );
  writeFileSync(
    join(localeDir, 'de.yaml'),
    [
      "rune.progress.output: 'Output {line}'",
      "rune.warning: 'Warning {message}'",
      "rune.result.stepTitle: 'LOKAL ERGEBNIS {title} CODE {exitCode}'",
      '',
    ].join('\n'),
    'utf8',
  );
  return path;
}

function planWithoutPresentation(plan: BridgePlan): unknown {
  return {
    ...plan,
    steps: plan.steps.map((step) => {
      if (step.state === 'SKIPPED') {
        return step;
      }
      const { displayCommand: _displayCommand, ...machineStep } = step;
      return machineStep;
    }),
  };
}

function resultWithoutPresentation(result: BridgeResult): unknown {
  const { displaySummary: _displaySummary, ...machineResult } = result;
  return {
    ...machineResult,
    steps: machineResult.steps.map((step) => {
      const { displayTitle: _displayTitle, ...machineStep } = step;
      return machineStep;
    }),
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
  it('reports a rejected execute through onExecuteError — fatal in main, never a wedge', async () => {
    // Required input left unanswered: execute() throws at plan time.
    const session = await Session.open(fixture(), { environment: {}, mode: 'gui' });
    session.setValue('installDatabase', true);
    const plan = vi.spyOn(Session.prototype, 'plan');
    const execute = vi.spyOn(Session.prototype, 'execute');
    const onExecuteStart = vi.fn();
    const errors: Array<{ error: unknown; plan: unknown }> = [];
    const handlers = new Map<string, (...args: unknown[]) => unknown>();
    registerBridge(
      session,
      {
        events: { send: () => undefined },
        onExecuteStart,
        onExecuteError: (error, failedPlan) => {
          errors.push({ error, plan: failedPlan });
        },
      },
      (channel, handler) => handlers.set(channel, handler),
    );

    await expect(handlers.get('rune:execute')?.()).rejects.toThrow(/token|databasePort/);
    expect(errors).toHaveLength(1);
    expect(errors[0]?.plan).toBeUndefined();
    expect(plan).toHaveBeenCalledTimes(1);
    expect(execute).not.toHaveBeenCalled();
    expect(onExecuteStart).toHaveBeenCalledOnce();
    plan.mockRestore();
    execute.mockRestore();
  });

  it('denies execute admission before planning without entering failure delivery', async () => {
    const session = await Session.open(fixture(), {
      environment: {},
      mode: 'gui',
      overrides: { token: 'super-secret-value' },
    });
    const plan = vi.spyOn(Session.prototype, 'plan');
    const execute = vi.spyOn(Session.prototype, 'execute');
    const onExecuteStart = vi.fn(() => {
      throw new CancelledError();
    });
    const onExecuteError = vi.fn();
    const onExecuteEnd = vi.fn();
    const handlers = new Map<string, (...args: unknown[]) => unknown>();
    registerBridge(
      session,
      {
        events: { send: () => undefined },
        onExecuteStart,
        onExecuteError,
        onExecuteEnd,
      },
      (channel, handler) => handlers.set(channel, handler),
    );

    await expect(handlers.get('rune:execute')?.()).rejects.toThrow('RUNE-601 (exit 6)');
    expect(onExecuteStart).toHaveBeenCalledOnce();
    expect(plan).not.toHaveBeenCalled();
    expect(execute).not.toHaveBeenCalled();
    expect(onExecuteError).not.toHaveBeenCalled();
    expect(onExecuteEnd).not.toHaveBeenCalled();
    plan.mockRestore();
    execute.mockRestore();
  });

  it('retains an engine terminal result when execute rejects during finalization', async () => {
    const session = await Session.open(fixture(), {
      environment: {},
      mode: 'gui',
      overrides: { token: 'super-secret-value' },
    });
    session.setValue('installDatabase', false);
    const expectedPlan = session.plan();
    const terminalResult = session.describe();
    const failure = new ExecutionError('RUNE-406', 'the log close failed');
    const execute = vi.spyOn(Session.prototype, 'execute').mockImplementation(async (observer) => {
      observer?.({ kind: 'runFinished', result: terminalResult });
      throw failure;
    });
    const sent: Array<{ channel: string; payload: unknown }> = [];
    const errors: Array<{
      error: unknown;
      plan: unknown;
      terminalResult: RunResult | undefined;
    }> = [];
    const handlers = new Map<string, (...args: unknown[]) => unknown>();
    registerBridge(
      session,
      {
        events: { send: (channel, payload) => sent.push({ channel, payload }) },
        onExecuteError: (error, plan, result) => {
          errors.push({ error, plan, terminalResult: result });
        },
      },
      (channel, handler) => handlers.set(channel, handler),
    );

    await expect(handlers.get('rune:execute')?.()).rejects.toThrow('RUNE-406');

    expect(errors).toEqual([{ error: failure, plan: expectedPlan, terminalResult }]);
    expect(sent).toHaveLength(1);
    expect(sent[0]?.channel).toBe(EVENT_CHANNEL);
    const event = sent[0]?.payload as BridgeEvent;
    expect(event.kind).toBe('runFinished');
    if (event.kind !== 'runFinished') {
      throw new Error('the terminal event was not runFinished');
    }
    expect(resultWithoutPresentation(event.result)).toEqual(
      JSON.parse(JSON.stringify(terminalResult)),
    );
    expect(event.result.displaySummary).toContain('planned:');
    execute.mockRestore();
  });

  it('does not route a rejected execute completion through the engine failure hook', async () => {
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(completeWrite);
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
    const onExecuteError = vi.fn(() => {
      calls.push('error');
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
    expect(onExecuteError).not.toHaveBeenCalled();
    expect(calls).toEqual(['start', 'end']);
    stderr.mockRestore();
  });

  it('is a 1:1 projection: exactly the pinned channels, nothing else', async () => {
    const session = await Session.open(fixture(), { environment: {}, mode: 'gui' });
    const bridge = await bridgeOver(session);

    expect(bridge.channels.sort()).toEqual([...BRIDGE_CHANNELS].sort());
  });

  it('notifies the host after requesting Session cancellation', async () => {
    const session = await Session.open(fixture(), { environment: {}, mode: 'gui' });
    const calls: string[] = [];
    const cancel = vi.spyOn(Session.prototype, 'cancel').mockImplementation(() => {
      calls.push('cancel');
    });
    const onCancelRequested = vi.fn(() => {
      calls.push('host');
    });
    const handlers = new Map<string, (...args: unknown[]) => unknown>();
    registerBridge(
      session,
      { events: { send: () => undefined }, onCancelRequested },
      (channel, handler) => handlers.set(channel, handler),
    );

    await handlers.get('rune:cancel')?.();

    expect(cancel).toHaveBeenCalledOnce();
    expect(onCancelRequested).toHaveBeenCalledOnce();
    expect(calls).toEqual(['cancel', 'host']);
    cancel.mockRestore();
  });

  it('uses the engine structured projections for successful returns', async () => {
    const manifestPath = fixture();
    const session = await Session.open(manifestPath, {
      environment: {},
      locale: 'C',
      mode: 'gui',
      overrides: { token: 'super-secret-value' },
    });
    const bridge = await bridgeOver(session);

    const opened = (await bridge.call('rune:open')) as {
      product: { name: string };
    };
    const strings = (await bridge.call('rune:getStrings')) as BridgeStrings;
    const theme = (await bridge.call('rune:getThemeConfig')) as {
      windowTitle: string;
      logo: string;
      banner: string;
      theme: string;
    };
    const assetDir = join(dirname(manifestPath), 'theme assets #1');

    expect(opened.product.name).toBe('Example super-secret-value');
    expect(strings.locale).toBeNull();
    expect(strings.entries['product.description']).toBe('Description ***');
    expect(strings.entries['gui.windowTitle']).toBe('Window ***');
    expect(strings.displayProduct).toEqual({
      name: 'Example ***',
      version: '1.0.0',
      welcome: 'Description ***',
    });
    expect(theme.windowTitle).toBe('Window ***');
    expect(theme.logo).toBe(pathToFileURL(join(assetDir, 'logo #1.png')).href);
    expect(theme.banner).toBe(pathToFileURL(join(assetDir, 'banner #1.png')).href);
    expect(theme.theme).toBe(pathToFileURL(join(assetDir, 'custom #1.css')).href);
    expect(theme.logo).toContain('%20');
    expect(theme.logo).toContain('%23');
    expect(JSON.stringify({ strings, theme })).not.toContain('super-secret-value');
  });

  it('projects the selected regional locale when a language overlay serves it', async () => {
    const session = await Session.open(composedDisplayFixture(), {
      environment: {},
      locale: 'de-DE',
      mode: 'gui',
    });
    const bridge = await bridgeOver(session);

    const strings = (await bridge.call('rune:getStrings')) as BridgeStrings;

    expect(strings.locale).toBe('de-DE');
    expect(strings.entries['rune.progress.output']).toBe('Output {line}');
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
    const strings = (await bridge.call('rune:getStrings')) as BridgeStrings;
    const theme = (await bridge.call('rune:getThemeConfig')) as {
      accentColor: string;
      windowTitle: string;
    };
    const plan = (await bridge.call('rune:plan')) as BridgePlan;
    const result = (await bridge.call('rune:describe')) as BridgeResult;
    const step = plan.steps[0];
    if (step?.state !== 'PENDING') {
      throw new Error('the structured projection fixture did not produce a pending step');
    }

    expect(opened.product).toEqual({ name: 'COLLISION_PRODUCT', version: '1.2.3' });
    expect(result.product).toEqual(opened.product);
    expect(theme.accentColor).toBe('#123abc');
    expect(Object.keys(step.command.env)).toEqual(['COLLISION_ENV']);
    expect(strings.entries['product.description']).toBe('Description ***\nsecond\tline');
    expect(strings.entries['gui.windowTitle']).toBe('Window ***\nsecond\tline');
    expect(strings.displayProduct).toEqual({
      name: '***',
      version: '***',
      welcome: 'Description ***\nsecond\tline',
    });
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

  it('refreshes product display masking after a secret answer while preserving identity', async () => {
    const session = await Session.open(fixture(), { environment: {}, mode: 'gui' });
    const bridge = await bridgeOver(session);

    const opened = (await bridge.call('rune:open')) as {
      product: { name: string; version: string };
    };
    const before = (await bridge.call('rune:getStrings')) as BridgeStrings;
    await bridge.call('rune:setValue', 'token', 'super-secret-value');
    const after = (await bridge.call('rune:getStrings')) as BridgeStrings;
    await bridge.call('rune:plan');
    const result = (await bridge.call('rune:describe')) as BridgeResult;

    expect(before.displayProduct).toEqual({
      name: 'Example super-secret-value',
      version: '1.0.0',
      welcome: 'Description super-secret-value',
    });
    expect(after.displayProduct).toEqual({
      name: 'Example ***',
      version: '1.0.0',
      welcome: 'Description ***',
    });
    expect(opened.product).toEqual({ name: 'Example super-secret-value', version: '1.0.0' });
    expect(result.product).toEqual(opened.product);
  });

  it('masks the complete product fallback after composing its exact identity fields', async () => {
    const { manifestPath, productName } = derivedProductFixture();
    const session = await Session.open(manifestPath, { environment: {}, mode: 'gui' });
    const bridge = await bridgeOver(session);

    await bridge.call('rune:setValue', 'workingDirectory', `${productName} 1.0.0`);
    const strings = (await bridge.call('rune:getStrings')) as BridgeStrings;

    expect(strings.displayProduct).toEqual({
      name: productName,
      version: '1.0.0',
      welcome: '***',
    });
  });

  it('refreshes product display masking for a path secret derived by planning', async () => {
    const { manifestPath, productName, relativeSecret } = derivedProductFixture();
    const session = await Session.open(manifestPath, { environment: {}, mode: 'gui' });
    const bridge = await bridgeOver(session);

    const opened = (await bridge.call('rune:open')) as {
      product: { name: string; version: string };
    };
    await bridge.call('rune:setValue', 'workingDirectory', relativeSecret);
    const beforePlan = (await bridge.call('rune:getStrings')) as BridgeStrings;
    await bridge.call('rune:plan');
    const afterPlan = (await bridge.call('rune:getStrings')) as BridgeStrings;
    const result = (await bridge.call('rune:describe')) as BridgeResult;

    expect(beforePlan.displayProduct.name).toBe(productName);
    expect(afterPlan.displayProduct).toEqual({
      name: '***',
      version: '1.0.0',
      welcome: '*** 1.0.0',
    });
    expect(opened.product).toEqual({ name: productName, version: '1.0.0' });
    expect(result.product).toEqual(opened.product);
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
    expect(rejected).not.toHaveProperty('editRejection');
    expect(pending).toEqual([rejected]);
    expect(JSON.parse(JSON.stringify({ all, pending }))).toEqual({ all, pending });
    expect(JSON.stringify({ all, pending })).not.toContain('super-secret-value');
  });

  it('retains the engine rejection cause for patterned text values', async () => {
    const patternHint = 'Use the pattern instead';
    const manifestPath = editRejectionFixture(patternHint);
    const longValue = 'A'.repeat(4097);
    const seeded = await Session.open(manifestPath, {
      environment: {},
      mode: 'gui',
      overrides: { code: longValue },
    });
    const seededBridge = await bridgeOver(seeded);
    const seededInput = (
      (await seededBridge.call('rune:allInputs')) as readonly BridgeInput[]
    ).find((input) => input.id === 'code');

    expect(seededInput?.rejection?.issue.message).toContain(
      'the value is longer than the 4096 bytes a checked value may have',
    );
    expect(seededInput?.rejection?.issue.message).not.toContain(patternHint);

    const live = await Session.open(manifestPath, { environment: {}, mode: 'gui' });
    const liveBridge = await bridgeOver(live);
    await expect(liveBridge.call('rune:setValue', 'code', longValue)).rejects.toThrow('RUNE-202');
    const liveInput = ((await liveBridge.call('rune:allInputs')) as readonly BridgeInput[]).find(
      (input) => input.id === 'code',
    );

    expect(liveInput?.editRejection?.displayText).toContain(
      'the value is longer than the 4096 bytes a checked value may have',
    );
    expect(liveInput?.editRejection?.displayText).not.toContain(patternHint);

    const valuesPath = join(dirname(manifestPath), 'values.yaml');
    writeFileSync(valuesPath, 'code: true\n', 'utf8');
    const native = await Session.open(manifestPath, {
      environment: {},
      mode: 'gui',
      values: [valuesPath],
    });
    const nativeBridge = await bridgeOver(native);
    const nativeInput = (
      (await nativeBridge.call('rune:allInputs')) as readonly BridgeInput[]
    ).find((input) => input.id === 'code');

    expect(nativeInput?.rejection?.issue.message).toContain('true is not text');
    expect(nativeInput?.rejection?.issue.message).not.toContain(patternHint);
  });

  it('remasks a rejected public edit and its engine diagnostic after a secret answer', async () => {
    const session = await Session.open(editRejectionFixture(), {
      environment: {},
      mode: 'gui',
    });
    const bridge = await bridgeOver(session);
    const rawCandidate = 'later-secret-42';

    await expect(bridge.call('rune:setValue', 'code', rawCandidate)).rejects.toThrow('RUNE-202');
    const beforeSecret = (await bridge.call('rune:allInputs')) as readonly BridgeInput[];
    const beforeRejected = beforeSecret.find((input) => input.id === 'code');

    expect(beforeRejected?.editRejection).toEqual({
      candidate: rawCandidate,
      displayText:
        `RUNE-202 (exit 4): code (from the answer): "${rawCandidate}": ` +
        `Use ${rawCandidate}\\nsecond line`,
    });
    expect(withoutEditRejections(beforeSecret)).toEqual(session.allInputs());
    expect(beforeRejected).toMatchObject({ value: 'GOOD', source: 'default' });
    expect(beforeRejected).not.toHaveProperty('rejection');
    expect(await bridge.call('rune:pendingInputs')).toEqual([]);

    await bridge.call('rune:setValue', 'token', rawCandidate);
    const afterSecret = (await bridge.call('rune:allInputs')) as readonly BridgeInput[];
    const afterRejected = afterSecret.find((input) => input.id === 'code');

    expect(afterRejected?.editRejection).toEqual({
      candidate: '***',
      displayText: 'RUNE-202 (exit 4): code (from the answer): "***": Use ***\\nsecond line',
    });
    expect(JSON.stringify(afterSecret)).not.toContain(rawCandidate);
    expect(withoutEditRejections(afterSecret)).toEqual(session.allInputs());

    await bridge.call('rune:setValue', 'code', 'VALID');
    const corrected = (await bridge.call('rune:allInputs')) as readonly BridgeInput[];
    expect(corrected.find((input) => input.id === 'code')).not.toHaveProperty('editRejection');

    await expect(bridge.call('rune:setValue', 'code', 'invalid')).rejects.toThrow('RUNE-202');
    await bridge.call('rune:setValue', 'enableCode', false);
    const disabled = (await bridge.call('rune:allInputs')) as readonly BridgeInput[];
    expect(disabled.find((input) => input.id === 'code')).toMatchObject({
      enabled: false,
      value: '',
    });
    expect(disabled.find((input) => input.id === 'code')).not.toHaveProperty('editRejection');
  });

  it('masks a rejected public edit against an already seeded secret', async () => {
    const rawCandidate = 'later-secret-42';
    const session = await Session.open(editRejectionFixture(), {
      environment: {},
      mode: 'gui',
      overrides: { token: rawCandidate },
    });
    const bridge = await bridgeOver(session);

    await expect(bridge.call('rune:setValue', 'code', rawCandidate)).rejects.toThrow('RUNE-202');
    const inputs = (await bridge.call('rune:allInputs')) as readonly BridgeInput[];

    expect(inputs.find((input) => input.id === 'code')?.editRejection).toEqual({
      candidate: '***',
      displayText: 'RUNE-202 (exit 4): code (from the answer): "***": Use ***\\nsecond line',
    });
    expect(JSON.stringify(inputs)).not.toContain(rawCandidate);
  });

  it('retains explicit empty hint semantics in the engine diagnostic', async () => {
    const session = await Session.open(editRejectionFixture(''), {
      environment: {},
      mode: 'gui',
    });
    const bridge = await bridgeOver(session);

    await expect(bridge.call('rune:setValue', 'code', 'invalid')).rejects.toThrow('RUNE-202');
    const inputs = (await bridge.call('rune:allInputs')) as readonly BridgeInput[];

    expect(inputs.find((input) => input.id === 'code')?.editRejection).toEqual({
      candidate: 'invalid',
      displayText: 'RUNE-202 (exit 4): code (from the answer): "invalid": ',
    });
  });

  it('retains safe candidate-less errors for rejected boolean and secret edits', async () => {
    const session = await Session.open(controllingRejectionFixture(), {
      environment: {},
      mode: 'gui',
    });
    const bridge = await bridgeOver(session);

    await expect(bridge.call('rune:setValue', 'enabled', true)).rejects.toThrow('RUNE-301');
    const booleanRejected = (await bridge.call('rune:allInputs')) as readonly BridgeInput[];
    const enabled = booleanRejected.find((input) => input.id === 'enabled');
    expect(enabled).toMatchObject({ value: false, source: 'default' });
    expect(enabled?.editRejection?.displayText).toContain('RUNE-301 (exit 5)');
    expect(enabled?.editRejection).not.toHaveProperty('candidate');
    expect(withoutEditRejections(booleanRejected)).toEqual(session.allInputs());

    await bridge.call('rune:setValue', 'token', 'MISSING_BOOLEAN');
    const remasked = (await bridge.call('rune:allInputs')) as readonly BridgeInput[];
    const remaskedError = remasked.find((input) => input.id === 'enabled')?.editRejection;
    expect(remaskedError?.displayText).toContain('***');
    expect(remaskedError?.displayText).not.toContain('MISSING_BOOLEAN');

    await bridge.call('rune:setValue', 'enabled', false);
    const booleanCorrected = (await bridge.call('rune:allInputs')) as readonly BridgeInput[];
    expect(booleanCorrected.find((input) => input.id === 'enabled')).not.toHaveProperty(
      'editRejection',
    );

    await expect(bridge.call('rune:setValue', 'token', 'MISSING_SECRET')).rejects.toThrow(
      'RUNE-301',
    );
    const secretRejected = (await bridge.call('rune:allInputs')) as readonly BridgeInput[];
    const token = secretRejected.find((input) => input.id === 'token');
    expect(token).toMatchObject({ value: null, source: 'answer' });
    expect(token?.editRejection?.displayText).toContain('RUNE-301 (exit 5)');
    expect(token?.editRejection?.displayText).toContain('***');
    expect(token?.editRejection).not.toHaveProperty('candidate');
    expect(JSON.stringify(secretRejected)).not.toContain('MISSING_SECRET');
    expect(withoutEditRejections(secretRejected)).toEqual(session.allInputs());

    await bridge.call('rune:setValue', 'token', 'replacement-secret');
    const secretCorrected = (await bridge.call('rune:allInputs')) as readonly BridgeInput[];
    expect(secretCorrected.find((input) => input.id === 'token')).not.toHaveProperty(
      'editRejection',
    );
  });

  it('normalizes facade and unknown rejections without exposing secrets', async () => {
    const session = await Session.open(fixture(), {
      environment: {},
      mode: 'gui',
      overrides: { token: 'super-secret-value' },
    });
    const warnings = vi.spyOn(Session.prototype, 'warnings').mockImplementation(() => {
      throw new Error('generic failure contains super-secret-value');
    });
    const theme = vi
      .spyOn(Session.prototype, 'getThemeConfig')
      .mockImplementation(() => throwValue('non-Error failure contains super-secret-value'));
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
    warnings.mockRestore();
    theme.mockRestore();
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
    const warnings = vi
      .spyOn(Session.prototype, 'warnings')
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
    warnings.mockRestore();
  });

  it('projects Session.plan exactly once as plain masked plan data', async () => {
    const manifestPath = fixture();
    const session = await Session.open(manifestPath, {
      environment: {},
      mode: 'gui',
      overrides: { token: 'super-secret-value', databasePort: '5432' },
    });
    const expected = JSON.parse(JSON.stringify(session.plan())) as unknown;
    const planSpy = vi.spyOn(Session.prototype, 'plan');
    const describeSpy = vi.spyOn(Session.prototype, 'describe');
    const bridge = await bridgeOver(session);

    const inputs = (await bridge.call('rune:allInputs')) as readonly BridgeInput[];
    expect(inputs.find((input) => input.id === 'token')?.value).toBeNull();

    const plan = (await bridge.call('rune:plan')) as BridgePlan;

    expect(planSpy).toHaveBeenCalledTimes(1);
    expect(describeSpy).not.toHaveBeenCalled();
    expect(planWithoutPresentation(plan)).toEqual(expected);
    expect(plan).toMatchObject({
      planSchemaVersion: 1,
      manifestPath,
      manifestSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
      preview: false,
      executionOptions: { failFast: true },
      resolvedInputs: [
        {
          id: 'installDatabase',
          value: false,
          source: 'default',
          secret: false,
          enabled: true,
        },
        {
          id: 'databasePort',
          value: '',
          secret: false,
          enabled: false,
          ignored: 'set',
        },
        {
          id: 'token',
          value: '***',
          source: 'set',
          secret: true,
          enabled: true,
        },
      ],
      steps: [
        {
          id: 'use',
          title: 'use',
          state: 'PENDING',
          command: {
            argv: [
              '***',
              '--token',
              '***',
              'contains whitespace',
              '',
              '"quoted"',
              'back\\slash',
              '***',
            ],
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
    expect(plan.steps[0]).toHaveProperty(
      'displayCommand',
      '["***","--token","***","contains whitespace","","\\"quoted\\"","back\\\\slash","***"]',
    );
    expect(plan.steps[1]).not.toHaveProperty('command');
    expect(JSON.parse(JSON.stringify(plan))).toEqual(plan);
    expect(JSON.stringify(plan)).not.toContain('super-secret-value');
    expect(JSON.stringify(inputs)).not.toContain('super-secret-value');
    expect(JSON.stringify(plan)).toContain('***');
  });

  it('masks complete GUI display composition while preserving every projected machine field', async () => {
    const secrets = {
      runStartedBoundary: 'running 2',
      stepStartedBoundary: 'Step 1',
      outputBoundary: 'Output hello',
      summaryBoundary: 'failed: 0',
      warningBoundary: 'Warning steps',
      commandBoundary: '["hello","world"]',
      titleBoundary: 'LOKAL ERGEBNIS Install CODE 9',
    } as const;
    const session = await Session.open(composedDisplayFixture(), {
      environment: {},
      locale: 'de',
      mode: 'gui',
      overrides: secrets,
    });
    const rawPlan = session.plan();
    const described = session.describe();
    const failedResult = {
      ...described,
      status: 'failed',
      exitCode: 1,
      dryRun: false,
      error: null,
      stepsExecuted: 1,
      stepsFailed: 1,
      stepsNotRun: 1,
      nothingExecuted: false,
      steps: described.steps.map((step, index) =>
        index === 0
          ? { ...step, state: 'FAILED' as const, exitCode: 9, durationMs: 4 }
          : { ...step, state: 'NOT_RUN' as const, exitCode: null, durationMs: 0 },
      ),
    } as RunResult;
    const execute = vi.spyOn(Session.prototype, 'execute').mockImplementation(async (observer) => {
      const events: RunEvent[] = [
        { kind: 'runStarted', plan: rawPlan },
        { kind: 'stepStarted', stepId: 'install', index: 0, total: 2, title: 'Install' },
        { kind: 'stepOutput', stepId: 'install', stream: 'stdout', line: 'hello output' },
        { kind: 'stepFinished', stepId: 'install', state: 'FAILED', exitCode: 9, durationMs: 4 },
        { kind: 'runFinished', result: failedResult },
      ];
      for (const event of events) {
        observer?.(event);
      }
      return failedResult;
    });
    const bridge = await bridgeOver(session);
    const plan = (await bridge.call('rune:plan')) as BridgePlan;
    const warnings = (await bridge.call('rune:warnings')) as readonly {
      message: string;
      displayText: string;
    }[];
    const result = (await bridge.call('rune:execute')) as BridgeResult;

    expect(planWithoutPresentation(plan)).toEqual(JSON.parse(JSON.stringify(rawPlan)));
    const firstPlanStep = plan.steps[0];
    expect(firstPlanStep?.state).toBe('PENDING');
    if (firstPlanStep?.state !== 'PENDING') {
      throw new Error('the composed-display plan did not contain its pending step');
    }
    expect(firstPlanStep.command.argv).toEqual(['hello', 'world']);
    expect(firstPlanStep.displayCommand).toBe('***');
    expect(warnings).toEqual([
      {
        message:
          'steps[1].run.args[1] interpolates secret input "warningBoundary" into argv, ' +
          'which may be visible in OS process listings — use env: instead',
        displayText:
          '***[1].run.args[1] interpolates secret input "warningBoundary" into argv, ' +
          'which may be visible in OS process listings — use env: instead',
      },
    ]);
    expect(resultWithoutPresentation(result)).toEqual(JSON.parse(JSON.stringify(failedResult)));
    expect(result.displaySummary).toMatch(/^\*\*\* succeeded/);
    expect(result.steps[0]).toMatchObject({
      title: 'Install',
      exitCode: 9,
      displayTitle: '***',
    });

    expect(bridge.sent).toHaveLength(5);
    const [runStarted, stepStarted, stepOutput, stepFinished, runFinished] = bridge.sent.map(
      ({ payload }) => payload as BridgeEvent,
    );
    expect(runStarted).toMatchObject({
      kind: 'runStarted',
      displayText: `*** steps on ${rawPlan.platform}`,
    });
    expect(stepStarted).toMatchObject({
      kind: 'stepStarted',
      stepId: 'install',
      index: 0,
      total: 2,
      title: 'Install',
      displayText: '*** of 2: Install',
    });
    expect(stepOutput).toEqual({
      kind: 'stepOutput',
      stepId: 'install',
      stream: 'stdout',
      line: 'hello output',
      displayText: '*** output',
    });
    expect(stepFinished).toMatchObject({
      kind: 'stepFinished',
      stepId: 'install',
      state: 'FAILED',
      exitCode: 9,
      durationMs: 4,
      displayText: '  -> FAILED (exit 9) after 4ms',
    });
    expect(runFinished?.kind).toBe('runFinished');
    if (runStarted?.kind !== 'runStarted' || runFinished?.kind !== 'runFinished') {
      throw new Error('the composed-display run was not bracketed');
    }
    expect(planWithoutPresentation(runStarted.plan)).toEqual(JSON.parse(JSON.stringify(rawPlan)));
    expect(resultWithoutPresentation(runFinished.result)).toEqual(
      JSON.parse(JSON.stringify(failedResult)),
    );
    expect(runFinished.result.displaySummary).toBe(result.displaySummary);
    expect(bridge.sent.every(({ channel }) => channel === EVENT_CHANNEL)).toBe(true);

    const projected = JSON.stringify({ plan, warnings, result, events: bridge.sent });
    for (const secret of Object.values(secrets)) {
      // The command boundary equals exact array syntax in machine fields; its complete
      // human preview is asserted above without changing the underlying argv.
      if (secret !== secrets.commandBoundary) {
        expect(projected).not.toContain(secret);
      }
    }
    execute.mockRestore();
  });

  it('returns the InputStateChanged list as the resolved value of setValue', async () => {
    const session = await Session.open(fixture(), { environment: {}, mode: 'gui' });
    const bridge = await bridgeOver(session);

    const changes = await bridge.call('rune:setValue', 'installDatabase', true);
    expect(changes).toEqual([{ inputId: 'databasePort', enabled: true }]);
  });

  it('pushes every run event through the serializer, pre-masked', async () => {
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(completeWrite);
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
    const expectedPlan = JSON.parse(JSON.stringify(rawPlan)) as unknown;

    const result = (await bridge.call('rune:execute')) as { status: string; mode: string };

    expect(result.status).toBe('succeeded');
    expect(result.mode).toBe('gui');
    expect(bridge.sent.length).toBeGreaterThan(0);
    expect(bridge.sent[0]).toEqual({
      channel: EVENT_CHANNEL,
      payload: {
        kind: 'runStarted',
        plan,
        displayText: `running 2 steps on ${plan.platform}`,
      },
    });
    const started = bridge.sent[0]?.payload as BridgeEvent | undefined;
    if (started?.kind !== 'runStarted') {
      throw new Error('the first event was not runStarted');
    }
    expect(planWithoutPresentation(plan)).toEqual(expectedPlan);
    expect(planWithoutPresentation(started.plan)).toEqual(expectedPlan);
    const use = started.plan.steps[0];
    if (use?.state !== 'PENDING') {
      throw new Error('the first planned step was not pending');
    }
    expect(use.command).toEqual({
      argv: ['***', '--token', '***', 'contains whitespace', '', '"quoted"', 'back\\slash', '***'],
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
    expect(diagnostics).toContain('Step 1 of 2: use\n');
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
