/** Shared flag parsing — one spelling of each check for every verb (§4.1). */

import { UsageError } from '@rune/engine';

export function parseOverrides(pairs: readonly string[]): Record<string, string> {
  const overrides: Record<string, string> = Object.create(null) as Record<string, string>;
  for (const pair of pairs) {
    const separator = pair.indexOf('=');
    if (separator <= 0) {
      throw new UsageError(`--set expects key=value, got "${pair}"`);
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
    throw new UsageError(`--platform must be windows or linux, got "${raw}"`);
  }
  return raw;
}
