import { RUNE_VERSION, UsageError } from '@rune/engine';

/**
 * The shell's invocation (docs/architecture.md §9.4): `rune run --gui` launches the shell
 * with the run's own flags, and main opens the Session from them — the renderer never
 * supplies a manifest path or any layer value.
 */

export const SHELL_VERSION_PROBE_FLAG = '--rune-version-probe';

/** The probe is intentionally produced from the engine actually bundled with this shell. */
export function shellVersionProbeOutput(): string {
  return (
    JSON.stringify({ protocolVersion: 1, runeVersion: RUNE_VERSION, workflowPackageVersion: 1 }) +
    '\n'
  );
}

export function isShellVersionProbe(argv: readonly string[]): boolean {
  return (
    (argv.length === 1 && argv[0] === SHELL_VERSION_PROBE_FLAG) ||
    (argv.length === 2 &&
      argv[0] === '--ozone-platform=headless' &&
      argv[1] === SHELL_VERSION_PROBE_FLAG)
  );
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

export function parseShellArgv(
  argv: readonly string[],
  defaultManifestPath?: string,
): ShellInvocation {
  // The Linux launcher selects Ozone before Electron starts. Consume only its exact
  // leading switch, then require a fully parsed non-interactive invocation below.
  const headlessRuntime = argv[0] === '--ozone-platform=headless';
  const manifestMarker = argv.indexOf('--');
  let manifestPath: string | undefined;
  const values: string[] = [];
  const overrides = new Map<string, string>();
  let locale: string | undefined;
  let result: string | undefined;
  let logFile: string | undefined;
  let nonInteractive = false;

  for (let index = headlessRuntime ? 1 : 0; index < argv.length; index += 1) {
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
      case '--':
        if (manifestPath !== undefined) {
          throw new UsageError('the shell accepts exactly one manifest path');
        }
        // Launcher protocol: the literal manifest path comes first, then RUNE options.
        manifestPath = next();
        break;
      case '--set': {
        const pair = next();
        const separator = pair.indexOf('=');
        if (separator <= 0) {
          throw new UsageError('--set expects key=value');
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
        // Electron consumes this inspection switch before the manifest marker.
        // A bound workflow can omit the marker because it supplies a default manifest.
        if (
          (index < manifestMarker ||
            (manifestMarker === -1 && defaultManifestPath !== undefined)) &&
          /^--remote-debugging-port=\d+$/.test(argument) &&
          Number(argument.slice('--remote-debugging-port='.length)) <= 65535
        ) {
          break;
        }
        if (argument.startsWith('--')) {
          throw new UsageError('unknown flag');
        }
        if (manifestPath !== undefined) {
          throw new UsageError('the shell accepts exactly one manifest path');
        }
        manifestPath = argument;
    }
  }

  manifestPath ??= defaultManifestPath;
  if (manifestPath === undefined) {
    throw new UsageError('the shell needs a manifest path');
  }
  if (logFile === '') {
    throw new UsageError('--log-file needs a non-empty path');
  }
  if (values.includes('')) {
    throw new UsageError('--values needs a non-empty path');
  }
  if (result === '-' && !nonInteractive) {
    throw new UsageError('--result - requires --non-interactive in the GUI shell');
  }
  if (headlessRuntime && !nonInteractive) {
    throw new UsageError('unknown flag');
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
