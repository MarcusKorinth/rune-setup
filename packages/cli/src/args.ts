/** Shared flag parsing — one spelling of each check for every verb (§4.1). */

import { UsageError } from '@rune/engine';

/** The flags of `rune run` as commander hands them over. */
export interface RunFlags {
  readonly gui?: boolean | undefined;
  readonly nonInteractive?: boolean | undefined;
  readonly dryRun?: boolean | undefined;
  readonly set?: readonly string[] | undefined;
  readonly values?: readonly string[] | undefined;
  readonly result?: string | undefined;
  readonly logFile?: string | undefined;
  readonly locale?: string | undefined;
  readonly platform?: string | undefined;
}

export function parseOverrides(pairs: readonly string[]): Record<string, string> {
  const overrides = Object.create(null) as Record<string, string>;
  for (const pair of pairs) {
    const separator = pair.indexOf('=');
    if (separator <= 0) {
      throw new UsageError('--set expects key=value');
    }
    overrides[pair.slice(0, separator)] = pair.slice(separator + 1);
  }
  return overrides;
}

export function parsePlatform(raw: string | undefined): 'windows' | 'linux' | undefined {
  if (raw === undefined) {
    return undefined;
  }
  if (raw !== 'windows' && raw !== 'linux') {
    throw new UsageError('--platform must be windows or linux');
  }
  return raw;
}
