/**
 * The shell's invocation (docs/architecture.md §9.4): `rune run --gui` launches the shell
 * with the run's own flags, and main opens the Session from them — the renderer never
 * supplies a manifest path or any layer value.
 */

import { RUNE_VERSION } from '@rune/engine';

export const SHELL_VERSION_PROBE_FLAG = '--rune-version-probe';

/** The probe is intentionally produced from the engine actually bundled with this shell. */
export function shellVersionProbeOutput(): string {
  return JSON.stringify({ protocolVersion: 1, runeVersion: RUNE_VERSION }) + '\n';
}

export function isShellVersionProbe(argv: readonly string[]): boolean {
  return argv.length === 1 && argv[0] === SHELL_VERSION_PROBE_FLAG;
}

export interface ShellInvocation {
  readonly manifestPath: string;
  readonly values: readonly string[];
  readonly overrides: Readonly<Record<string, string>>;
  readonly locale: string | undefined;
  readonly result: string | undefined;
  readonly logFile: string | undefined;
  readonly nonInteractive: boolean;
}

export function parseShellArgv(argv: readonly string[]): ShellInvocation {
  let manifestPath: string | undefined;
  const values: string[] = [];
  const overrides = Object.create(null) as Record<string, string>;
  let locale: string | undefined;
  let result: string | undefined;
  let logFile: string | undefined;
  let nonInteractive = false;

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index] as string;
    const next = (): string => {
      index += 1;
      const value = argv[index];
      if (value === undefined) {
        throw new Error(`${argument} expects a value`);
      }
      return value;
    };
    switch (argument) {
      case '--':
        // Launcher protocol: the literal manifest path comes first, then RUNE options.
        manifestPath = next();
        break;
      case '--set': {
        const pair = next();
        const separator = pair.indexOf('=');
        if (separator <= 0) {
          throw new Error(`--set expects key=value, got "${pair}"`);
        }
        overrides[pair.slice(0, separator)] = pair.slice(separator + 1);
        break;
      }
      case '--values':
        values.push(next());
        break;
      case '--locale':
        locale = next();
        break;
      case '--result':
        result = next();
        break;
      case '--log-file':
        logFile = next();
        break;
      case '--non-interactive':
        nonInteractive = true;
        break;
      default:
        if (argument.startsWith('--')) {
          throw new Error(`unknown flag ${argument}`);
        }
        manifestPath = argument;
    }
  }

  if (manifestPath === undefined) {
    throw new Error('the shell needs a manifest path');
  }
  return { manifestPath, values, overrides, locale, result, logFile, nonInteractive };
}
