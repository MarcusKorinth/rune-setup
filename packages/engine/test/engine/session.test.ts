import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import { CancelToken } from '../../src/engine/cancel.js';
import { hostPlatform } from '../../src/engine/context.js';
import type { InputState } from '../../src/engine/inputs.js';
import { ExecutionError, InputError, InternalError } from '../../src/errors.js';
import { Session } from '../../src/engine/session.js';
import type { RunEvent } from '../../src/engine/events.js';
import type { Runner, SpawnOutcome, SpawnRequest } from '../../src/runners/base.js';

const okRunner: Runner = { run: async () => ({ kind: 'exited', exitCode: 0 }) };

function fixture(lines: readonly string[], extra: Record<string, string> = {}): string {
  const dir = mkdtempSync(join(tmpdir(), 'rune-session-'));
  writeFileSync(join(dir, 'installer.yaml'), [...lines, ''].join('\n'), 'utf8');
  for (const [name, content] of Object.entries(extra)) {
    const path = join(dir, name);
    mkdirSync(join(path, '..'), { recursive: true });
    writeFileSync(path, content, 'utf8');
  }
  return join(dir, 'installer.yaml');
}

const BASE = [
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
  'steps:',
  '  - id: install',
  '    run:',
  '      command: node',
];

describe('opening a session', () => {
  it('resolves layers 1-4 and reports what is still pending', async () => {
    const path = fixture(BASE);
    const session = await Session.open(path, { environment: {} });

    expect(session.manifest.product.name).toBe('Example');
    expect(session.pendingInputs()).toEqual([]);
    expect(session.allInputs().map((input) => input.id)).toEqual([
      'installDatabase',
      'databasePort',
    ]);
    expect(session.allInputs()[1]?.enabled).toBe(false);
  });

  it('takes --set overrides and values files as layers 4 and 2', async () => {
    const path = fixture(BASE, { 'values.yaml': 'installDatabase: "true"\n' });
    const session = await Session.open(path, {
      values: [join(path, '..', 'values.yaml')],
      environment: {},
    });

    expect(session.allInputs()[0]?.value).toBe(true);
    expect(session.allInputs()[0]?.source).toBe('values');
    expect(session.pendingInputs().map((input) => input.id)).toEqual(['databasePort']);
  });

  it.runIf(process.platform === 'win32')(
    'uses Windows casing semantics for interpolation, inputs, and locale selection',
    async () => {
      const path = fixture(
        [
          'schemaVersion: 1',
          'product:',
          '  name: Example',
          '  version: "1.0.0"',
          'inputs:',
          '  target:',
          '    type: text',
          'steps:',
          '  - id: install',
          '    title: Install',
          '    run:',
          '      command: node',
          '      args: ["${target}", "${env.PATH}"]',
        ],
        { 'locales/de.yaml': 'steps.install.title: Installieren\n' },
      );
      const session = await Session.open(path, {
        environment: {
          Path: 'C:\\tools',
          rUnE_iNpUt_tArGeT: 'from-environment',
          rUnE_lOcAlE: 'de',
        },
        systemLocale: 'en-US',
      });

      expect(session.allInputs()[0]).toMatchObject({
        value: 'from-environment',
        source: 'environment',
      });
      expect(session.getStrings().locale).toBe('de');
      expect(session.plan().steps[0]).toMatchObject({
        title: 'Installieren',
        command: { argv: ['node', 'from-environment', 'C:\\tools'] },
      });
    },
  );

  it.runIf(process.platform !== 'win32')(
    'keeps interpolation, inputs, and locale environment names case-sensitive on Linux',
    async () => {
      const path = fixture(
        [
          'schemaVersion: 1',
          'product:',
          '  name: Example',
          '  version: "1.0.0"',
          'inputs:',
          '  target:',
          '    type: text',
          '    required: false',
          'steps:',
          '  - id: install',
          '    title: Install',
          '    run:',
          '      command: node',
          '      args: ["${target}", "${env.PATH}"]',
        ],
        { 'locales/de.yaml': 'steps.install.title: Installieren\n' },
      );
      const session = await Session.open(path, {
        environment: {
          Path: '/tools',
          rUnE_iNpUt_tArGeT: 'from-environment',
          rUnE_lOcAlE: 'de',
        },
        systemLocale: 'en-US',
      });

      expect(session.allInputs()[0]).toMatchObject({ value: '', source: undefined });
      expect(session.getStrings().locale).toBe('en-US');
      expect(session.getStrings().stepTitle('install')).toBe('Install');
      expect(() => session.plan()).toThrow(/environment variable PATH is not set/);
    },
  );
});

