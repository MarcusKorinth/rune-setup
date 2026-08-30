import { readFileSync } from 'node:fs';

import { RUNE_CLI_VERSION } from '@rune/cli';
import { RUNE_VERSION } from '@rune/engine';
import { describe, expect, it } from 'vitest';

/**
 * The exported version constants are a user-visible contract (the CLI banner, `rune --version`,
 * and the result-file provenance of docs/architecture.md §10 today). Nothing in the
 * build keeps them in sync with the package manifests — this suite is what does.
 */
function manifestVersion(relativePath: string): string {
  const parsed: unknown = JSON.parse(readFileSync(new URL(relativePath, import.meta.url), 'utf8'));
  const version = (parsed as { version?: unknown }).version;
  if (typeof version !== 'string') {
    throw new Error(`${relativePath} has no string "version" field`);
  }
  return version;
}

describe('exported version constants', () => {
  it('RUNE_VERSION matches packages/engine/package.json', () => {
    expect(RUNE_VERSION).toBe(manifestVersion('../packages/engine/package.json'));
  });

  it('RUNE_CLI_VERSION matches packages/cli/package.json', () => {
    expect(RUNE_CLI_VERSION).toBe(manifestVersion('../packages/cli/package.json'));
  });
});
