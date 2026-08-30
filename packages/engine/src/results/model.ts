/**
 * The machine-readable result of a run (docs/architecture.md §10).
 *
 * Versioned independently of the manifest schema: a pipeline that parses this file today
 * must still parse it after the engine learns new tricks.
 */

import type { ValueSource } from '../engine/inputs.js';
import type { Platform } from '../engine/context.js';
import type { StepState } from '../engine/state.js';

export const RESULT_SCHEMA_VERSION = 1;

/** The frontend mode that drove a run (§10). */
export const RUN_MODES = ['gui', 'interactive', 'non-interactive'] as const;
export type RunMode = (typeof RUN_MODES)[number];

/**
 * Every status the result file can carry (§10). The executor produces the first four; the
 * error statuses are written by the session for failures around execution, so the schema
 * is complete from version 1 on.
 */
export const RUN_STATUSES = [
  'succeeded',
  'planned',
  'failed',
  'cancelled',
  'config_error',
  'input_error',
  'resolution_error',
  'internal_error',
] as const;
export type RunStatus = (typeof RUN_STATUSES)[number];

/** The status ↔ exit-code table of §10; values agree with `exitCodeFor` in errors.ts. */
export const EXIT_CODE_BY_STATUS = {
  succeeded: 0,
  planned: 0,
  failed: 1,
  config_error: 3,
  input_error: 4,
  resolution_error: 5,
  cancelled: 6,
  internal_error: 70,
} as const satisfies Readonly<Record<RunStatus, number>>;

type NonzeroRunStatus = Exclude<RunStatus, 'succeeded' | 'planned'>;

/** The status/exit/dry-run combinations permitted by the version-1 result contract (§10). */
export type RunOutcome =
  | { readonly status: 'succeeded'; readonly exitCode: 0; readonly dryRun: false }
  | { readonly status: 'planned'; readonly exitCode: 0; readonly dryRun: true }
  | {
      [Status in NonzeroRunStatus]: {
        readonly status: Status;
        readonly exitCode: (typeof EXIT_CODE_BY_STATUS)[Status];
        readonly dryRun: boolean;
      };
    }[NonzeroRunStatus];

export interface ResultInput {
  readonly id: string;
  /** `null` for a secret, always (§10). */
  readonly value: string | boolean | readonly string[] | null;
  readonly source: ValueSource | null;
  readonly secret: boolean;
  readonly enabled: boolean;
  /** Present only when a supplied value was discarded because the input is disabled (§10). */
  readonly ignored?: 'input disabled';
}

/** One masked line retained from a failed step's combined output tail (§10). */
export interface ResultOutputLine {
  readonly stream: 'stdout' | 'stderr';
  readonly line: string;
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
  readonly outputTail?: readonly ResultOutputLine[];
}

export interface ResultManifest {
  readonly path: string;
  readonly sha256: string | null;
  readonly schemaVersion: number | null;
}

interface RunResultBody {
  readonly resultSchemaVersion: typeof RESULT_SCHEMA_VERSION;
  /** One UUID per run — the same value every child saw as RUNE_RUN_ID (§8, §10). */
  readonly id: string;
  readonly mode: RunMode;
  readonly crossPlatformPreview: boolean;
  readonly platform: Platform;
  readonly locale: string;
  readonly startedAt: string;
  readonly finishedAt: string;
  readonly durationMs: number;
  readonly runeVersion: string;
  readonly product: { readonly name: string; readonly version: string } | null;
  readonly manifest: ResultManifest;
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

export type RunResult = RunResultBody & RunOutcome;
