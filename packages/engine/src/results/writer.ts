/**
 * Writing the result file (docs/architecture.md §10).
 *
 * Atomically: the file either holds the previous run or the complete new one, never half of
 * each — a pipeline may read it the moment the process exits.
 */

import { mkdirSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import type { RunResult } from './model.js';

export function serializeResult(result: RunResult): string {
  return `${JSON.stringify(result, null, 2)}\n`;
}

/** Writes the result to `path`, creating the directory it lives in when needed. */
export function writeResult(result: RunResult, path: string): void {
  const directory = dirname(path);
  mkdirSync(directory, { recursive: true });

  const temporary = join(directory, `.rune-result-${process.pid}.tmp`);
  writeFileSync(temporary, serializeResult(result), 'utf8');
  renameSync(temporary, path);
}
