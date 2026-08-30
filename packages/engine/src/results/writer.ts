/**
 * Writing the result file (docs/architecture.md §10).
 *
 * Atomically: the file either holds the previous run or the complete new one, never half of
 * each — a pipeline may read it the moment the process exits.
 */

import { randomUUID } from 'node:crypto';
import { mkdir, open, rename, rm, type FileHandle } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';

import type { RunResult } from './model.js';

const renameQueues = new Map<string, Promise<void>>();

function renameQueueKey(path: string): string {
  return process.platform === 'win32' ? path.toLowerCase() : path;
}

async function renameForTarget(temporary: string, path: string): Promise<void> {
  const key = renameQueueKey(path);
  const previous = renameQueues.get(key) ?? Promise.resolve();
  let release: () => void = () => undefined;
  const current = new Promise<void>((resolveCurrent) => {
    release = resolveCurrent;
  });
  const tail = previous.then(() => current);
  renameQueues.set(key, tail);

  try {
    await previous;
    await rename(temporary, path);
  } finally {
    release();
    if (renameQueues.get(key) === tail) {
      renameQueues.delete(key);
    }
  }
}

export function serializeResult(result: RunResult): string {
  return `${JSON.stringify(result, null, 2)}\n`;
}

/** Writes the result to `path`, creating the directory it lives in when needed. */
export async function writeResult(result: RunResult, path: string): Promise<void> {
  const destination = resolve(path);
  const directory = dirname(destination);
  await mkdir(directory, { recursive: true });

  const temporary = join(directory, `.rune-result-${randomUUID()}.tmp`);
  let created = false;
  let handle: FileHandle | undefined;

  try {
    handle = await open(temporary, 'wx');
    created = true;
    await handle.writeFile(serializeResult(result), 'utf8');
    await handle.close();
    handle = undefined;
    await renameForTarget(temporary, destination);
    created = false;
  } catch (error) {
    if (handle !== undefined) {
      await handle.close().catch(() => undefined);
    }
    if (created) {
      await rm(temporary, { force: true }).catch(() => undefined);
    }
    throw error;
  }
}