describe('answering inputs', () => {
  it('flips dependent inputs live and reports the change', async () => {
    const session = await Session.open(fixture(BASE), { environment: {} });

    const changes = session.setValue('installDatabase', true);

    expect(changes).toEqual([{ inputId: 'databasePort', enabled: true }]);
    expect(session.pendingInputs().map((input) => input.id)).toEqual(['databasePort']);
  });

  it('rejects a bad value without changing anything', async () => {
    const session = await Session.open(fixture(BASE), { environment: {} });

    expect(() => session.setValue('installDatabase', 'not-a-boolean')).toThrow(/installDatabase/);
    expect(session.allInputs()[0]?.value).toBe(false);
    expect(() => session.setValue('nope', 'x')).toThrow(/names no input/);
  });

  it('keeps an accepted answer through a later rejected edit', async () => {
    const session = await Session.open(fixture(BASE), { environment: {} });
    session.setValue('installDatabase', true);
    session.setValue('databasePort', '5432');

    expect(() => session.setValue('installDatabase', 'garbage')).toThrow(/installDatabase/);
    session.setValue('installDatabase', true);

    expect(session.allInputs().find((input) => input.id === 'databasePort')?.value).toBe('5432');
    expect(session.pendingInputs()).toEqual([]);
  });

  it('rolls back secret registration when a later input rejects an edit', async () => {
    const marker = 'candidate-secret-marker';
    const session = await Session.open(
      fixture([
        'schemaVersion: 1',
        'product:',
        '  name: Example',
        '  version: "1.0.0"',
        'inputs:',
        '  enabled:',
        '    type: boolean',
        '    default: false',
        '  token:',
        '    type: secret',
        '    when: "${enabled}"',
        '  choice:',
        '    type: select',
        '    options: [accepted]',
        '    when: "${enabled}"',
        'steps:',
        '  - id: install',
        '    run:',
        '      command: node',
        `      args: ["${marker}"]`,
      ]),
      { environment: {}, overrides: { choice: marker } },
    );
    session.setValue('token', marker);
    const inputs = session.allInputs();
    const plan = session.plan();

    let rejection: unknown;
    try {
      session.setValue('enabled', true);
    } catch (error) {
      rejection = error;
    }

    expect(rejection).toBeInstanceOf(InputError);
    expect(rejection).toMatchObject({ message: expect.not.stringContaining(marker) });
    expect((rejection as InputError).message).toContain('***');
    expect(JSON.stringify((rejection as InputError).issues)).not.toContain(marker);
    expect(session.allInputs()).toBe(inputs);
    expect(session.allInputs().find((input) => input.id === 'enabled')).toMatchObject({
      value: false,
      source: 'default',
    });
    expect(session.plan()).toBe(plan);
    expect(session.plan().steps[0]).toMatchObject({
      command: { argv: ['node', marker] },
    });
  });

  it('rejects an undefined answer without falling back to a default', async () => {
    const session = await Session.open(fixture(BASE), { environment: {} });
    session.setValue('installDatabase', true);

    expect(() => session.setValue('installDatabase', undefined)).toThrow(InputError);
    expect(session.allInputs()[0]).toMatchObject({ value: true, source: 'answer' });
  });
});

