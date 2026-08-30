/**
 * The log-file sink (docs/architecture.md §10): one of the two sinks off the one event
 * stream. Timestamped lines, step output prefixed `[stepId:stdout]`. Lines arrive already
 * masked — the executor masks before any observer sees them.
 */

import {
  closeSync,
  createWriteStream,
  fstatSync,
  mkdirSync,
  openSync,
  type WriteStream,
} from 'node:fs';
import { appendFile } from 'node:fs/promises';
import { dirname } from 'node:path';

import type { EngineObserver, RunEvent, RunFinished } from '../engine/events.js';

export interface LogFileSink {
  readonly observer: EngineObserver;
  /** Flushes and closes the file, then writes the optional final event exactly once. */
  close(finalEvent?: RunFinished): Promise<void>;
}

export function createLogFileSink(path: string): LogFileSink {
  mkdirSync(dirname(path), { recursive: true });
  // Open eagerly so an invalid target rejects before executeRun can start a runner. Passing
  // the descriptor to WriteStream preserves its ordered, non-blocking writes afterwards.
  const descriptor = openSync(path, 'a');
  let stream: WriteStream;
  try {
    // Windows can open a directory descriptor in append mode and fail only on the first
    // write, unlike Linux. Reject it here so both hosts preserve pre-run validation.
    if (fstatSync(descriptor).isDirectory()) {
      throw new Error(`log file target is a directory: ${path}`);
    }
    stream = createWriteStream(path, {
      fd: descriptor,
      autoClose: true,
      encoding: 'utf8',
    });
  } catch (error) {
    closeSync(descriptor);
    throw error;
  }

  let firstError: Error | undefined;
  let closePromise: Promise<void> | undefined;
  // A WriteStream error without a listener is process-fatal. Retain the first failure so
  // close() can report it through Session.execute's ordinary Promise boundary.
  stream.on('error', (error: Error) => {
    firstError ??= error;
  });

  return {
    observer: (event) => {
      stream.write(`${new Date().toISOString()} ${describe(event)}\n`);
    },
    close: (finalEvent) => {
      if (closePromise !== undefined) {
        return closePromise;
      }
      closePromise = new Promise<void>((resolve, reject) => {
        const settle = (): void => {
          if (firstError !== undefined) {
            reject(firstError);
            return;
          }
          if (finalEvent === undefined) {
            resolve();
            return;
          }
          // Only append the terminal status after all earlier writes closed cleanly. A
          // failed flush must not leave a deliberately premature success in the log.
          appendFile(path, `${new Date().toISOString()} ${describe(finalEvent)}\n`, 'utf8').then(
            () => resolve(),
            reject,
          );
        };
        if (stream.closed) {
          settle();
          return;
        }
        stream.once('close', settle);
        stream.end();
      });
      return closePromise;
    },
  };
}

function describe(event: RunEvent): string {
  switch (event.kind) {
    case 'runStarted':
      return `run started: ${event.plan.steps.length} steps, platform ${event.plan.platform}`;
    case 'stepStarted':
      return `[${event.stepId}] started (${event.index + 1}/${event.total}): ${event.title}`;
    case 'stepOutput':
      return `[${event.stepId}:${event.stream}] ${event.line}`;
    case 'stepFinished':
      return `[${event.stepId}] ${event.state}${
        event.exitCode === undefined ? '' : ` (exit ${event.exitCode})`
      } after ${event.durationMs}ms`;
    case 'runFinished':
      return `run finished: ${event.result.status} (exit ${event.result.exitCode})`;
  }
}
