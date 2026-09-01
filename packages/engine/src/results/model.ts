/**
 * The machine-readable result of a run (docs/architecture.md §10).
 *
 * Versioned independently of the manifest schema: a pipeline that parses this file today
 * must still parse it after the engine learns new tricks.
 */

import type { ValueSource } from '../engine/inputs.js';
import type { Platform } from '../engine/context.js';
import {
  EXIT_CODE_BY_RUNE_CODE,
  type ConditionCode,
  type InputCode,
  type Location,
  type ManifestCode,
  type ResolutionCode,
} from '../errors.js';

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
  failed: EXIT_CODE_BY_RUNE_CODE['RUNE-401'],
  config_error: EXIT_CODE_BY_RUNE_CODE['RUNE-101'],
  input_error: EXIT_CODE_BY_RUNE_CODE['RUNE-201'],
  resolution_error: EXIT_CODE_BY_RUNE_CODE['RUNE-301'],
  cancelled: EXIT_CODE_BY_RUNE_CODE['RUNE-601'],
  internal_error: EXIT_CODE_BY_RUNE_CODE['RUNE-500'],
} as const satisfies Readonly<Record<RunStatus, number>>;

type PlanResultErrorCode = 'RUNE-401' | 'RUNE-404' | 'RUNE-405';
export type ResultErrorCode =
  | ManifestCode
  | InputCode
  | ResolutionCode
  | ConditionCode
  | PlanResultErrorCode
  | 'RUNE-500'
  | 'RUNE-601';

/** The single top-level error represented by a result outcome (§10). */
export interface ResultError<Code extends ResultErrorCode = ResultErrorCode> {
  readonly code: Code;
  readonly message: string;
  readonly location: Location | null;
}

/** The status/exit/dry-run combinations permitted by the version-1 result contract (§10). */
export type RunOutcome =
  | {
      readonly status: 'succeeded';
      readonly exitCode: 0;
      readonly dryRun: false;
      readonly error: null;
    }
  | {
      readonly status: 'planned';
      readonly exitCode: 0;
      readonly dryRun: true;
      readonly error: null;
    }
  | {
      readonly status: 'failed';
      readonly exitCode: 1;
      readonly dryRun: false;
      readonly error: null;
    }
  | {
      readonly status: 'failed';
      readonly exitCode: 1;
      readonly dryRun: boolean;
      readonly error: ResultError<PlanResultErrorCode>;
    }
  | {
      readonly status: 'config_error';
      readonly exitCode: 3;
      readonly dryRun: boolean;
      readonly error: ResultError<ManifestCode>;
    }
  | {
      readonly status: 'input_error';
      readonly exitCode: 4;
      readonly dryRun: boolean;
      readonly error: ResultError<InputCode>;
    }
  | {
      readonly status: 'resolution_error';
      readonly exitCode: 5;
      readonly dryRun: boolean;
      readonly error: ResultError<ResolutionCode | ConditionCode>;
    }
  | {
      readonly status: 'cancelled';
      readonly exitCode: 6;
      readonly dryRun: boolean;
      readonly error: ResultError<'RUNE-601'>;
    }
  | {
      readonly status: 'internal_error';
      readonly exitCode: 70;
      readonly dryRun: boolean;
      readonly error: ResultError<'RUNE-500'>;
    };

type ResultInputProvenance =
  | {
      readonly enabled: true;
      readonly source: ValueSource | null;
      readonly ignored?: never;
    }
  | {
      readonly enabled: false;
      readonly source: null;
      readonly ignored?: never;
    }
  | {
      readonly enabled: false;
      readonly source: Exclude<ValueSource, 'default'>;
      /** A layer 2–5 value was discarded because the input is disabled (§10). */
      readonly ignored: 'input disabled';
    };

interface ResultInputBody {
  readonly id: string;
}

/** Secret inputs never carry their value across the result-file sink (§10). */
export type ResultInput = ResultInputBody &
  ResultInputProvenance &
  (
    | { readonly secret: true; readonly value: null }
    | {
        readonly secret: false;
        readonly value: string | boolean | readonly string[];
      }
  );

/** One masked line retained from a failed step's combined output tail (§10). */
export interface ResultOutputLine {
  readonly stream: 'stdout' | 'stderr';
  readonly line: string;
}

interface ResultStepBody {
  readonly id: string;
  readonly title: string;
  readonly durationMs: number;
}

type PendingResultStep = ResultStepBody & {
  readonly state: 'PENDING';
  readonly exitCode: null;
  readonly command: readonly string[];
  readonly skipReason: null;
  readonly outputTail?: never;
};

type SkippedResultStep = ResultStepBody & {
  readonly state: 'SKIPPED';
  readonly exitCode: null;
  readonly command: null;
  readonly skipReason: string;
  readonly outputTail?: never;
};

type SucceededResultStep = ResultStepBody & {
  readonly state: 'SUCCEEDED';
  readonly exitCode: number;
  readonly command: readonly string[];
  readonly skipReason: null;
  readonly outputTail?: never;
};

type FailedResultStep = ResultStepBody & {
  readonly state: 'FAILED';
  readonly exitCode: number | null;
  readonly command: readonly string[];
  readonly skipReason: null;
  /** The last lines of a FAILED step's output, masked — CI triage from one file (§7). */
  readonly outputTail?: readonly ResultOutputLine[];
};

type CancelledResultStep = ResultStepBody & {
  readonly state: 'CANCELLED';
  readonly exitCode: null;
  readonly command: readonly string[];
  readonly skipReason: null;
  readonly outputTail?: never;
};

type NotRunResultStep = ResultStepBody & {
  readonly state: 'NOT_RUN';
  readonly exitCode: null;
  readonly command: readonly string[];
  readonly skipReason: null;
  readonly outputTail?: never;
};

/** A final or planned step representation; an actively RUNNING step is never publishable. */
export type ResultStep =
  | PendingResultStep
  | SkippedResultStep
  | SucceededResultStep
  | FailedResultStep
  | CancelledResultStep
  | NotRunResultStep;

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
  /** Selected locale tag, or `null` for the built-in defaults (§6.3). */
  readonly locale: string | null;
  readonly startedAt: string;
  readonly finishedAt: string;
  readonly durationMs: number;
  readonly runeVersion: string;
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

interface ValidatedResultMetadata {
  readonly product: { readonly name: string; readonly version: string };
  readonly manifest: ResultManifest & {
    readonly sha256: string;
    readonly schemaVersion: number;
  };
}

interface PotentiallyUnvalidatedResultMetadata {
  readonly product: { readonly name: string; readonly version: string } | null;
  readonly manifest: ResultManifest;
}

type PostValidationRunOutcome = Exclude<RunOutcome, { status: 'config_error' | 'internal_error' }>;
type PotentiallyUnvalidatedRunOutcome = Extract<
  RunOutcome,
  { status: 'config_error' | 'internal_error' }
>;

export type RunResult = RunResultBody &
  (
    | (ValidatedResultMetadata & PostValidationRunOutcome)
    | (PotentiallyUnvalidatedResultMetadata & PotentiallyUnvalidatedRunOutcome)
  );
