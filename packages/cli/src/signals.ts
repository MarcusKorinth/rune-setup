/** Process-signal policy for the CLI (docs/architecture.md §7). */

import { CancelledError, exitCodeFor, type CancelToken } from '@rune/engine';

/** The two process signals the CLI main entry point handles cooperatively. */
export const CLI_CANCELLATION_SIGNALS = ['SIGINT', 'SIGTERM'] as const;

export interface SignalController {
  readonly handle: () => void;
}

/**
 * First signal requests cooperative cancellation; the second forces the fixed cancellation
 * exit. The injected exit function keeps process.exit owned exclusively by main.ts.
 */
export function createSignalController(
  cancel: CancelToken,
  forceExit: (code: number) => void,
): SignalController {
  let received = false;
  let forced = false;
  return {
    handle: () => {
      if (!received) {
        received = true;
        cancel.cancel();
        return;
      }
      if (!forced) {
        forced = true;
        forceExit(exitCodeFor(new CancelledError()));
      }
    },
  };
}