describe('planning and executing', () => {
  it('uses the exact manifest bytes and mode in dry-run and live results', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'rune-session-identity-'));
    const path = join(dir, 'installer.yaml');
    const bytes = Buffer.from(
      [
        'schemaVersion: 1',
        'product:',
        '  name: Example',
        '  version: "1.0.0"',
        'steps: []',
        '# whitespace and comments are part of the file identity',
        '',
      ].join('\r\n'),
      'utf8',
    );
    writeFileSync(path, bytes);
    const expectedSha256 = createHash('sha256').update(bytes).digest('hex');
    const session = await Session.open(path, { environment: {}, runner: okRunner });
    const plan = session.plan();

    const expectedIdentity = {
      mode: 'non-interactive',
      manifest: { path, sha256: expectedSha256, schemaVersion: 1 },
    };
    expect(plan).toMatchObject({
      executionPlanVersion: 1,
      manifestPath: path,
      manifestSha256: expectedSha256,
      manifestSchemaVersion: 1,
    });
    expect(session.plan()).toBe(plan);
    expect(session.describe()).toMatchObject(expectedIdentity);
    await expect(session.execute()).resolves.toMatchObject(expectedIdentity);
  });

  it('plans the effective log path after manifest anchoring and flag precedence', async () => {
    const path = fixture([...BASE, 'execution:', '  logFile: logs/manifest.log']);
    const manifestLog = await Session.open(path, { environment: {} });
    expect(manifestLog.plan().executionOptions.logFile).toBe(
      join(path, '..', 'logs', 'manifest.log'),
    );

    const flagPath = join(path, '..', 'logs', 'flag.log');
    const flagLog = await Session.open(path, { environment: {}, logFile: flagPath });
    expect(flagLog.plan().executionOptions.logFile).toBe(flagPath);
  });

  it('preserves an explicit frontend mode in dry-run and live results', async () => {
    const session = await Session.open(fixture(BASE), {
      mode: 'gui',
      environment: {},
      runner: okRunner,
    });

    expect(session.describe().mode).toBe('gui');
    await expect(session.execute()).resolves.toMatchObject({ mode: 'gui' });
  });

  it('refuses to plan while required inputs are missing, listing each one', async () => {
    const session = await Session.open(fixture(BASE), { environment: {} });
    session.setValue('installDatabase', true);

    expect(() => session.plan()).toThrow(/databasePort.*--set databasePort=/s);
  });

  it('executes through the facade and writes the log file', async () => {
    const path = fixture(BASE);
    const logFile = join(path, '..', 'logs', 'run.log');
    const session = await Session.open(path, {
      environment: {},
      logFile,
      runner: okRunner,
    });
    const events: RunEvent[] = [];

    const result = await session.execute((event) => events.push(event));

    expect(result.status).toBe('succeeded');
    expect(result.steps[0]?.state).toBe('SUCCEEDED');
    expect(events[0]?.kind).toBe('runStarted');
    expect(events.at(-1)?.kind).toBe('runFinished');
    const terminal = events.filter((event) => event.kind === 'runFinished');
    expect(terminal).toHaveLength(1);
    expect(terminal[0]?.kind === 'runFinished' && terminal[0].result).toBe(result);
    const log = readFileSync(logFile, 'utf8');
    expect(log).toContain('[install] SUCCEEDED');
    expect(log).toContain('run finished: succeeded (exit 0)');
  });

  it('publishes a runner contract failure only after finalization, then rejects', async () => {
    const path = fixture(BASE);
    const logFile = join(path, '..', 'logs', 'run.log');
    const session = await Session.open(path, {
      environment: {},
      logFile,
      runner: { run: async () => ({ kind: 'exited', exitCode: Number.NaN }) },
    });
    const events: RunEvent[] = [];
    let terminalSawFinalizedLog = false;

    await expect(
      session.execute((event) => {
        events.push(event);
        if (event.kind === 'runFinished') {
          terminalSawFinalizedLog = readFileSync(logFile, 'utf8').includes(
            'run finished: internal_error (exit 70)',
          );
        }
      }),
    ).rejects.toMatchObject({ code: 'RUNE-500', name: InternalError.name });

    expect(events.map((event) => event.kind)).toEqual([
      'runStarted',
      'stepStarted',
      'stepFinished',
      'runFinished',
    ]);
    expect(events.filter((event) => event.kind === 'runFinished')).toHaveLength(1);
    const terminal = events.at(-1);
    expect(terminal?.kind === 'runFinished' && terminal.result).toMatchObject({
      status: 'internal_error',
      exitCode: 70,
      stepsFailed: 1,
    });
    expect(terminalSawFinalizedLog).toBe(true);
    expect(readFileSync(logFile, 'utf8')).toContain('run finished: internal_error (exit 70)');
  });

  it('uses one safe plan projection while the runner receives the canonical clear values', async () => {
    const marker = 'shared-secret-marker';
    const mirror = `prefix-${marker}-suffix`;
    const literal = `literal-${marker}`;
    const path = fixture([
      'schemaVersion: 1',
      'product:',
      '  name: Example',
      '  version: "1.0.0"',
      'inputs:',
      '  token:',
      '    type: secret',
      '  mirror:',
      '    type: text',
      'steps:',
      '  - id: use',
      '    title: Use token',
      '    run:',
      '      command: node',
      `      args: ["\${mirror}", "${literal}"]`,
      '      env:',
      '        MIRROR: "${mirror}"',
    ]);
    const spawnedArgv: unknown[] = [];
    const spawnedEnv: unknown[] = [];
    const runner: Runner = {
      run: async (request) => {
        spawnedArgv.push(...request.command.argv);
        spawnedEnv.push(request.command.env['MIRROR']);
        request.onOutput('stdout', `child echoed ${mirror}`);
        return { kind: 'exited', exitCode: 0 };
      },
    };
    const session = await Session.open(path, {
      environment: {},
      overrides: { token: marker, mirror },
      runner,
    });

    const safePlan = session.plan();
    const planned = session.describe();
    const events: RunEvent[] = [];
    const live = await session.execute((event) => events.push(event));

    expect(JSON.stringify({ safePlan, planned, live, events })).not.toContain(marker);
    expect(safePlan.resolvedInputs.find((input) => input.id === 'mirror')?.value).toBe(
      'prefix-***-suffix',
    );
    expect(events[0]).toMatchObject({ kind: 'runStarted' });
    expect(events[0]?.kind === 'runStarted' && events[0].plan).toBe(safePlan);
    expect(spawnedArgv).toEqual(['node', mirror, literal]);
    expect(spawnedEnv).toEqual([mirror]);
  });

  it('does not start a runner until the log is open and releases a failed execution', async () => {
    const path = fixture(BASE);
    const logFile = join(path, '..', 'blocked.log');
    mkdirSync(logFile);
    const run = vi.fn(async () => ({ kind: 'exited' as const, exitCode: 0 }));
    const session = await Session.open(path, { environment: {}, logFile, runner: { run } });

    await expect(session.execute()).rejects.toMatchObject({
      code: 'RUNE-406',
      name: ExecutionError.name,
      cause: expect.any(Error),
    });
    expect(run).not.toHaveBeenCalled();
    expect(session.setValue('installDatabase', false)).toEqual([]);

    rmdirSync(logFile);
    await expect(session.execute()).resolves.toMatchObject({ status: 'succeeded' });
    expect(run).toHaveBeenCalledOnce();
  });

  it('rejects overlapping executions and keeps cancellation bound to the active run', async () => {
    const cancel = new CancelToken();
    let runnerCalls = 0;
    let runnerStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      runnerStarted = resolve;
    });
    const run = vi.fn(async (request: SpawnRequest): Promise<SpawnOutcome> => {
      runnerCalls += 1;
      if (runnerCalls > 1) {
        return { kind: 'exited', exitCode: 0 };
      }
      expect(request.cancel).toBe(cancel);
      runnerStarted();
      return await new Promise<SpawnOutcome>((resolve) => {
        request.cancel.onCancel(() => resolve({ kind: 'cancelled' }));
      });
    });
    const session = await Session.open(fixture(BASE), {
      environment: {},
      runner: { run },
    });

    const active = session.execute(undefined, cancel);
    await started;

    const overlappingObserver = vi.fn();
    await expect(session.execute(overlappingObserver)).rejects.toMatchObject({
      code: 'RUNE-500',
      name: InternalError.name,
    });
    expect(run).toHaveBeenCalledOnce();
    expect(overlappingObserver).not.toHaveBeenCalled();

    session.cancel();
    expect(cancel.cancelled).toBe(true);
    await expect(active).resolves.toMatchObject({ status: 'cancelled', stepsCancelled: 1 });

    await expect(session.execute()).resolves.toMatchObject({ status: 'succeeded' });
    expect(run).toHaveBeenCalledTimes(2);
  });

  it('rejects value changes while execution is active without changing its plan or inputs', async () => {
    let runnerStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      runnerStarted = resolve;
    });
    let releaseRunner!: () => void;
    const runnerFinished = new Promise<SpawnOutcome>((resolve) => {
      releaseRunner = () => resolve({ kind: 'exited', exitCode: 0 });
    });
    const requests: SpawnRequest[] = [];
    const session = await Session.open(
      fixture([
        'schemaVersion: 1',
        'product:',
        '  name: Example',
        '  version: "1.0.0"',
        'inputs:',
        '  target:',
        '    type: text',
        '    default: before',
        'steps:',
        '  - id: install',
        '    run:',
        '      command: node',
        '      args: ["${target}"]',
      ]),
      {
        environment: {},
        runner: {
          run: async (request) => {
            requests.push(request);
            runnerStarted();
            return await runnerFinished;
          },
        },
      },
    );
    const inputs = session.allInputs();
    const warnings = session.warnings();
    const plan = session.plan();

    const active = session.execute();
    await started;

    let rejection: unknown;
    try {
      session.setValue('target', 'after');
    } catch (error) {
      rejection = error;
    }
    expect(rejection).toMatchObject({
      code: 'RUNE-500',
      name: InternalError.name,
    });
    expect(session.allInputs()).toBe(inputs);
    expect(session.warnings()).toBe(warnings);
    expect(session.plan()).toBe(plan);
    expect(requests[0]?.command.argv).toEqual(['node', 'before']);

    releaseRunner();
    await expect(active).resolves.toMatchObject({ status: 'succeeded' });

    expect(session.setValue('target', 'after')).toEqual([]);
    const updatedPlan = session.plan();
    expect(updatedPlan).not.toBe(plan);
    const updatedStep = updatedPlan.steps[0];
    expect(updatedStep?.state, 'the updated plan must retain the pending step').toBe('PENDING');
    if (updatedStep?.state !== 'PENDING') {
      throw new Error('the updated plan must retain the pending step');
    }
    expect(updatedStep.command.argv).toEqual(['node', 'after']);
  });

  it('describes a dry run without executing', async () => {
    const session = await Session.open(fixture(BASE), { environment: {} });

    const result = session.describe();

    expect(result.status).toBe('planned');
    expect(result.dryRun).toBe(true);
    expect(result.steps[0]?.state).toBe('PENDING');
  });
});

