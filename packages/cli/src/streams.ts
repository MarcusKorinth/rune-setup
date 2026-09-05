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
  // The first error classifies the stream: after an EPIPE, Node fails the writes it still
  // buffered with a destroyed-stream error, which must not turn a gone consumer into a failure.
  const markBroken = (error: unknown): void => {
    if (broken) {
      return;
    }
    broken = true;
    if (isConsumerGone(error)) {
      return;
    }
    failure = error instanceof Error ? error : new Error('the stream write failed');
    onFailure?.(failure);
  };
  // Permanent on purpose: an asynchronous EPIPE can arrive after the last write returned.
  stream.on('error', markBroken);
  const isBroken = (): boolean => broken || stream.destroyed || stream.writableEnded;
  const write = (text: string): void => {
    if (isBroken()) {
      return;
    }
    try {
      stream.write(text, (error) => {
        if (error !== null && error !== undefined) {
          markBroken(error);
        }
      });
    } catch (error) {
      markBroken(error);
    }
  };
  return {
    write,
    writeLine: (line) => write(`${line}\n`),
    isBroken,
    failure: () => failure,
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
