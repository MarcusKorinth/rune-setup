import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import { CancelToken } from '../../src/engine/cancel.js';
import { hostPlatform } from '../../src/engine/context.js';
import type { InputState } from '../../src/engine/inputs.js';
import { InputError, InternalError } from '../../src/errors.js';
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

    const expectedIdentity = {
      mode: 'non-interactive',
      manifest: { path, sha256: expectedSha256, schemaVersion: 1 },
    };
    expect(session.describe()).toMatchObject(expectedIdentity);
    await expect(session.execute()).resolves.toMatchObject(expectedIdentity);
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
    const log = readFileSync(logFile, 'utf8');
    expect(log).toContain('[install] SUCCEEDED');
    expect(log).toContain('run finished: succeeded (exit 0)');
  });

  it('does not start a runner until the log is open and releases a failed execution', async () => {
    const path = fixture(BASE);
    const logFile = join(path, '..', 'blocked.log');
    mkdirSync(logFile);
    const run = vi.fn(async () => ({ kind: 'exited' as const, exitCode: 0 }));
    const session = await Session.open(path, { environment: {}, logFile, runner: { run } });

    await expect(session.execute()).rejects.toMatchObject({
      code: 'RUNE-500',
      name: InternalError.name,
    });
    expect(run).not.toHaveBeenCalled();

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
    expect(() =>
      (strings.entries as Map<string, string>).set('steps.install.title', 'Corrupted title'),
    ).toThrow(TypeError);

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
