import { describe, expect, it } from 'vitest';

import {
  failureResult,
  type FailureExitCode,
  type FailureResultOptions,
} from '../../src/results/failure.js';

const baseOptions = {
  mode: 'non-interactive',
  manifestPath: 'installer.yaml',
} as const;

describe('failureResult', () => {
  it.each([
    [1, 'failed'],
    [3, 'config_error'],
    [4, 'input_error'],
    [5, 'resolution_error'],
    [6, 'cancelled'],
    [70, 'internal_error'],
  ] satisfies readonly (readonly [FailureExitCode, string])[])(
    'maps exit code %i to %s',
    (exitCode, status) => {
      expect(failureResult({ ...baseOptions, exitCode })).toMatchObject({ exitCode, status });
    },
  );

  it.each([0, 2, 99])('rejects unsupported exit code %i', (exitCode) => {
    const buildUnchecked = failureResult as (
      options: Omit<FailureResultOptions, 'exitCode'> & { readonly exitCode: number },
    ) => ReturnType<typeof failureResult>;

    expect(() => buildUnchecked({ ...baseOptions, exitCode })).toThrow(
      new RangeError(`Unsupported failure exit code: ${exitCode}`),
    );
  });
});
