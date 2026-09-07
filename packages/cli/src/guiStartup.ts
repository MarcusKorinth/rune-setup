/** Linux workflow readiness and result ownership (docs/architecture.md §9.4). */

import type { Duplex } from 'node:stream';

import { CancelledError, UsageError } from '@rune/engine';

import { ExitWithCode } from './io.js';

export interface GuiStartupGate {
  readonly completion: Promise<void>;
  /** True once the one control write has been attempted, even if that write failed. */
  readonly transferred: () => boolean;
  /** Buffers an early request; true means START was already chosen and SIGTERM is needed. */
  readonly cancel: () => boolean;
  /** Contains a child error/close or a forced host exit before the gate completes. */
  readonly abort: () => void;
}

/** A single bounded frame; no control bytes reach the CLI's stdout or stderr. */
export function createGuiStartupGate(pipe: Duplex | undefined, token: string): GuiStartupGate {
  let cancelled = false;
  let decision: 'START' | 'CANCEL' | undefined;
  let settled = false;
  let received = Buffer.alloc(0);
  let resolveCompletion = (): void => undefined;
  let rejectCompletion = (_error: Error): void => undefined;
  const completion = new Promise<void>((resolve, reject) => {
    resolveCompletion = resolve;
    rejectCompletion = reject;
  });
  const expected = Buffer.from(`READY ${token}\n`, 'ascii');
  const ignoreLateError = (): void => undefined;
  const cleanup = (): void => {
    clearTimeout(deadline);
    if (pipe === undefined) return;
    pipe.off('data', onData);
    pipe.off('end', fail);
    pipe.off('close', fail);
    // destroy() can finish asynchronously. Retain an error owner until its close event.
    pipe.on('error', ignoreLateError);
    pipe.off('error', fail);
    if (pipe.closed) pipe.off('error', ignoreLateError);
    else pipe.once('close', () => pipe.off('error', ignoreLateError));
    pipe.destroy();
  };
  const fail = (): void => {
    if (settled) return;
    settled = true;
    cleanup();
    rejectCompletion(
      decision !== undefined
        ? new ExitWithCode(70)
        : cancelled
          ? new CancelledError('cancelled before the GUI shell started')
          : new UsageError(
              'the GUI shell did not become ready within its startup gate — run: rune gui install',
            ),
    );
  };
  const onData = (chunk: unknown): void => {
    if (settled || decision !== undefined) return;
    if (!Buffer.isBuffer(chunk) || received.length + chunk.length > 128) {
      fail();
      return;
    }
    received = Buffer.concat([received, chunk]);
    if (
      received.length > expected.length ||
      !received.equals(expected.subarray(0, received.length))
    ) {
      fail();
      return;
    }
    if (received.length !== expected.length) return;
    // Ownership changes before this attempt: a partial or failed write can still reach a shell.
    decision = cancelled ? 'CANCEL' : 'START';
    try {
      pipe!.write(`${decision} ${token}\n`, 'ascii', (error?: Error | null) => {
        if (settled) return;
        if (error !== undefined && error !== null) {
          fail();
          return;
        }
        settled = true;
        cleanup();
        resolveCompletion();
      });
    } catch {
      fail();
    }
  };
  const deadline = setTimeout(fail, 10_000);
  if (pipe === undefined) fail();
  else {
    pipe.on('error', fail);
    pipe.on('end', fail);
    pipe.on('close', fail);
    pipe.on('data', onData);
  }
  return {
    completion,
    transferred: () => decision !== undefined,
    cancel: () => {
      cancelled = true;
      return decision === 'START';
    },
    abort: fail,
  };
}
