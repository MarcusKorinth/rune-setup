import type * as fs from 'node:fs';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

const synchronousFsCalls = vi.hoisted(() => [] as string[]);

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

import { Session } from '../../src/engine/session.js';

describe('asynchronous Session I/O', () => {
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
});
