/**
 * The runner boundary (docs/architecture.md §8, §13).
 *
 * Every step uses the argv-spawn implementation. This interface is an internal execution
 * and test seam; it does not expose public runner injection or secret materialization.
 */

import type { ResolvedCommand } from '../engine/plan.js';
import type { CancelToken } from '../engine/cancel.js';

export interface SpawnRequest {
  readonly command: ResolvedCommand;
  /** One frozen parent-environment snapshot shared by every step in this run. */
  readonly parentEnv: Readonly<Record<string, string | undefined>>;
  /** Reserved variables every child receives (§8). */
  readonly extraEnv: Readonly<Record<string, string>>;
  /**
   * Called once per complete bounded logical line or fixed value-free placeholder, in order;
   * never with artificial raw fragments. Await a returned Promise before the next line
   * or settlement. The caller masks each callback before rendering.
   */
  readonly onOutput: (stream: 'stdout' | 'stderr', line: string) => unknown;
  readonly cancel: CancelToken;
}

/** Closed, value-free startup classification shared by every runner implementation. */
export type StartFailureReason = 'commandNotFound' | 'invalidCwd' | 'shellRequired' | 'other';

export type SpawnOutcome =
  | { readonly kind: 'exited'; readonly exitCode: number }
  | { readonly kind: 'signalled' }
  | { readonly kind: 'timedOut' }
  | { readonly kind: 'cancelled' }
  | { readonly kind: 'terminationFailed' }
  | { readonly kind: 'streamFailed'; readonly stream: 'stdout' | 'stderr' }
  /** The process could not be started; arbitrary platform error text never crosses this seam. */
  | { readonly kind: 'failedToStart'; readonly reason: StartFailureReason };

export interface Runner {
  run(request: SpawnRequest): Promise<SpawnOutcome>;
}
