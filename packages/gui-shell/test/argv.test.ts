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

  it('keeps prototype-named overrides enumerable and uses the last duplicate value', () => {
    const invocation = parseShellArgv([
      'installer.yaml',
      '--set',
      '__proto__=first',
      '--set',
      '__proto__=last',
    ]);

    expect(Object.entries(invocation.overrides)).toEqual([['__proto__', 'last']]);
    expect(Object.hasOwn(invocation.overrides, '__proto__')).toBe(true);
  });

  it.each([
    [['first.yaml', 'second.yaml']],
    [['first.yaml', '--locale', 'de-DE', 'second.yaml']],
  ] as const)('rejects multiple manifest paths: %s', (argv) => {
    try {
      parseShellArgv(argv);
      throw new Error('expected parsing to fail');
    } catch (error) {
      expect(error).toBeInstanceOf(UsageError);
      expect(error).toMatchObject({
        code: 'RUNE-001',
        message: 'the shell accepts exactly one manifest path',
      });
      expect(exitCodeFor(error)).toBe(2);
    }
  });

  it.each([
    [['installer.yaml', '--result', '-'], '--result - requires --non-interactive in the GUI shell'],
    [
      ['installer.yaml', '--result', '-', '--set', 'port=8080'],
      '--result - requires --non-interactive in the GUI shell',
    ],
    [['installer.yaml', '--result', '-', '--non-interactive'], undefined],
    [['installer.yaml', '--non-interactive', '--result', '-'], undefined],
  ] as const)('accepts --result - only for headless invocations: %s', (argv, message) => {
    if (message === undefined) {
      expect(parseShellArgv(argv).result).toBe('-');
      return;
    }

    expect(() => parseShellArgv(argv)).toThrowError(
      expect.objectContaining({ code: 'RUNE-001', message }),
    );
  });

  it.each([
    [['--unknown'], 'unknown flag'],
    [['--set=token=distinctive-secret-candidate'], 'unknown flag'],
    [['--unknown=distinctive-secret-candidate'], 'unknown flag'],
    [['--set'], '--set expects a value'],
    [['--values'], '--values expects a value'],
    [['--locale'], '--locale expects a value'],
    [['--result'], '--result expects a value'],
    [['--log-file'], '--log-file expects a value'],
    [['--set', 'port'], '--set expects key=value'],
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
