/**
 * Guarded process-stream writers (docs/architecture.md §10, stream discipline).
 *
 * A consumer that closes stdout or stderr early — `| head -1`, a viewer quit mid-stream —
 * makes Node emit `error` (EPIPE) on that stream. Without an owner that event is an uncaught
 * exception: a stack trace on stderr and exit code 1, which §10 reserves for failed steps.
 * The guard owns the event, remembers that the stream is broken, and turns every later write
 * into a silent no-op, so the run's own exit code stands and nothing reaches a closed pipe.
 * Only that consumer-went-away family is silent: any other error (a full disk, an I/O error)
 * has lost output, so the guard keeps it and reports it once to the owner's hook.
 */

import type { Writable } from 'node:stream';

export interface GuardedStream {
  /** Writes raw text; used by readline prompts that keep the answer on the same line. */
  readonly write: (text: string) => void;
  /** Writes one line; a silent no-op once the stream is broken or destroyed. */
  readonly writeLine: (line: string) => void;
  /** Whether a stream error or its destruction has ended RUNE's output on this stream. */
  readonly isBroken: () => boolean;
  /** The error that ended the output, unless it only meant that the consumer went away. */
  readonly failure: () => Error | undefined;
  /** Waits for queued write callbacks, or for the stream to stop accepting output. */
  readonly drain: () => Promise<void>;
}

/** errno codes that mean the reader is gone; RUNE's output on that stream simply ends. */
const CONSUMER_GONE_CODES: ReadonlySet<string> = new Set(['EPIPE', 'ECONNRESET']);

/**
 * Attaches one permanent `error` owner to `stream` and returns its guarded line writer.
 * `onFailure` runs at most once, when the stream ends on an error other than a consumer that
 * went away — possibly after the write that hit it has long returned.
 */
export function guardStream(stream: Writable, onFailure?: (error: Error) => void): GuardedStream {
  let broken = false;
  let failure: Error | undefined;
  let pendingWrites = 0;
  let draining: Promise<void> | undefined;
  let resolveDrain: (() => void) | undefined;
  const finishDrain = (): void => {
    const resolve = resolveDrain;
    draining = undefined;
    resolveDrain = undefined;
    resolve?.();
  };
  // The first error classifies the stream: after an EPIPE, Node fails the writes it still
  // buffered with a destroyed-stream error, which must not turn a gone consumer into a failure.
  const markBroken = (error: unknown): void => {
    if (broken) {
      return;
    }
    broken = true;
    finishDrain();
    if (isConsumerGone(error)) {
      return;
    }
    failure = error instanceof Error ? error : new Error('the stream write failed');
    onFailure?.(failure);
  };
  // Permanent on purpose: an asynchronous EPIPE can arrive after the last write returned.
  stream.on('error', markBroken);
  stream.on('close', () => {
    broken = true;
    finishDrain();
  });
  const isBroken = (): boolean => broken || stream.destroyed || stream.writableEnded;
  const write = (text: string): void => {
    if (isBroken()) {
      return;
    }
    pendingWrites += 1;
    let completed = false;
    const completeWrite = (error?: Error | null): void => {
      if (completed) {
        return;
      }
      completed = true;
      pendingWrites -= 1;
      if (error !== null && error !== undefined) {
        markBroken(error);
      }
      if (pendingWrites === 0) {
        finishDrain();
      }
    };
    try {
      stream.write(text, completeWrite);
    } catch (error) {
      completeWrite();
      markBroken(error);
    }
  };
  return {
    write,
    writeLine: (line) => write(`${line}\n`),
    isBroken,
    failure: () => failure,
    drain: () => {
      if (pendingWrites === 0 || broken || stream.destroyed) {
        return Promise.resolve();
      }
      // All callers share one waiter, independent of the number of buffered writes.
      draining ??= new Promise<void>((resolve) => {
        resolveDrain = resolve;
      });
      return draining;
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
