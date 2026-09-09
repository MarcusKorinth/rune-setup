/** Process-stream ownership for the GUI shell (docs/architecture.md §10). */

import type { Writable } from 'node:stream';

export const LOST_STDOUT_DIAGNOSTIC = 'could not write the requested machine output to stdout';

export type StreamWriteOutcome = 'written' | 'consumer-gone' | 'failed';

export interface ShellProcessStreams {
  readonly stdout: Writable;
  readonly stderr: Writable;
}

export interface GuardedShellStream {
  /** Best-effort write used for diagnostics. */
  readonly write: (text: string) => void;
  /** Awaited write for execution progress and requested stdout results. */
  readonly writeAndWait: (text: string) => Promise<StreamWriteOutcome>;
  /** True only when the first stream error was not an early-closing consumer. */
  readonly failed: () => boolean;
  /** True once this stream can no longer accept output. */
  readonly isBroken: () => boolean;
}

export interface ShellStreams {
  readonly stdout: GuardedShellStream;
  readonly stderr: GuardedShellStream;
  /** Stops new writes; listeners remain until issued callbacks drain or the stream closes. */
  readonly dispose: () => void;
}

const CONSUMER_GONE_CODES: ReadonlySet<string> = new Set(['EPIPE', 'ECONNRESET']);

/**
 * Owns stdout and stderr independently for one shell lifecycle.
 *
 * stdout failures report one fixed, data-free diagnostic through the guarded stderr sink.
 * stderr failures only end diagnostics. The first error classifies each stream so the usual
 * callback/error-event duplicate cannot change the outcome or print a second line.
 */
export function guardShellStreams(streams: ShellProcessStreams): ShellStreams {
  const stderr = guardStream(streams.stderr);
  const stdout = guardStream(streams.stdout, () => {
    stderr.write(`${LOST_STDOUT_DIAGNOSTIC}\n`);
  });
  return {
    stdout,
    stderr,
    dispose: () => {
      stdout.dispose();
      stderr.dispose();
    },
  };
}

interface DisposableGuardedShellStream extends GuardedShellStream {
  readonly dispose: () => void;
}

function guardStream(stream: Writable, onFailure?: () => void): DisposableGuardedShellStream {
  let classification: Exclude<StreamWriteOutcome, 'written'> | undefined;
  let acceptingWrites = true;
  let listenerAttached = true;
  let pendingCallbacks = 0;
  let cleanupScheduled = false;
  const pending = new Set<(outcome: StreamWriteOutcome) => void>();

  const currentOutcome = (): StreamWriteOutcome => {
    if (classification !== undefined) {
      return classification;
    }
    return !acceptingWrites || stream.destroyed || stream.writableEnded
      ? 'consumer-gone'
      : 'written';
  };
  const settlePending = (): void => {
    const outcome = currentOutcome();
    for (const settle of pending) {
      settle(outcome);
    }
    pending.clear();
  };
  const markBroken = (error: unknown, settleWrites = true): void => {
    if (classification !== undefined || !listenerAttached) {
      return;
    }
    classification = isConsumerGone(error) ? 'consumer-gone' : 'failed';
    if (classification === 'failed') {
      onFailure?.();
    }
    if (settleWrites) {
      settlePending();
    }
  };
  const errorListener = (error: unknown): void => markBroken(error);
  const closeListener = (): void => {
    acceptingWrites = false;
    if (classification === undefined) {
      classification = 'consumer-gone';
    }
    settlePending();
    // A destroyed Writable can close without settling its outstanding write callbacks.
    // Those callbacks cannot be awaited for listener cleanup once the consumer is gone.
    pendingCallbacks = 0;
    scheduleCleanup();
  };
  stream.on('error', errorListener);
  stream.on('close', closeListener);

  const scheduleCleanup = (): void => {
    if (acceptingWrites || pendingCallbacks !== 0 || cleanupScheduled || !listenerAttached) {
      return;
    }
    cleanupScheduled = true;
    setImmediate(() => {
      cleanupScheduled = false;
      if (acceptingWrites || pendingCallbacks !== 0 || !listenerAttached) {
        return;
      }
      stream.off('error', errorListener);
      stream.off('close', closeListener);
      listenerAttached = false;
    });
  };
  const beginWrite = (): void => {
    pendingCallbacks += 1;
  };
  const completeWrite = (): void => {
    if (pendingCallbacks !== 0) {
      pendingCallbacks -= 1;
    }
    scheduleCleanup();
  };

  const write = (text: string): void => {
    if (currentOutcome() !== 'written') {
      return;
    }
    beginWrite();
    try {
      stream.write(text, (error) => {
        if (error !== null && error !== undefined) {
          markBroken(error);
        }
        completeWrite();
      });
    } catch (error) {
      completeWrite();
      markBroken(error);
    }
  };

  const writeAndWait = (text: string): Promise<StreamWriteOutcome> => {
    const before = currentOutcome();
    if (before !== 'written') {
      return Promise.resolve(before);
    }
    return new Promise((resolve) => {
      let settled = false;
      const settle = (outcome: StreamWriteOutcome): void => {
        if (settled) {
          return;
        }
        settled = true;
        pending.delete(settle);
        resolve(outcome);
      };
      pending.add(settle);
      beginWrite();
      try {
        stream.write(text, (error) => {
          if (error !== null && error !== undefined) {
            markBroken(error, false);
          }
          completeWrite();
          // Writable streams commonly emit `error` for the same callback failure. Give that
          // event its normal turn before the owner can dispose this listener.
          setImmediate(() => settle(currentOutcome()));
        });
      } catch (error) {
        completeWrite();
        markBroken(error);
        settle(currentOutcome());
      }
    });
  };

  return {
    write,
    writeAndWait,
    failed: () => classification === 'failed',
    isBroken: () => currentOutcome() !== 'written',
    dispose: () => {
      if (!acceptingWrites) {
        return;
      }
      acceptingWrites = false;
      settlePending();
      // A Writable reports callback errors and then emits `error`. Stop new writes now, but
      // keep owning that event until callbacks for every already-issued write have drained.
      scheduleCleanup();
    },
  };
}

function isConsumerGone(error: unknown): boolean {
  return (
    error instanceof Error &&
    'code' in error &&
    typeof error.code === 'string' &&
    CONSUMER_GONE_CODES.has(error.code)
  );
}

let fallbackProcessOutput: ShellStreams | undefined;

/** Shares one lazy stream guard when a direct shell entry has no lifecycle-owned output. */
export function fallbackOutput(): ShellStreams {
  fallbackProcessOutput ??= guardShellStreams({ stdout: process.stdout, stderr: process.stderr });
  return fallbackProcessOutput;
}
