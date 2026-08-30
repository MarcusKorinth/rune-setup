/**
 * The failure-shell result (docs/architecture.md §10): the file a run leaves behind when
 * it never reached execution — a manifest, input, or resolution error, or a cancellation
 * before any plan existed. Both hosts (the CLI and the GUI shell's main process) build it
 * through this one function, so neither re-implements always-on-outcome writing.
 */

import { randomUUID } from 'node:crypto';

import { RUNE_VERSION } from '../version.js';
import type { RunMode, RunResult, RunStatus } from './model.js';

export type FailureExitCode = 1 | 3 | 4 | 5 | 6 | 70;

type FailureStatus = Exclude<RunStatus, 'succeeded' | 'planned'>;

const STATUS_BY_FAILURE_EXIT_CODE = {
  1: 'failed',
  3: 'config_error',
  4: 'input_error',
  5: 'resolution_error',
  6: 'cancelled',
  70: 'internal_error',
} as const satisfies Readonly<Record<FailureExitCode, FailureStatus>>;

export interface FailureResultOptions {
  readonly exitCode: FailureExitCode;
  readonly mode: RunMode;
  readonly manifestPath: string;
  readonly dryRun?: boolean | undefined;
  readonly platform?: string | undefined;
  readonly crossPlatformPreview?: boolean | undefined;
  readonly locale?: string | null | undefined;
  /** The product identity when a manifest was parsed; empty identity says there was none. */
  readonly product?: { readonly name: string; readonly version: string } | undefined;
}

/** Narrows an untyped host value to the closed set that may produce a failure result. */
export function assertFailureExitCode(code: number): asserts code is FailureExitCode {
  if (!Object.hasOwn(STATUS_BY_FAILURE_EXIT_CODE, code)) {
    throw new RangeError(`Unsupported failure exit code: ${code}`);
  }
}

/** The §10 table read backwards: every failing exit code implies exactly one status. */
export function statusForExitCode(code: FailureExitCode): FailureStatus {
  assertFailureExitCode(code);
  return STATUS_BY_FAILURE_EXIT_CODE[code];
}

/** A zero-counter result: honest about the fact that the pipeline refused before a plan. */
export function failureResult(options: FailureResultOptions): RunResult {
  const now = new Date().toISOString();
  const host = process.platform === 'win32' ? 'windows' : 'linux';
  const platform = options.platform ?? host;
  return {
    resultSchemaVersion: 1,
    id: randomUUID(),
    status: statusForExitCode(options.exitCode),
    exitCode: options.exitCode,
    mode: options.mode,
    dryRun: options.dryRun ?? false,
    crossPlatformPreview: options.crossPlatformPreview ?? platform !== host,
    platform,
    locale: options.locale ?? null,
    startedAt: now,
    finishedAt: now,
    durationMs: 0,
    runeVersion: RUNE_VERSION,
    product: options.product ?? { name: '', version: '' },
    manifestPath: options.manifestPath,
    stepsTotal: 0,
    stepsExecuted: 0,
    stepsSucceeded: 0,
    stepsFailed: 0,
    stepsCancelled: 0,
    stepsSkipped: 0,
    stepsNotRun: 0,
    nothingExecuted: true,
    inputs: [],
    steps: [],
  };
}
