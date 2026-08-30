import { UsageError } from '@rune/engine';

/**
 * The shell's invocation (docs/architecture.md §9.4): `rune run --gui` launches the shell
 * with the run's own flags, and main opens the Session from them — the renderer never
 * supplies a manifest path or any layer value.
 */

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
  const overrides = new Map<string, string>();
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
        throw new UsageError(`${argument} expects a value`);
      }
      return value;
    };
    switch (argument) {
      case '--set': {
        const pair = next();
        const separator = pair.indexOf('=');
        if (separator <= 0) {
          throw new UsageError(`--set expects key=value, got "${pair}"`);
        }
        overrides.set(pair.slice(0, separator), pair.slice(separator + 1));
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
          throw new UsageError(`unknown flag ${argument}`);
        }
        manifestPath = argument;
    }
  }

  if (manifestPath === undefined) {
    throw new UsageError('the shell needs a manifest path');
  }
  return {
    manifestPath,
    values,
    overrides: Object.fromEntries(overrides),
    locale,
    result,
    logFile,
    nonInteractive,
  };
}
