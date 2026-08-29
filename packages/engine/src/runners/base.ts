/**
 * The runner boundary (docs/architecture.md §8, §13).
 *
 * Exactly one implementation exists in the MVP — every step is one argv spawn — but the
 * interface is the seam a later elevated or remote runner would implement.
 */

import type { ResolvedCommand } from '../engine/plan.js';
import type { CancelToken } from '../engine/cancel.js';

export interface SpawnRequest {
  readonly command: ResolvedCommand;
  /** Reserved variables every child receives (§8). */
  readonly extraEnv: Readonly<Record<string, string>>;
  /**
   * Called once per complete bounded logical line or fixed value-free placeholder, in order;
   * never with artificial raw fragments. The caller masks each callback before rendering.
   */
  readonly onOutput: (stream: 'stdout' | 'stderr', line: string) => void;
  readonly cancel: CancelToken;
}

/** Closed, value-free startup classification shared by every runner implementation. */
export type StartFailureReason = 'commandNotFound' | 'invalidCwd' | 'shellRequired' | 'other';

export type SpawnOutcome =
  | { readonly kind: 'exited'; readonly exitCode: number }
  | { readonly kind: 'timedOut' }
  | { readonly kind: 'cancelled' }
  /** The process could not be started; arbitrary platform error text never crosses this seam. */
  | { readonly kind: 'failedToStart'; readonly reason: StartFailureReason };

export interface Runner {
  run(request: SpawnRequest): Promise<SpawnOutcome>;
}
