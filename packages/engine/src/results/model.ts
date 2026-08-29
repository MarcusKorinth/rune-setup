/**
 * The machine-readable result of a run (docs/architecture.md §10).
 *
 * Versioned independently of the manifest schema: a pipeline that parses this file today
 * must still parse it after the engine learns new tricks.
 */

import type { ValueSource } from '../engine/inputs.js';
import type { StepState } from '../engine/state.js';

export const RESULT_SCHEMA_VERSION = 1;

export type RunStatus = 'succeeded' | 'planned' | 'failed' | 'cancelled';

export interface ResultInput {
  readonly id: string;
  /** `null` for a secret, always (§10). */
  readonly value: string | boolean | readonly string[] | null;
  readonly source: ValueSource | null;
  readonly secret: boolean;
  readonly enabled: boolean;
  readonly ignored: string | null;
}

export interface ResultStep {
  readonly id: string;
  readonly title: string;
  readonly state: StepState;
  readonly exitCode: number | null;
  readonly durationMs: number;
  /** The argv as spawned, masked (§10); `null` for a step that never had a command. */
  readonly command: readonly string[] | null;
  readonly skipReason: string | null;
  /** The last lines of a FAILED step's output, masked — CI triage from one file (§7). */
  readonly outputTail: readonly { readonly stream: string; readonly line: string }[] | null;
}

export interface RunResult {
  readonly resultSchemaVersion: typeof RESULT_SCHEMA_VERSION;
  readonly status: RunStatus;
  readonly exitCode: number;
  readonly dryRun: boolean;
  readonly crossPlatformPreview: boolean;
  readonly platform: string;
  readonly startedAt: string;
  readonly finishedAt: string;
  readonly durationMs: number;
  readonly runeVersion: string;
  readonly product: { readonly name: string; readonly version: string };
  readonly manifestPath: string;
  readonly stepsTotal: number;
  readonly stepsExecuted: number;
  readonly stepsSucceeded: number;
  readonly stepsFailed: number;
  readonly stepsCancelled: number;
  readonly stepsSkipped: number;
  readonly stepsNotRun: number;
  /** True iff nothing entered RUNNING — legitimate, but worth a pipeline's attention (§7). */
  readonly nothingExecuted: boolean;
  readonly inputs: readonly ResultInput[];
  readonly steps: readonly ResultStep[];
}