describe('strings and theme', () => {
  it('serves the overlay of the selected locale', async () => {
    const path = fixture(BASE, {
      'locales/de.yaml': 'steps.install.title: Installieren\nrune.button.next: Weiter\n',
    });
    const session = await Session.open(path, { locale: 'de-DE', environment: {} });

    const strings = session.getStrings();
    expect(strings.locale).toBe('de-DE');
    expect(strings.stepTitle('install')).toBe('Installieren');
    expect(strings.chrome('rune.button.next')).toBe('Weiter');
    expect(session.describe().steps[0]?.title).toBe('Installieren');
  });

  it('ignores malformed locale claims unrelated to the selected fallback', async () => {
    const path = fixture(BASE, {
      'locales/de.yaml': 'steps.install.title: Installieren\n',
      'locales/de--DE.yaml': 'steps.install.title: Ungueltig\n',
    });

    const session = await Session.open(path, { locale: 'de-DE', environment: {} });

    expect(session.getStrings().stepTitle('install')).toBe('Installieren');
  });

  it('hands back the gui block with absolute paths, or nothing', async () => {
    const plain = await Session.open(fixture(BASE), { environment: {} });
    expect(plain.getThemeConfig()).toEqual({});

    const themed = await Session.open(
      fixture([...BASE, 'gui:', '  accentColor: "#3355ff"', '  logo: assets/logo.png'], {
        'assets/logo.png': 'not-a-real-png',
      }),
      { environment: {} },
    );
    const theme = themed.getThemeConfig();
    expect(theme.accentColor).toBe('#3355ff');
    expect(theme.logo).toMatch(/^([A-Za-z]:)?[\\/].*assets[\\/]logo\.png$/);
  });
});

