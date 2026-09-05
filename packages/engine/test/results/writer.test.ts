import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, sep } from 'node:path';

import { describe, expect, it } from 'vitest';

import { ExecutionError, InternalError } from '../../src/errors.js';
import type { RunResult } from '../../src/results/model.js';
import { serializeResult, writeResult } from '../../src/results/writer.js';

const RESULT_ID = '123e4567-e89b-42d3-a456-426614174000';
const SECRET_SENTINEL = 'F-064-plaintext-must-never-escape';
const SHA256 = 'a'.repeat(64);

function result(id: string): Extract<RunResult, { status: 'succeeded' }> {
  return {
    resultSchemaVersion: 2,
    id: RESULT_ID,
    status: 'succeeded',
    exitCode: 0,
    mode: 'non-interactive',
    dryRun: false,
    error: null,
    crossPlatformPreview: false,
    platform: 'linux',
    locale: 'en',
    startedAt: '2026-01-01T00:00:00.000Z',
    finishedAt: '2026-01-01T00:00:01.000Z',
    durationMs: 1000,
    runeVersion: '0.1.0',
    product: { name: `Writer test ${id}`, version: '1.0.0' },
    manifest: { path: '/project/installer.yaml', sha256: SHA256, schemaVersion: 1 },
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

function forgedPlaintextSecretResult(id: string): RunResult {
  return {
    ...result(id),
    inputs: [
      {
        id: 'password',
        value: SECRET_SENTINEL,
        source: 'set',
        secret: true,
        enabled: true,
      },
    ],
  } as unknown as RunResult;
}

function forgedDisabledInputProvenanceResult(id: string): RunResult {
  return {
    ...result(id),
    inputs: [
      {
        id: 'disabled',
        value: '',
        source: 'default',
        secret: false,
        enabled: false,
        ignored: 'input disabled',
      },
    ],
  } as unknown as RunResult;
}

function forgedCounterResult(id: string): RunResult {
  return { ...result(id), stepsExecuted: 99 } as RunResult;
}

function forgedCrossPlatformPreviewResult(id: string): RunResult {
  return { ...result(id), crossPlatformPreview: true } as RunResult;
}

function forgedDuplicateInputIdResult(id: string): RunResult {
  return {
    ...result(id),
    inputs: [
      { id: SECRET_SENTINEL, value: 'first', source: 'set', secret: false, enabled: true },
      { id: SECRET_SENTINEL, value: 'second', source: 'set', secret: false, enabled: true },
    ],
  } as unknown as RunResult;
}

function forgedContradictoryStepFieldsResult(id: string): RunResult {
  return {
    ...result(id),
    stepsTotal: 1,
    stepsExecuted: 1,
    stepsSucceeded: 1,
    nothingExecuted: false,
    steps: [
      {
        id: 'successful-step',
        title: 'Successful step',
        state: 'SUCCEEDED',
        exitCode: null,
        durationMs: 1,
        command: ['tool'],
        skipReason: null,
      },
    ],
  } as unknown as RunResult;
}

function forgedSucceededWithFailedStepResult(id: string): RunResult {
  return {
    ...result(id),
    stepsTotal: 1,
    stepsExecuted: 1,
    stepsSucceeded: 0,
    stepsFailed: 1,
    nothingExecuted: false,
    steps: [
      {
        id: 'failed-step',
        title: 'Failed step',
        state: 'FAILED',
        exitCode: 1,
        durationMs: 1,
        command: ['tool'],
        skipReason: null,
      },
    ],
  } as RunResult;
}

function forgedFailedWithoutFailedStepResult(id: string): RunResult {
  return { ...result(id), status: 'failed', exitCode: 1 } as RunResult;
}

function planFailureResult(id: string, dryRun = true): RunResult {
  return {
    ...result(id),
    status: 'failed',
    exitCode: 1,
    dryRun,
    error: { code: 'RUNE-404', message: 'working directory is invalid', location: null },
  };
}

function postValidationResults(id: string): readonly RunResult[] {
  const base = result(id);
  return [
    base,
    {
      ...base,
      status: 'planned',
      exitCode: 0,
      dryRun: true,
      stepsTotal: 0,
      stepsExecuted: 0,
      stepsSucceeded: 0,
      nothingExecuted: true,
      steps: [],
    },
    {
      ...base,
      status: 'failed',
      exitCode: 1,
      stepsTotal: 1,
      stepsExecuted: 1,
      stepsSucceeded: 0,
      stepsFailed: 1,
      nothingExecuted: false,
      steps: [
        {
          id: 'failed-step',
          title: 'Failed step',
          state: 'FAILED',
          exitCode: 1,
          durationMs: 1,
          command: ['tool'],
          skipReason: null,
        },
      ],
    },
    planFailureResult(`${id}-plan`, true),
    {
      ...base,
      status: 'cancelled',
      exitCode: 6,
      error: { code: 'RUNE-601', message: 'cancelled', location: null },
    },
    {
      ...base,
      status: 'input_error',
      exitCode: 4,
      error: { code: 'RUNE-202', message: 'invalid input', location: null },
    },
    {
      ...base,
      status: 'resolution_error',
      exitCode: 5,
      error: { code: 'RUNE-301', message: 'resolution failed', location: null },
    },
  ];
}

function forgedNullablePostValidationResults(id: string): readonly RunResult[] {
  return postValidationResults(id).flatMap((entry) => [
    { ...entry, product: null } as unknown as RunResult,
    {
      ...entry,
      manifest: { ...entry.manifest, sha256: null },
    } as unknown as RunResult,
    {
      ...entry,
      manifest: { ...entry.manifest, schemaVersion: null },
    } as unknown as RunResult,
  ]);
}

function nullableMetadataErrorResults(id: string): readonly RunResult[] {
  const base = result(id);
  const metadata = {
    product: null,
    manifest: { path: '/project/installer.yaml', sha256: null, schemaVersion: null },
  } as const;
  return [
    {
      ...base,
      ...metadata,
      status: 'config_error',
      exitCode: 3,
      error: { code: 'RUNE-103', message: 'invalid manifest', location: null },
    },
    {
      ...base,
      ...metadata,
      status: 'internal_error',
      exitCode: 70,
      error: { code: 'RUNE-500', message: 'internal error', location: null },
    },
  ];
}

function forgedExecutedDryRunResult(id: string): RunResult {
  return {
    ...result(id),
    status: 'internal_error',
    exitCode: 70,
    dryRun: true,
    error: { code: 'RUNE-500', message: 'internal error', location: null },
    stepsTotal: 1,
    stepsExecuted: 1,
    stepsSucceeded: 1,
    nothingExecuted: false,
    steps: [
      {
        id: 'executed-step',
        title: 'Executed step',
        state: 'SUCCEEDED',
        exitCode: 0,
        durationMs: 1,
        command: ['tool'],
        skipReason: null,
      },
    ],
  } as RunResult;
}

function forgedMissingErrorResult(id: string): RunResult {
  const { error: _error, ...withoutError } = {
    ...result(id),
    status: 'config_error' as const,
    exitCode: 3 as const,
  };
  return withoutError as RunResult;
}

function forgedWrongErrorResult(id: string): RunResult {
  return {
    ...result(id),
    status: 'config_error',
    exitCode: 3,
    error: { code: 'RUNE-201', message: 'wrong status', location: null },
  } as unknown as RunResult;
}

function forgedPartialPlanFailureResult(id: string): RunResult {
  return {
    ...planFailureResult(id),
    stepsTotal: 1,
    stepsNotRun: 1,
    steps: [
      {
        id: 'partial-plan',
        title: 'Partial plan',
        state: 'PENDING',
        exitCode: null,
        durationMs: 0,
        command: ['tool'],
        skipReason: null,
      },
    ],
  } as RunResult;
}

function expectGenericResultError(caught: unknown): void {
  expect(caught).toBeInstanceOf(InternalError);
  const error = caught as InternalError;
  expect(error.code).toBe('RUNE-500');
  expect(error.message).toBe(
    'the run result does not match resultSchemaVersion 2 — this is a bug in RUNE, please report it with the manifest that triggered it',
  );
  expect(
    `${error.name}\n${error.message}\n${String(error.cause)}\n${JSON.stringify(error.issues)}`,
  ).not.toContain(SECRET_SENTINEL);
}

function temporaryFiles(directory: string): string[] {
  return readdirSync(directory).filter(
    (name) => name.startsWith('.rune-result-') && name.endsWith('.tmp'),
  );
}

describe('writeResult', () => {
  it('rejects a forged plaintext secret without exposing schema details', () => {
    let caught: unknown;
    try {
      serializeResult(forgedPlaintextSecretResult('invalid-serialization'));
    } catch (error) {
      caught = error;
    }

    expectGenericResultError(caught);
  });

  it('rejects status and step-state contradictions during serialization', () => {
    for (const invalid of [
      forgedSucceededWithFailedStepResult('succeeded-with-failure'),
      forgedFailedWithoutFailedStepResult('failed-without-failure'),
      forgedDisabledInputProvenanceResult('disabled-default'),
    ]) {
      let caught: unknown;
      try {
        serializeResult(invalid);
      } catch (error) {
        caught = error;
      }

      expectGenericResultError(caught);
    }
  });

  it('rejects forged dry-run execution, error, and plan-failure forms', () => {
    for (const invalid of [
      forgedExecutedDryRunResult('executed-dry-run'),
      forgedMissingErrorResult('missing-error'),
      forgedWrongErrorResult('wrong-error'),
      forgedPartialPlanFailureResult('partial-plan'),
      { ...planFailureResult('nonzero-counter'), stepsExecuted: 1 } as RunResult,
    ]) {
      let caught: unknown;
      try {
        serializeResult(invalid);
      } catch (error) {
        caught = error;
      }

      expectGenericResultError(caught);
    }
  });

  it('serializes a valid zero-step plan-time failure', () => {
    const serialized = JSON.parse(serializeResult(planFailureResult('plan-failure'))) as RunResult;

    expect(serialized).toMatchObject({
      status: 'failed',
      exitCode: 1,
      dryRun: true,
      error: { code: 'RUNE-404', location: null },
      stepsTotal: 0,
      stepsExecuted: 0,
      nothingExecuted: true,
      steps: [],
    });
  });

  it('keeps the built-in-default locale as an explicit null field', () => {
    const serialized = JSON.parse(
      serializeResult({ ...result('built-in-locale'), locale: null }),
    ) as RunResult;

    expect(serialized).toHaveProperty('locale', null);
  });

  it('writes nullable metadata for config and internal errors', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'rune-result-writer-'));

    try {
      for (const entry of nullableMetadataErrorResults('nullable-errors')) {
        const destination = join(directory, `${entry.status}.json`);
        await writeResult(entry, destination);

        expect(JSON.parse(readFileSync(destination, 'utf8'))).toMatchObject({
          status: entry.status,
          product: null,
          manifest: { sha256: null, schemaVersion: null },
        });
      }
      expect(temporaryFiles(directory)).toEqual([]);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("serializes the parsed copy without invoking the caller's serialization hooks", () => {
    const original = result('parsed-copy');
    Object.defineProperty(original, 'toJSON', {
      enumerable: false,
      value: () => ({ secret: SECRET_SENTINEL }),
    });

    const serialized = serializeResult(original);

    expect(serialized).not.toContain(SECRET_SENTINEL);
    expect(JSON.parse(serialized)).toMatchObject({
      resultSchemaVersion: 2,
      id: RESULT_ID,
      product: { name: 'Writer test parsed-copy', version: '1.0.0' },
    });
  });

  it('rejects an invalid result before creating its destination directory', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'rune-result-writer-'));
    const destinationDirectory = join(directory, 'must-not-exist');
    const destination = join(destinationDirectory, 'result.json');

    try {
      let caught: unknown;
      try {
        await writeResult(forgedPlaintextSecretResult('invalid-new-target'), destination);
      } catch (error) {
        caught = error;
      }

      expectGenericResultError(caught);
      expect(existsSync(destinationDirectory)).toBe(false);
      expect(existsSync(destination)).toBe(false);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('rejects a semantically contradictory result before performing I/O', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'rune-result-writer-'));
    const destinationDirectory = join(directory, 'must-not-exist');
    const destination = join(destinationDirectory, 'result.json');

    try {
      for (const invalid of [
        forgedCounterResult('invalid-counters'),
        forgedCrossPlatformPreviewResult('cross-platform-without-dry-run'),
        forgedDisabledInputProvenanceResult('invalid-provenance'),
        forgedContradictoryStepFieldsResult('invalid-step-fields'),
        forgedDuplicateInputIdResult('duplicate-input-id'),
      ]) {
        let caught: unknown;
        try {
          await writeResult(invalid, destination);
        } catch (error) {
          caught = error;
        }

        expectGenericResultError(caught);
        expect(existsSync(destinationDirectory)).toBe(false);
        expect(existsSync(destination)).toBe(false);
      }
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('rejects nullable post-validation metadata before performing I/O', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'rune-result-writer-'));
    const destinationDirectory = join(directory, 'must-not-exist');
    const destination = join(destinationDirectory, 'result.json');

    try {
      for (const invalid of forgedNullablePostValidationResults('nullable-post-validation')) {
        let caught: unknown;
        try {
          await writeResult(invalid, destination);
        } catch (error) {
          caught = error;
        }

        expectGenericResultError(caught);
        expect(existsSync(destinationDirectory)).toBe(false);
        expect(existsSync(destination)).toBe(false);
      }
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('rejects a contradictory status before performing I/O', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'rune-result-writer-'));
    const destinationDirectory = join(directory, 'must-not-exist');
    const destination = join(destinationDirectory, 'result.json');

    try {
      let caught: unknown;
      try {
        await writeResult(forgedSucceededWithFailedStepResult('invalid-status'), destination);
      } catch (error) {
        caught = error;
      }

      expectGenericResultError(caught);
      expect(existsSync(destinationDirectory)).toBe(false);
      expect(existsSync(destination)).toBe(false);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('rejects an invalid result without replacing an existing destination', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'rune-result-writer-'));
    const destination = join(directory, 'result.json');

    try {
      writeFileSync(destination, 'preserve this result', 'utf8');

      for (const invalid of [
        forgedPlaintextSecretResult('invalid-existing-target'),
        forgedExecutedDryRunResult('executed-dry-run-existing-target'),
        forgedMissingErrorResult('missing-error-existing-target'),
        forgedWrongErrorResult('wrong-error-existing-target'),
        forgedPartialPlanFailureResult('partial-plan-existing-target'),
        { ...planFailureResult('counter-existing-target'), stepsExecuted: 1 } as RunResult,
        ...forgedNullablePostValidationResults('nullable-existing-target'),
      ]) {
        let caught: unknown;
        try {
          await writeResult(invalid, destination);
        } catch (error) {
          caught = error;
        }

        expectGenericResultError(caught);
        expect(readFileSync(destination, 'utf8')).toBe('preserve this result');
        expect(temporaryFiles(directory)).toEqual([]);
      }
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('creates nested directories and writes the complete newline-terminated serialization', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'rune-result-writer-'));
    const destination = join(directory, 'nested', 'result.json');
    const expected = serializeResult(result('nested'));

    try {
      await writeResult(result('nested'), destination);

      expect(readFileSync(destination, 'utf8')).toBe(expected);
      expect(expected.endsWith('\n')).toBe(true);
      expect(temporaryFiles(join(directory, 'nested'))).toEqual([]);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('atomically replaces an existing destination', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'rune-result-writer-'));
    const destination = join(directory, 'result.json');
    const expected = serializeResult(result('replacement'));

    try {
      writeFileSync(destination, 'stale result', 'utf8');
      await writeResult(result('replacement'), destination);

      expect(readFileSync(destination, 'utf8')).toBe(expected);
      expect(temporaryFiles(directory)).toEqual([]);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it.sequential('anchors a relative destination to the cwd at call time', async () => {
    const firstDirectory = mkdtempSync(join(tmpdir(), 'rune-result-writer-cwd-a-'));
    const secondDirectory = mkdtempSync(join(tmpdir(), 'rune-result-writer-cwd-b-'));
    const originalCwd = process.cwd();
    const relativeDestination = 'result.json';
    const expected = serializeResult(result('original-cwd'));

    try {
      process.chdir(firstDirectory);
      const write = writeResult(result('original-cwd'), relativeDestination);
      process.chdir(secondDirectory);
      await write;

      expect(readFileSync(join(firstDirectory, relativeDestination), 'utf8')).toBe(expected);
      expect(existsSync(join(secondDirectory, relativeDestination))).toBe(false);
      expect(temporaryFiles(firstDirectory)).toEqual([]);
      expect(temporaryFiles(secondDirectory)).toEqual([]);
    } finally {
      process.chdir(originalCwd);
      rmSync(firstDirectory, { recursive: true, force: true });
      rmSync(secondDirectory, { recursive: true, force: true });
    }
  });

  it('serializes concurrent writes to one target and leaves one complete result', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'rune-result-writer-'));
    const destination = join(directory, 'result.json');
    const results = Array.from({ length: 8 }, (_, index) => result(`concurrent-${index}`));

    try {
      await Promise.all(results.map((entry) => writeResult(entry, destination)));

      expect(readFileSync(destination, 'utf8')).toSatisfy((content) =>
        results.some((entry) => content === serializeResult(entry)),
      );
      expect(temporaryFiles(directory)).toEqual([]);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('removes its temporary file when renaming fails', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'rune-result-writer-'));
    const destination = join(directory, 'destination');

    try {
      mkdirSync(destination);

      await expect(writeResult(result('rename-failure'), destination)).rejects.toBeInstanceOf(
        Error,
      );

      expect(temporaryFiles(directory)).toEqual([]);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('reports a destination that is a directory as RUNE-407 without the raw OS message', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'rune-result-writer-'));
    const destination = join(directory, 'destination');

    try {
      mkdirSync(destination);

      const error = await rejectionOf(writeResult(result('directory-destination'), destination));

      expectOperationalResultError(error, 'finalize', destination);
      expect(temporaryFiles(directory)).toEqual([]);
      expect(readdirSync(destination)).toEqual([]);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('reports a parent that is a regular file as RUNE-407 without the raw OS message', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'rune-result-writer-'));
    const blocker = join(directory, 'blocker');
    const destination = join(blocker, 'result.json');

    try {
      writeFileSync(blocker, 'occupied', 'utf8');

      const error = await rejectionOf(writeResult(result('blocked-parent'), destination));

      expectOperationalResultError(error, 'prepare the directory for', destination);
      expect(existsSync(destination)).toBe(false);
      expect(temporaryFiles(directory)).toEqual([]);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  // A host that normalizes the destination itself keeps the spelling its caller supplied, so
  // the diagnostic names the bytes a secret registry can hold (docs/architecture.md §10).
  it('names the announced spelling in a RUNE-407 message', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'rune-result-writer-'));
    const blocker = join(directory, 'blocker');
    const destination = join(blocker, 'result.json');
    const announcement = `${blocker}${sep}.${sep}result.json`;

    try {
      writeFileSync(blocker, 'occupied', 'utf8');

      const error = await rejectionOf(
        writeResult(result('announced-failure'), destination, { announcement }),
      );

      expectOperationalResultError(error, 'prepare the directory for', announcement);
      expect((error as ExecutionError).message).not.toContain(`"${destination}"`);
      expect(existsSync(destination)).toBe(false);
      expect(temporaryFiles(directory)).toEqual([]);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('delivers to the path an announcement never names', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'rune-result-writer-'));
    const destination = join(directory, 'result.json');
    const expected = serializeResult(result('announced-delivery'));

    try {
      await writeResult(result('announced-delivery'), destination, {
        announcement: join(directory, 'announced.json'),
      });

      expect(readFileSync(destination, 'utf8')).toBe(expected);
      expect(existsSync(join(directory, 'announced.json'))).toBe(false);
      expect(temporaryFiles(directory)).toEqual([]);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('names the path when the options carry no announcement', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'rune-result-writer-'));
    const blocker = join(directory, 'blocker');
    const destination = join(blocker, 'result.json');

    try {
      writeFileSync(blocker, 'occupied', 'utf8');

      const error = await rejectionOf(writeResult(result('default-announcement'), destination, {}));

      expectOperationalResultError(error, 'prepare the directory for', destination);
      expect(temporaryFiles(directory)).toEqual([]);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});

async function rejectionOf(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error('expected the promise to reject');
}

/** RUNE-407 names the destination and a fixed errno-derived reason; the OS text stays internal. */
function expectOperationalResultError(caught: unknown, action: string, destination: string): void {
  expect(caught).toBeInstanceOf(ExecutionError);
  const error = caught as ExecutionError;
  expect(error.code).toBe('RUNE-407');
  expect(error.cause).toBeInstanceOf(Error);
  const cause = error.cause as NodeJS.ErrnoException;
  expect(cause.code).toMatch(/^E[A-Z]+$/u);
  expect(error.message).toMatch(
    new RegExp(`^could not ${action} result file "[^"]+": [a-z ]+ [(]${cause.code}[)]$`, 'u'),
  );
  expect(error.message).toContain(`"${destination}"`);
  expect(error.message).not.toContain(cause.message);
  expect(error.message).not.toContain(`${cause.code}:`);
  expect(error.message).not.toContain('.rune-result-');
}
