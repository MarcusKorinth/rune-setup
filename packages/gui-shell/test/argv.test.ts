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
    expect(isShellVersionProbe(['--ozone-platform=headless', SHELL_VERSION_PROBE_FLAG])).toBe(true);
    expect(isShellVersionProbe([SHELL_VERSION_PROBE_FLAG, 'installer.yaml'])).toBe(false);
    expect(JSON.parse(shellVersionProbeOutput())).toEqual({
      protocolVersion: 1,
      runeVersion: RUNE_VERSION,
      workflowPackageVersion: 1,
    });
  });

  it.each([
    ['--ozone-platform=x11', SHELL_VERSION_PROBE_FLAG],
    [SHELL_VERSION_PROBE_FLAG, '--ozone-platform=headless'],
    ['--ozone-platform=headless', SHELL_VERSION_PROBE_FLAG, 'installer.yaml'],
    ['--ozone-platform=headless', '--', SHELL_VERSION_PROBE_FLAG],
    ['--ozone-platform=headless', SHELL_VERSION_PROBE_FLAG, '--non-interactive'],
    ['--ozone-platform=headless', '--ozone-platform=headless', SHELL_VERSION_PROBE_FLAG],
  ])('keeps the runtime-prefixed probe strictly standalone: %s', (...argv) => {
    expect(isShellVersionProbe(argv)).toBe(false);
  });
});