describe('facade immutability', () => {
  it('snapshots process.env before later process mutations', async () => {
    const variable = `RUNE_F016_SNAPSHOT_${process.pid}`;
    const previous = process.env[variable];
    const path = fixture([
      'schemaVersion: 1',
      'product:',
      '  name: Example',
      '  version: "1.0.0"',
      'steps:',
      '  - id: install',
      '    run:',
      '      command: node',
      `      args: ["\${env.${variable}}"]`,
    ]);

    try {
      process.env[variable] = 'before';
      const session = await Session.open(path);
      process.env[variable] = 'after';

      expect(session.plan().steps[0]).toMatchObject({
        command: { argv: ['node', 'before'] },
      });
    } finally {
      if (previous === undefined) {
        delete process.env[variable];
      } else {
        process.env[variable] = previous;
      }
    }
  });

  it('keeps manifest, input, warning, change, and string projections outside engine authority', async () => {
    const path = fixture([
      'schemaVersion: 1',
      'product:',
      '  name: Example',
      '  version: "1.0.0"',
      'inputs:',
      '  choice:',
      '    type: multiselect',
      '    options:',
      '      - value: vanilla',
      '        label: Vanilla',
      '      - value: chocolate',
      '        label: Chocolate',
      '  enableExtra:',
      '    type: boolean',
      '    default: false',
      '  extra:',
      '    type: text',
      '    when: "${enableExtra}"',
      'steps:',
      '  - id: install',
      '    title: Trusted step',
      '    run:',
      '      command: node',
      '      args: ["${choice}", "${extra}", "${env.TRUSTED_ENV}"]',
    ]);
    const environment = { TRUSTED_ENV: 'trusted' };
    const session = await Session.open(path, {
      environment,
      overrides: { extra: 'trusted' },
    });
    environment.TRUSTED_ENV = 'corrupted';

    const mutableManifest = session.manifest as unknown as {
      inputs: { choice: { options: Array<{ value: string; label: string }> } };
      steps: Array<{ title: string; run: { args: string[] } }>;
    };
    expect(() => {
      (session as unknown as { manifest: object }).manifest = {};
    }).toThrow(TypeError);
    expect(() => {
      mutableManifest.steps[0]!.title = 'Corrupted step';
    }).toThrow(TypeError);
    expect(() => mutableManifest.steps[0]!.run.args.push('corrupted')).toThrow(TypeError);

    const pending = session.pendingInputs();
    expect(pending.map((state) => state.id)).toEqual(['choice']);
    expect(() => (pending as InputState[]).pop()).toThrow(TypeError);
    expect(() => {
      const spec = pending[0]!.spec as unknown as {
        options: Array<{ value: string; label: string }>;
      };
      spec.options[0]!.value = 'corrupted';
    }).toThrow(TypeError);

    const warnings = session.warnings();
    expect(warnings).toHaveLength(1);
    expect(() => (warnings as string[]).push('corrupted')).toThrow(TypeError);

    const answer = ['vanilla'];
    session.setValue('choice', answer);
    answer[0] = 'chocolate';

    const all = session.allInputs();
    const choice = all.find((state) => state.id === 'choice');
    expect(() => (all as InputState[]).pop()).toThrow(TypeError);
    expect(() => (choice!.value as string[]).push('chocolate')).toThrow(TypeError);

    const changes = session.setValue('enableExtra', true);
    expect(changes).toEqual([{ inputId: 'extra', enabled: true }]);
    expect(() => {
      (changes as Array<{ inputId: string; enabled: boolean }>)[0]!.inputId = 'choice';
    }).toThrow(TypeError);
    expect(() =>
      (changes as Array<{ inputId: string; enabled: boolean }>).push({
        inputId: 'choice',
        enabled: false,
      }),
    ).toThrow(TypeError);

    const strings = session.getStrings();
    expect(() => {
      (strings.entries as Record<string, string>)['steps.install.title'] = 'Corrupted title';
    }).toThrow(TypeError);

    expect(session.plan().steps[0]).toMatchObject({
      title: 'Trusted step',
      command: { argv: ['node', 'vanilla', 'trusted', 'trusted'] },
    });
    expect(session.getStrings().stepTitle('install')).toBe('Trusted step');
    expect(session.getStrings().optionLabel('choice', 'vanilla')).toBe('Vanilla');
  });
});

describe('platform previews', () => {
  it('describes a foreign platform but refuses to execute it', async () => {
    const foreign = hostPlatform() === 'windows' ? 'linux' : 'windows';
    const session = await Session.open(fixture(BASE), { environment: {}, platform: foreign });

    expect(session.describe().crossPlatformPreview).toBe(true);
    await expect(session.execute()).rejects.toThrow(/preview plan/);
  });
});
