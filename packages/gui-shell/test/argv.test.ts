import { describe, expect, it } from 'vitest';

import { RUNE_VERSION, UsageError, exitCodeFor } from '@rune/engine';

import {
  SHELL_VERSION_PROBE_FLAG,
  isShellVersionProbe,
  parseShellArgv,
  shellVersionProbeOutput,
} from '../src/main/argv.js';

describe('the shell version probe', () => {
  it('is a standalone argv mode that reports the bundled engine version', () => {
    expect(isShellVersionProbe([SHELL_VERSION_PROBE_FLAG])).toBe(true);
    expect(isShellVersionProbe([SHELL_VERSION_PROBE_FLAG, 'installer.yaml'])).toBe(false);
    expect(JSON.parse(shellVersionProbeOutput())).toEqual({
      protocolVersion: 1,
      runeVersion: RUNE_VERSION,
    });
  });
});

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

  it('accepts a literal manifest path beginning with -- before launcher options', () => {
    expect(parseShellArgv(['--', '--installer.yaml', '--locale', 'de'])).toMatchObject({
      manifestPath: '--installer.yaml',
      locale: 'de',
    });
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