describe('parseShellArgv', () => {
  it('opens the bound workflow without arguments and preserves headless options', () => {
    expect(parseShellArgv([], '/bundle/workflow/setup.yaml')).toMatchObject({
      manifestPath: '/bundle/workflow/setup.yaml',
      nonInteractive: false,
    });
    expect(
      parseShellArgv(['--non-interactive', '--result', '-'], '/bundle/workflow/setup.yaml'),
    ).toMatchObject({
      manifestPath: '/bundle/workflow/setup.yaml',
      nonInteractive: true,
      result: '-',
    });
    expect(
      parseShellArgv(['--', '--literal.yaml'], '/bundle/workflow/setup.yaml').manifestPath,
    ).toBe('--literal.yaml');
    expect(
      parseShellArgv(['--remote-debugging-port=0'], '/bundle/workflow/setup.yaml').manifestPath,
    ).toBe('/bundle/workflow/setup.yaml');
  });
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

  it.each([0, 65535])(
    'accepts Electron inspection port %s before the literal manifest marker',
    (port) => {
      expect(
        parseShellArgv([
          `--remote-debugging-port=${port}`,
          '--',
          'installer.yaml',
          '--locale',
          'de',
        ]),
      ).toEqual(parseShellArgv(['--', 'installer.yaml', '--locale', 'de']));
    },
  );

  it.each(['', '-1', '65536', '1.5', '+1', '0x50', 'private-value'])(
    'rejects malformed or out-of-range inspection ports without echoing them: %s',
    (port) => {
      expect(() =>
        parseShellArgv([`--remote-debugging-port=${port}`, '--', 'installer.yaml']),
      ).toThrowError(expect.objectContaining({ code: 'RUNE-001', message: 'unknown flag' }));
    },
  );

  it.each([
    ['--remote-debugging-port=0', 'installer.yaml'],
    ['--', 'installer.yaml', '--remote-debugging-port=0'],
    ['--inspect=0', '--', 'installer.yaml'],
    ['--no-sandbox', '--', 'installer.yaml'],
    ['--remote-debugging-port=0', '--unknown', '--', 'installer.yaml'],
  ])('keeps unsupported inspection positions and unrelated switches invalid: %s', (...argv) => {
    expect(() => parseShellArgv(argv)).toThrowError(expect.objectContaining({ code: 'RUNE-001' }));
  });

  it('retains inspection-shaped literal manifest paths and RUNE option values', () => {
    expect(parseShellArgv(['--', '--remote-debugging-port=0']).manifestPath).toBe(
      '--remote-debugging-port=0',
    );
    expect(
      parseShellArgv(['--result', '--remote-debugging-port=0', '--', 'installer.yaml']).result,
    ).toBe('--remote-debugging-port=0');
  });

  it.each([
    ['installer.yaml', '--non-interactive'],
    ['--non-interactive', '--', 'installer.yaml'],
    ['--remote-debugging-port=0', '--', 'installer.yaml', '--non-interactive', '--result', '-'],
  ])('accepts the exact leading headless runtime switch for a valid invocation: %s', (...argv) => {
    expect(parseShellArgv(['--ozone-platform=headless', ...argv])).toEqual(parseShellArgv(argv));
  });

  it.each([
    ['--ozone-platform=headless', 'installer.yaml'],
    ['--ozone-platform=headless', '--', '--non-interactive'],
    ['--ozone-platform=headless', 'installer.yaml', '--locale', '--non-interactive'],
    ['--ozone-platform=headless', 'installer.yaml', '--values', '--non-interactive'],
    ['--ozone-platform=headless', 'installer.yaml', '--result', '--non-interactive'],
    ['--ozone-platform=headless', 'installer.yaml', '--log-file', '--non-interactive'],
    ['--ozone-platform=headless', 'installer.yaml', '--set', 'mode=--non-interactive'],
    [
      '--ozone-platform=headless',
      '--ozone-platform=headless',
      'installer.yaml',
      '--non-interactive',
    ],
    ['installer.yaml', '--ozone-platform=headless', '--non-interactive'],
    ['--non-interactive', '--ozone-platform=headless', 'installer.yaml'],
    [
      '--remote-debugging-port=0',
      '--ozone-platform=headless',
      '--',
      'installer.yaml',
      '--non-interactive',
    ],
    ['--', 'installer.yaml', '--ozone-platform=headless', '--non-interactive'],
    ['--ozone-platform=x11', 'installer.yaml', '--non-interactive'],
    ['--ozone-platform=headless-private-value', 'installer.yaml', '--non-interactive'],
    ['--ozone-platform', 'headless', 'installer.yaml', '--non-interactive'],
    ['--ozone-platform=headless', '--unknown', 'installer.yaml', '--non-interactive'],
  ])('rejects unsupported headless runtime uses without echoing values: %s', (...argv) => {
    expect(() => parseShellArgv(argv)).toThrowError(
      expect.objectContaining({ code: 'RUNE-001', message: 'unknown flag' }),
    );
  });

  it('preserves headless-switch-shaped manifest paths and option values', () => {
    expect(parseShellArgv(['--', '--ozone-platform=headless']).manifestPath).toBe(
      '--ozone-platform=headless',
    );
    expect(
      parseShellArgv(['--result', '--ozone-platform=headless', '--', 'installer.yaml']).result,
    ).toBe('--ozone-platform=headless');
  });

  it.each([
    [['--ozone-platform=headless', '--non-interactive'], 'the shell needs a manifest path'],
    [
      ['--ozone-platform=headless', 'installer.yaml', '--non-interactive', '--values', ''],
      '--values needs a non-empty path',
    ],
    [
      [
        '--ozone-platform=headless',
        'installer.yaml',
        '--non-interactive',
        '--set',
        'private-value',
      ],
      '--set expects key=value',
    ],
  ] as const)(
    'still validates the entire invocation after the runtime switch: %s',
    (argv, message) => {
      expect(() => parseShellArgv(argv)).toThrowError(
        expect.objectContaining({ code: 'RUNE-001', message }),
      );
    },
  );

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
    [['installer.yaml', '--log-file', ''], '--log-file needs a non-empty path'],
    [['installer.yaml', '--values', ''], '--values needs a non-empty path'],
    [
      ['installer.yaml', '--values', 'base.yaml', '--values', ''],
      '--values needs a non-empty path',
    ],
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
