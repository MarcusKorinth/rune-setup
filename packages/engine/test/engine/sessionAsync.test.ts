import type * as fs from 'node:fs';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

const synchronousFsCalls = vi.hoisted(() => [] as string[]);

function restoreEnvironmentVariable(name: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[name];
  } else {
    process.env[name] = value;
  }
}

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof fs>();
  const forbidden =
    (name: string) =>
    (..._args: unknown[]): never => {
      synchronousFsCalls.push(name);
      throw new Error(`Session lifecycle called synchronous filesystem API ${name}`);
    };
  return {
    ...actual,
    lstatSync: forbidden('lstatSync'),
    mkdirSync: forbidden('mkdirSync'),
    readFileSync: forbidden('readFileSync'),
    readdirSync: forbidden('readdirSync'),
    statSync: forbidden('statSync'),
  };
});

import { hostPlatform } from '../../src/engine/context.js';
import { Session, type SessionOptions } from '../../src/engine/session.js';

describe.sequential('asynchronous Session I/O', () => {
  it('opens and executes without synchronous filesystem calls in the lifecycle', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'rune-session-async-'));
    const locales = join(directory, 'locales');
    const assets = join(directory, 'assets');
    const manifestPath = join(directory, 'installer.yaml');
    const valuesPath = join(directory, 'values.yaml');
    const logPath = join(directory, 'nested', 'logs', 'run.log');
    await mkdir(locales);
    await mkdir(assets);
    await writeFile(join(assets, 'logo.png'), '', 'utf8');
    await writeFile(join(locales, 'de.yaml'), 'rune.button.next: Weiter\n', 'utf8');
    await writeFile(valuesPath, 'enabled: true\n', 'utf8');
    await writeFile(
      manifestPath,
      [
        'schemaVersion: 1',
        'product:',
        '  name: Example',
        '  version: "1.0.0"',
        'inputs:',
        '  enabled:',
        '    type: boolean',
        'gui:',
        '  logo: assets/logo.png',
        'steps: []',
        '',
      ].join('\n'),
      'utf8',
    );

    const session = await Session.open(manifestPath, {
      mode: 'gui',
      locale: 'de-DE',
      environment: {},
      values: [valuesPath],
      logFile: logPath,
    });
    const result = await session.execute();

    expect(session.allInputs()[0]?.value).toBe(true);
    expect(session.getStrings().chrome('rune.button.next')).toBe('Weiter');
    expect(result.status).toBe('succeeded');
    expect(await readFile(logPath, 'utf8')).toContain('run finished: succeeded');
    expect(synchronousFsCalls).toEqual([]);
  });

  it('snapshots mutable opening options before the first asynchronous boundary', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'rune-session-snapshot-'));
    const locales = join(directory, 'locales');
    const manifestPath = join(directory, 'installer.yaml');
    const valuesPath = join(directory, 'values.yaml');
    const laterValuesPath = join(directory, 'later-values.yaml');
    const invocationLog = join(directory, 'invocation.log');
    const laterLog = join(directory, 'later.log');
    await mkdir(locales);
    await writeFile(join(locales, 'de.yaml'), 'rune.button.next: Weiter\n', 'utf8');
    await writeFile(join(locales, 'fr.yaml'), 'rune.button.next: Suivant\n', 'utf8');
    await writeFile(valuesPath, 'valuesInput: values-at-call\n', 'utf8');
    await writeFile(laterValuesPath, 'valuesInput: later-values\n', 'utf8');
    await writeFile(
      manifestPath,
      [
        'schemaVersion: 1',
        'product:',
        '  name: Example',
        '  version: "1.0.0"',
        'inputs:',
        '  valuesInput:',
        '    type: text',
        '  environmentInput:',
        '    type: text',
        '  overrideInput:',
        '    type: text',
        'steps: []',
        '',
      ].join('\n'),
      'utf8',
    );

    const environment: Record<string, string | undefined> = {
      RUNE_INPUT_ENVIRONMENTINPUT: 'environment-at-call',
    };
    const values = [valuesPath];
    const overrides: Record<string, string> = { overrideInput: 'override-at-call' };
    const invocationPlatform = hostPlatform();
    const laterPlatform = invocationPlatform === 'windows' ? 'linux' : 'windows';
    const options: {
      mode: NonNullable<SessionOptions['mode']>;
      values: string[];
      overrides: Record<string, string>;
      locale: string | undefined;
      platform: NonNullable<SessionOptions['platform']>;
      logFile: string;
      environment: Record<string, string | undefined>;
      systemLocale: string;
    } = {
      mode: 'interactive',
      values,
      overrides,
      locale: undefined,
      platform: invocationPlatform,
      logFile: invocationLog,
      environment,
      systemLocale: 'de-DE',
    };

    const opening = Session.open(manifestPath, options);
    environment.RUNE_INPUT_ENVIRONMENTINPUT = 'mutated-environment';
    options.environment = { RUNE_INPUT_ENVIRONMENTINPUT: 'replacement-environment' };
    values[0] = laterValuesPath;
    values.push(join(directory, 'missing-later-values.yaml'));
    overrides.overrideInput = 'mutated-override';
    overrides.notAnInput = 'rejected-later-override';
    options.mode = 'gui';
    options.locale = 'fr-FR';
    options.platform = laterPlatform;
    options.logFile = laterLog;
    options.systemLocale = 'fr-FR';

    const session = await opening;

    expect(session.mode).toBe('interactive');
    expect(session.platform).toBe(invocationPlatform);
    expect(session.preview).toBe(false);
    expect(session.getStrings()).toMatchObject({ locale: 'de-DE', overlayLocale: 'de' });
    expect(session.getStrings().chrome('rune.button.next')).toBe('Weiter');
    expect(session.allInputs()).toMatchObject([
      { id: 'valuesInput', value: 'values-at-call', source: 'values' },
      { id: 'environmentInput', value: 'environment-at-call', source: 'environment' },
      { id: 'overrideInput', value: 'override-at-call', source: 'set' },
    ]);
    expect(session.plan().executionOptions.logFile).toBe(invocationLog);
  });

  it('snapshots host built-ins before the first asynchronous boundary', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'rune-session-host-snapshot-'));
    const manifestPath = join(directory, 'installer.yaml');
    await writeFile(
      manifestPath,
      [
        'schemaVersion: 1',
        'product:',
        '  name: Example',
        '  version: "1.0.0"',
        'inputs:',
        '  homeAtCall:',
        '    type: text',
        '    default: "${home}"',
        '  tempAtCall:',
        '    type: text',
        '    default: "${temp}"',
        'steps: []',
        '',
      ].join('\n'),
      'utf8',
    );

    const homeName = process.platform === 'win32' ? 'USERPROFILE' : 'HOME';
    const tempName = process.platform === 'win32' ? 'TEMP' : 'TMPDIR';
    const originalHomeEnvironment = process.env[homeName];
    const originalTempEnvironment = process.env[tempName];
    const expectedHome = homedir();
    const expectedTemp = tmpdir();
    const laterHome = join(directory, 'later-home');
    const laterTemp = join(directory, 'later-temp');

    try {
      const opening = Session.open(manifestPath, { environment: {} });
      process.env[homeName] = laterHome;
      process.env[tempName] = laterTemp;
      expect(homedir()).toBe(laterHome);
      expect(tmpdir()).toBe(laterTemp);

      const session = await opening;

      expect(session.allInputs()).toMatchObject([
        { id: 'homeAtCall', value: expectedHome, source: 'default' },
        { id: 'tempAtCall', value: expectedTemp, source: 'default' },
      ]);
    } finally {
      restoreEnvironmentVariable(homeName, originalHomeEnvironment);
      restoreEnvironmentVariable(tempName, originalTempEnvironment);
    }
  });

  it('anchors relative values and flag log paths to the invocation cwd', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'rune-session-cwd-snapshot-'));
    const invocationDirectory = join(directory, 'invocation');
    const laterDirectory = join(directory, 'later');
    const manifestPath = join(invocationDirectory, 'installer.yaml');
    const previousCwd = process.cwd();
    await mkdir(invocationDirectory);
    await mkdir(laterDirectory);
    await writeFile(join(invocationDirectory, 'values.yaml'), 'target: invocation\n', 'utf8');
    await writeFile(join(laterDirectory, 'values.yaml'), 'target: later\n', 'utf8');
    await writeFile(
      manifestPath,
      [
        'schemaVersion: 1',
        'product:',
        '  name: Example',
        '  version: "1.0.0"',
        'inputs:',
        '  target:',
        '    type: text',
        'steps: []',
        '',
      ].join('\n'),
      'utf8',
    );

    try {
      process.chdir(invocationDirectory);
      const opening = Session.open(manifestPath, {
        values: ['values.yaml'],
        logFile: join('logs', 'run.log'),
        environment: {},
      });
      process.chdir(laterDirectory);

      const session = await opening;

      expect(session.allInputs()[0]).toMatchObject({ value: 'invocation', source: 'values' });
      expect(session.plan().executionOptions.logFile).toBe(
        join(invocationDirectory, 'logs', 'run.log'),
      );
    } finally {
      process.chdir(previousCwd);
    }
  });

  it('preserves the caller spelling of a snapshotted values-file error', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'rune-session-values-display-'));
    const invocationDirectory = join(directory, 'invocation');
    const laterDirectory = join(directory, 'later');
    const manifestPath = join(invocationDirectory, 'installer.yaml');
    const previousCwd = process.cwd();
    await mkdir(invocationDirectory);
    await mkdir(laterDirectory);
    await writeFile(join(invocationDirectory, 'values.yaml'), '- invalid\n', 'utf8');
    await writeFile(join(laterDirectory, 'values.yaml'), 'target: later\n', 'utf8');
    await writeFile(
      manifestPath,
      [
        'schemaVersion: 1',
        'product:',
        '  name: Example',
        '  version: "1.0.0"',
        'inputs:',
        '  target:',
        '    type: text',
        'steps: []',
        '',
      ].join('\n'),
      'utf8',
    );

    try {
      process.chdir(invocationDirectory);
      const opening = Session.open(manifestPath, {
        values: ['values.yaml'],
        environment: {},
      });
      process.chdir(laterDirectory);

      await expect(opening).rejects.toMatchObject({
        issues: [
          expect.objectContaining({
            message: expect.stringContaining('must contain a mapping'),
            location: expect.objectContaining({ file: 'values.yaml' }),
          }),
        ],
      });
    } finally {
      process.chdir(previousCwd);
    }
  });
});
