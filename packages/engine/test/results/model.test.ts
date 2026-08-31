import { describe, expect, it } from 'vitest';

import {
  EXIT_CODE_BY_STATUS,
  type ResultError,
  type RunResult,
  type RunStatus,
} from '../../src/results/model.js';

type ResultBody = Omit<RunResult, 'status' | 'exitCode' | 'dryRun' | 'error'>;
type WithOutcome<Outcome> = ResultBody & Outcome;
type Assert<Condition extends true> = Condition;
type AssertFalse<Condition extends false> = Condition;
type _AcceptSucceeded = Assert<
  WithOutcome<{ status: 'succeeded'; exitCode: 0; dryRun: false; error: null }> extends RunResult
    ? true
    : false
>;
type _AcceptPlanned = Assert<
  WithOutcome<{ status: 'planned'; exitCode: 0; dryRun: true; error: null }> extends RunResult
    ? true
    : false
>;
type _AcceptRuntimeFailed = Assert<
  WithOutcome<{ status: 'failed'; exitCode: 1; dryRun: false; error: null }> extends RunResult
    ? true
    : false
>;
type _AcceptPlanFailedDryRun = Assert<
  WithOutcome<{
    status: 'failed';
    exitCode: 1;
    dryRun: true;
    error: ResultError<'RUNE-404'>;
  }> extends RunResult
    ? true
    : false
>;
type _AcceptPlanFailedRealRun = Assert<
  WithOutcome<{
    status: 'failed';
    exitCode: 1;
    dryRun: false;
    error: ResultError<'RUNE-405'>;
  }> extends RunResult
    ? true
    : false
>;
type _AcceptConfigError = Assert<
  WithOutcome<{
    status: 'config_error';
    exitCode: 3;
    dryRun: true;
    error: ResultError<'RUNE-104'>;
  }> extends RunResult
    ? true
    : false
>;
type _AcceptInputError = Assert<
  WithOutcome<{
    status: 'input_error';
    exitCode: 4;
    dryRun: false;
    error: ResultError<'RUNE-203'>;
  }> extends RunResult
    ? true
    : false
>;
type _AcceptResolutionError = Assert<
  WithOutcome<{
    status: 'resolution_error';
    exitCode: 5;
    dryRun: true;
    error: ResultError<'RUNE-312'>;
  }> extends RunResult
    ? true
    : false
>;
type _AcceptCancelled = Assert<
  WithOutcome<{
    status: 'cancelled';
    exitCode: 6;
    dryRun: false;
    error: ResultError<'RUNE-601'>;
  }> extends RunResult
    ? true
    : false
>;
type _AcceptInternalError = Assert<
  WithOutcome<{
    status: 'internal_error';
    exitCode: 70;
    dryRun: false;
    error: ResultError<'RUNE-500'>;
  }> extends RunResult
    ? true
    : false
>;
type _RejectMismatchedExitCode = AssertFalse<
  WithOutcome<{ status: 'succeeded'; exitCode: 70; dryRun: false; error: null }> extends RunResult
    ? true
    : false
>;
type _RejectMismatchedDryRun = AssertFalse<
  WithOutcome<{ status: 'planned'; exitCode: 0; dryRun: false; error: null }> extends RunResult
    ? true
    : false
>;
type _RejectExecutedDryRunFailure = AssertFalse<
  WithOutcome<{ status: 'failed'; exitCode: 1; dryRun: true; error: null }> extends RunResult
    ? true
    : false
>;
type _RejectSucceededError = AssertFalse<
  WithOutcome<{
    status: 'succeeded';
    exitCode: 0;
    dryRun: false;
    error: ResultError<'RUNE-500'>;
  }> extends RunResult
    ? true
    : false
>;
type _RejectWrongStatusError = AssertFalse<
  WithOutcome<{
    status: 'cancelled';
    exitCode: 6;
    dryRun: false;
    error: ResultError<'RUNE-500'>;
  }> extends RunResult
    ? true
    : false
>;
type _RejectWrongPlanFailureCode = AssertFalse<
  WithOutcome<{
    status: 'failed';
    exitCode: 1;
    dryRun: true;
    error: { code: 'RUNE-402'; message: string; location: null };
  }> extends RunResult
    ? true
    : false
>;

const expectedExitCodes = {
  succeeded: 0,
  planned: 0,
  failed: 1,
  config_error: 3,
  input_error: 4,
  resolution_error: 5,
  cancelled: 6,
  internal_error: 70,
} satisfies Readonly<Record<RunStatus, number>>;

describe('result status exit-code contract', () => {
  it('matches the complete versioned status table', () => {
    expect(EXIT_CODE_BY_STATUS).toEqual(expectedExitCodes);
  });

  it('assigns exit 0 only to succeeded and planned, with unique nonzero codes', () => {
    const entries = Object.entries(EXIT_CODE_BY_STATUS) as [RunStatus, number][];
    const zeroStatuses = entries
      .filter(([, exitCode]) => exitCode === 0)
      .map(([status]) => status)
      .sort();
    const nonzeroCodes = entries
      .filter(([, exitCode]) => exitCode !== 0)
      .map(([, exitCode]) => exitCode);

    expect(zeroStatuses).toEqual(['planned', 'succeeded']);
    expect(new Set(nonzeroCodes).size).toBe(nonzeroCodes.length);
  });
});
