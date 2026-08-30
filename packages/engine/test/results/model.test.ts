import { describe, expect, it } from 'vitest';

import { EXIT_CODE_BY_STATUS, type RunResult, type RunStatus } from '../../src/results/model.js';

type ResultBody = Omit<RunResult, 'status' | 'exitCode' | 'dryRun'>;
type WithOutcome<Outcome> = ResultBody & Outcome;
type Assert<Condition extends true> = Condition;
type AssertFalse<Condition extends false> = Condition;
type _AcceptSucceeded = Assert<
  WithOutcome<{ status: 'succeeded'; exitCode: 0; dryRun: false }> extends RunResult ? true : false
>;
type _AcceptPlanned = Assert<
  WithOutcome<{ status: 'planned'; exitCode: 0; dryRun: true }> extends RunResult ? true : false
>;
type _RejectMismatchedExitCode = AssertFalse<
  WithOutcome<{ status: 'succeeded'; exitCode: 70; dryRun: false }> extends RunResult ? true : false
>;
type _RejectMismatchedDryRun = AssertFalse<
  WithOutcome<{ status: 'planned'; exitCode: 0; dryRun: false }> extends RunResult ? true : false
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
