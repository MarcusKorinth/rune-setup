/**
 * Writing the result file (docs/architecture.md §10).
 *
 * Atomically: the file either holds the previous run or the complete new one, never half of
 * each — a pipeline may read it the moment the process exits. A filesystem failure is the
 * operational RUNE-407, never an internal error: like the log sink's RUNE-406 it names the
 * destination and a fixed reason, and keeps the cause internally.
 */

import { randomUUID } from 'node:crypto';
import { mkdir, open, rename, rm, type FileHandle } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';

import { ExecutionError, filesystemFailureReason, InternalError } from '../errors.js';
import type { RunResult } from './model.js';
import { resultV2Schema } from './schema.js';

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

/**
 * Returns exactly the text `writeResult` writes: the schema-validated copy of the result in
 * the schema's member order, two-space indented, newline-terminated. Both result sinks —
 * the file and `--result -` on stdout — go through here, so a result that does not match
 * resultSchemaVersion 2 fails closed before it reaches either one.
 */
export function serializeResult(result: RunResult): string {
  let parsed: ReturnType<typeof resultV2Schema.safeParse>;
  try {
    parsed = resultV2Schema.safeParse(result);
  } catch {
    throw new InternalError('the run result does not match resultSchemaVersion 2');
  }
  if (!parsed.success) {
    throw new InternalError('the run result does not match resultSchemaVersion 2');
  }
  return `${JSON.stringify(parsed.data, null, 2)}\n`;
}

type ResultFileAction = 'prepare the directory for' | 'open' | 'write to' | 'close' | 'finalize';

function resultError(action: ResultFileAction, path: string, cause: unknown): ExecutionError {
  return new ExecutionError(
    'RUNE-407',
    `could not ${action} result file "${path}": ${filesystemFailureReason(cause)}`,
    { cause },
  );
}

/** How a RUNE-407 diagnostic names the destination (docs/architecture.md §10). */
export interface WriteResultOptions {
  /**
   * The spelling the diagnostic names instead of `path`. A host that anchors or otherwise
   * normalizes the destination itself writes to the anchored path but reports the operator's
   * own spelling, so the failure line names the same bytes its success line names — the bytes
   * a secret registry can hold. Defaults to `path`.
   */
  readonly announcement?: string | undefined;
}

/** Writes the result to `path`, creating the directory it lives in when needed. */
export async function writeResult(
  result: RunResult,
  path: string,
  options: WriteResultOptions = {},
): Promise<void> {
  // Validate and serialize the schema-produced copy before touching the filesystem. Besides
  // failing closed, this prevents a mutable caller from changing the original after validation.
  const serialized = serializeResult(result);
  const named = options.announcement ?? path;
  const destination = resolve(path);
  const directory = dirname(destination);
  try {
    await mkdir(directory, { recursive: true });
  } catch (cause) {
    throw resultError('prepare the directory for', named, cause);
  }

  const temporary = join(directory, `.rune-result-${randomUUID()}.tmp`);
  let created = false;
  let handle: FileHandle | undefined;
  let action: ResultFileAction = 'open';

  try {
    handle = await open(temporary, 'wx');
    created = true;
    action = 'write to';
    await handle.writeFile(serialized, 'utf8');
    action = 'close';
    await handle.close();
    handle = undefined;
    action = 'finalize';
    await renameForTarget(temporary, destination);
    created = false;
  } catch (cause) {
    if (handle !== undefined) {
      await handle.close().catch(() => undefined);
    }
    if (created) {
      await rm(temporary, { force: true }).catch(() => undefined);
    }
    throw resultError(action, named, cause);
  }
}
