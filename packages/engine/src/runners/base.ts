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
  /** Called once per line, in order, already split; the caller masks before rendering. */
  readonly onOutput: (stream: 'stdout' | 'stderr', line: string) => void;
  readonly cancel: CancelToken;
}

export type SpawnOutcome =
  | { readonly kind: 'exited'; readonly exitCode: number }
  | { readonly kind: 'timedOut' }
  | { readonly kind: 'cancelled' }
  /** The process could not be started at all — a missing command, an invalid directory. */
  | { readonly kind: 'failedToStart'; readonly message: string };

export interface Runner {
  run(request: SpawnRequest): Promise<SpawnOutcome>;
}
