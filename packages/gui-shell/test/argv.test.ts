import { describe, expect, it } from 'vitest';

import { RUNE_VERSION } from '@rune/engine';

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

  it('does not change ordinary run argv parsing', () => {
    expect(parseShellArgv(['installer.yaml', '--locale', 'de'])).toMatchObject({
      manifestPath: 'installer.yaml',
      locale: 'de',
    });
  });

  it('preserves every override name as an own key without a prototype', () => {
    const { overrides } = parseShellArgv([
      'installer.yaml',
      '--set',
      'greeting=first',
      '--set',
      '__proto__=boom',
      '--set',
      'constructor=build',
      '--set',
      'toString=render',
      '--set',
      'greeting=last',
    ]);

    expect(Object.getPrototypeOf(overrides)).toBeNull();
    expect(Object.hasOwn(overrides, '__proto__')).toBe(true);
    expect(Object.hasOwn(overrides, 'constructor')).toBe(true);
    expect(Object.hasOwn(overrides, 'toString')).toBe(true);
    expect(overrides['__proto__']).toBe('boom');
    expect(overrides['constructor']).toBe('build');
    expect(overrides['toString']).toBe('render');
    expect(overrides['greeting']).toBe('last');
  });
});
