/**
 * Guarded process-stream writers (docs/architecture.md §10, stream discipline).
 *
 * A consumer that closes stdout or stderr early — `| head -1`, a viewer quit mid-stream —
 * makes Node emit `error` (EPIPE) on that stream. Without an owner that event is an uncaught
 * exception: a stack trace on stderr and exit code 1, which §10 reserves for failed steps.
 * The guard owns the event, remembers that the stream is broken, and turns every later write
 * into a silent no-op, so the run's own exit code stands and nothing reaches a closed pipe.
 */

import type { Writable } from 'node:stream';

export interface GuardedStream {
  /** Writes one line; a silent no-op once the stream is broken or destroyed. */
  readonly writeLine: (line: string) => void;
  /** Whether a stream error or its destruction has ended RUNE's output on this stream. */
  readonly isBroken: () => boolean;
}

/** Attaches one permanent `error` owner to `stream` and returns its guarded line writer. */
export function guardStream(stream: Writable): GuardedStream {
  let broken = false;
  const markBroken = (): void => {
    broken = true;
  };
  // Permanent on purpose: an asynchronous EPIPE can arrive after the last write returned.
  stream.on('error', markBroken);
  const isBroken = (): boolean => broken || stream.destroyed || stream.writableEnded;
  return {
    writeLine: (line) => {
      if (isBroken()) {
        return;
      }
      try {
        stream.write(`${line}\n`, (error) => {
          if (error !== null && error !== undefined) {
            markBroken();
          }
        });
      } catch {
        markBroken();
      }
    },
    isBroken,
  };
}
