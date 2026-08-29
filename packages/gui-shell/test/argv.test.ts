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
});
