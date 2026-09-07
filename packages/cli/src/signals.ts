/** Process-signal policy for the CLI (docs/architecture.md §7). */

import { CancelledError, exitCodeFor, type CancelToken } from '@rune/engine';

/** The two process signals the CLI main entry point handles cooperatively. */
export const CLI_CANCELLATION_SIGNALS = ['SIGINT', 'SIGTERM'] as const;
export type CliCancellationSignal = (typeof CLI_CANCELLATION_SIGNALS)[number];

export interface SignalController {
  /** Defaults to SIGINT for readline's signal-free `onInterrupt` callback. */
  readonly handle: (signal?: CliCancellationSignal) => void;
}

/**
 * Either signal requests cooperative cancellation. Only a second SIGINT forces the fixed
 * cancellation exit; repeated SIGTERM remains idempotent. The injected exit function keeps
 * process.exit owned exclusively by main.ts.
 */
export function createSignalController(
  cancel: CancelToken,
  forceExit: (code: number) => void,
): SignalController {
  let receivedSigint = false;
  let forced = false;
  return {
    handle: (signal = 'SIGINT') => {
      cancel.cancel();
      if (signal === 'SIGTERM') {
        return;
      }
      if (receivedSigint && !forced) {
        forced = true;
        forceExit(exitCodeFor(new CancelledError()));
      }
      receivedSigint = true;
    },
  };
}
