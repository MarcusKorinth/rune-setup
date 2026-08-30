import { describe, expect, it } from 'vitest';

import { UsageError, exitCodeFor } from '@rune/engine';

import { parseShellArgv } from '../src/main/argv.js';

describe('parseShellArgv', () => {
  it('parses a valid shell invocation', () => {
    expect(
      parseShellArgv([
        'installer.yaml',
        '--values',
        'base.yaml',
        '--set',
        'port=8080',
        '--locale',
        'de-DE',
        '--result',
        'result.json',
        '--log-file',
        'run.log',
        '--non-interactive',
      ]),
    ).toEqual({
      manifestPath: 'installer.yaml',
      values: ['base.yaml'],
      overrides: { port: '8080' },
      locale: 'de-DE',
      result: 'result.json',
      logFile: 'run.log',
      nonInteractive: true,
    });
  });

  it.each([
    [['--unknown'], 'unknown flag --unknown'],
    [['--set'], '--set expects a value'],
    [['--values'], '--values expects a value'],
    [['--locale'], '--locale expects a value'],
    [['--result'], '--result expects a value'],
    [['--log-file'], '--log-file expects a value'],
    [['--set', 'port'], '--set expects key=value, got "port"'],
    [[], 'the shell needs a manifest path'],
  ] as const)('reports %s as a RUNE usage error', (argv, message) => {
    try {
      parseShellArgv(argv);
      throw new Error('expected parsing to fail');
    } catch (error) {
      expect(error).toBeInstanceOf(UsageError);
      expect(error).toMatchObject({ code: 'RUNE-001', message });
      expect(exitCodeFor(error)).toBe(2);
    }
  });
});
