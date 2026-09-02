/**
 * The log-file sink (docs/architecture.md §10): one of the two sinks off the one event
 * stream. Timestamped lines, step output prefixed `[stepId:stdout]`. Lines arrive already
 * masked by the executor. The complete timestamped record is masked again immediately before
 * writing so fixed prefixes and field boundaries cannot create a new clear-text match.
 */

import { createWriteStream, fstat, type Stats, type WriteStream } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { finished } from 'node:stream/promises';

import { escapeDiagnosticText } from '../diagnostics.js';
import type { EngineObserver, RunEvent } from '../engine/events.js';
import { ExecutionError, messageOf } from '../errors.js';

export interface LogFileSink {
  readonly observer: EngineObserver;
  /** Flushes and closes the file; call once, after the run settled. */
  close(): Promise<void>;
}

/** Opens the log before returning, so execution cannot start until the sink is usable. */
export async function createLogFileSink(
  path: string,
  mask: (text: string) => string = (text) => text,
): Promise<LogFileSink> {
  try {
    await mkdir(dirname(path), { recursive: true });
  } catch (cause) {
    throw logError('prepare the directory for', path, cause);
  }

  let stream: WriteStream;
  try {
    stream = createWriteStream(path, { flags: 'a', encoding: 'utf8' });
  } catch (cause) {
    throw logError('open', path, cause);
  }

  let phase: 'opening' | 'writing' | 'closing' = 'opening';
  let failure: ExecutionError | undefined;
  const rememberFailure = (action: 'open' | 'write to' | 'close', cause: unknown): void => {
    failure ??= logError(action, path, cause);
  };
  // This listener is deliberately permanent: every asynchronous stream failure must have
  // an owner, including one emitted while end() is flushing buffered writes.
  stream.on('error', (cause) => {
    rememberFailure(
      phase === 'opening' ? 'open' : phase === 'writing' ? 'write to' : 'close',
      cause,
    );
  });

  let descriptor: number;
  try {
    descriptor = await new Promise<number>((resolve, reject) => {
      const opened = (fd: number): void => {
        stream.removeListener('error', failed);
        resolve(fd);
      };
      const failed = (cause: unknown): void => {
        stream.removeListener('open', opened);
        reject(cause);
      };
      stream.once('open', opened);
      stream.once('error', failed);
    });
  } catch (cause) {
    rememberFailure('open', cause);
    stream.destroy();
    throw failure;
  }

  let target: Stats;
  try {
    target = await fileStats(descriptor);
  } catch (cause) {
    rememberFailure('open', cause);
    stream.destroy();
    throw failure;
  }
  if (target.isDirectory()) {
    rememberFailure('open', new Error('the path is a directory'));
    stream.destroy();
    throw failure;
  }

  if (failure !== undefined) {
    stream.destroy();
    throw failure;
  }
  phase = 'writing';

  let closePromise: Promise<void> | undefined;

  return {
    observer: (event) => {
      if (failure !== undefined || phase !== 'writing') {
        return;
      }
      try {
        const record = `${new Date().toISOString()} ${describe(event)}`;
        stream.write(`${escapeDiagnosticText(mask(record))}\n`, (cause) => {
          if (cause !== undefined && cause !== null) {
            rememberFailure('write to', cause);
          }
        });
      } catch (cause) {
        rememberFailure('write to', cause);
      }
    },
    close: () => {
      closePromise ??= closeStream();
      return closePromise;
    },
  };

  async function closeStream(): Promise<void> {
    phase = 'closing';
    try {
      stream.end();
    } catch (cause) {
      rememberFailure('close', cause);
      stream.destroy();
    }

    try {
      await finished(stream, { cleanup: true });
    } catch (cause) {
      rememberFailure('close', cause);
    }

    if (failure !== undefined) {
      throw failure;
    }
  }
}

function fileStats(fd: number): Promise<Stats> {
  return new Promise((resolve, reject) => {
    fstat(fd, (cause, stats) => {
      if (cause === null) {
        resolve(stats);
      } else {
        reject(cause);
      }
    });
  });
}

function logError(
  action: 'prepare the directory for' | 'open' | 'write to' | 'close',
  path: string,
  cause: unknown,
): ExecutionError {
  return new ExecutionError(
    'RUNE-406',
    `could not ${action} log file "${path}": ${messageOf(cause)}`,
    {
      cause,
    },
  );
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
