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
  writeFileSync,
  type WriteStream,
} from 'node:fs';
import { dirname } from 'node:path';

import type { EngineObserver, RunEvent, RunFinished } from '../engine/events.js';

export interface LogFileSink {
  readonly observer: EngineObserver;
  /** Flushes, writes the optional final event, and closes the file exactly once. */
  close(finalEvent?: RunFinished): Promise<void>;
}

export function createLogFileSink(path: string): LogFileSink {
  mkdirSync(dirname(path), { recursive: true });
  // Open eagerly so an invalid target rejects before executeRun can start a runner. Keep
  // this descriptor through finalization so every line targets the same file identity.
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
      autoClose: false,
      encoding: 'utf8',
    });
  } catch (error) {
    try {
      closeSync(descriptor);
    } catch {
      // The open/fstat/stream-construction failure is the primary error.
    }
    throw error;
  }

  let firstError: unknown;
  let descriptorClosed = false;
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
        let settled = false;
        const settle = (): void => {
          if (settled) {
            return;
          }
          settled = true;
          stream.removeListener('finish', settle);
          stream.removeListener('error', settle);

          let primaryError = firstError;
          if (primaryError === undefined && finalEvent !== undefined) {
            try {
              // The stream has flushed, but its original append descriptor remains open.
              // A small synchronous terminal write keeps path replacement out of the sink.
              writeFileSync(
                descriptor,
                `${new Date().toISOString()} ${describe(finalEvent)}\n`,
                'utf8',
              );
            } catch (error) {
              primaryError = error;
            }
          }

          let closeError: unknown;
          if (!descriptorClosed) {
            descriptorClosed = true;
            try {
              closeSync(descriptor);
            } catch (error) {
              closeError = error;
            }
          }

          if (primaryError !== undefined) {
            reject(primaryError);
          } else if (closeError !== undefined) {
            reject(closeError);
          } else {
            resolve();
          }
        };

        stream.once('finish', settle);
        stream.once('error', settle);
        if (firstError !== undefined || stream.writableFinished) {
          settle();
          return;
        }
        try {
          stream.end();
        } catch (error) {
          firstError ??= error;
          settle();
        }
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
