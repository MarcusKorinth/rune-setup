/**
 * Projects plan inputs, steps, and errors into result snapshots (docs/architecture.md §10).
 * Callers decide execution outcomes; these functions preserve machine fields, mask display
 * values, and construct the shared planned/executed result shape without running any step.
 */

import { randomUUID } from 'node:crypto';

import { InternalError, type RuneError } from '../errors.js';
import { formatDiagnostic, formatDiagnosticRecords } from '../diagnostics.js';
import { RUNE_VERSION } from '../version.js';
import {
  executionContextFor,
  type ExecutionPlan,
  type PlanExecutionContext,
  type PlanInput,
  type PlannedStep,
} from '../engine/plan.js';
import { deepFreeze } from '../engine/freeze.js';
import {
  isSecretString,
  MASK,
  projectStructuredString,
  type SecretMasker,
  type SecretString,
} from '../engine/secrets.js';
import type { StepState } from '../engine/state.js';
import {
  EXIT_CODE_BY_STATUS,
  RESULT_SCHEMA_VERSION,
  type ResultInput,
  type ResultError,
  type ResultOutputLine,
  type ResultStep,
  type RunResult,
  type RunMode,
  type RunOutcome,
} from './model.js';

/** The result of a dry-run: the plan described, nothing executed (§10, status `planned`). */
export function describePlan(options: {
  readonly plan: ExecutionPlan;
  readonly mode: RunMode;
}): RunResult {
  const executionContext = executionContextFor(options.plan);
  const now = new Date();
  const steps = options.plan.steps.map((step): ResultStep => {
    if (step.state === 'SKIPPED') {
      return skippedResultStep(step, executionContext.secrets);
    }
    return commandResultStep(step, 'PENDING', null, 0, [], executionContext.secrets);
  });

  return assembleResult({
    runId: randomUUID(),
    plan: options.plan,
    mode: options.mode,
    executionContext,
    steps,
    outcome: {
      status: 'planned',
      exitCode: EXIT_CODE_BY_STATUS.planned,
      dryRun: true,
      error: null,
    },
    startedAt: now,
    finishedAt: now,
    durationMs: 0,
  });
}

export function toResultError(error: RuneError, secrets: SecretMasker): ResultError {
  const code = error.code;
  const message = error.message;
  const location = error.location;
  return {
    code: code as ResultError['code'],
    message: formatDiagnosticRecords(
      message.split('\n').map((record) => [record]),
      secrets,
    ),
    location:
      location === undefined
        ? null
        : {
            file: formatDiagnostic([location.file], secrets),
            line: location.line,
            column: location.column,
          },
  };
}

export function assembleResult(input: {
  readonly runId: string;
  readonly plan: ExecutionPlan;
  readonly mode: RunMode;
  readonly executionContext: PlanExecutionContext;
  readonly steps: readonly ResultStep[];
  readonly outcome: RunOutcome;
  readonly startedAt: Date;
  readonly finishedAt: Date;
  readonly durationMs: number;
}): RunResult {
  const { steps } = input;
  const count = (state: StepState): number => steps.filter((step) => step.state === state).length;
  const executed = count('SUCCEEDED') + count('FAILED') + count('CANCELLED');

  return deepFreeze({
    resultSchemaVersion: RESULT_SCHEMA_VERSION,
    id: input.runId,
    ...input.outcome,
    mode: input.mode,
    crossPlatformPreview: input.plan.preview,
    platform: input.plan.platform,
    locale: input.plan.locale,
    startedAt: input.startedAt.toISOString(),
    finishedAt: input.finishedAt.toISOString(),
    durationMs: input.durationMs,
    runeVersion: RUNE_VERSION,
    product: input.executionContext.product,
    manifest: input.executionContext.manifest,
    stepsTotal: steps.length,
    stepsExecuted: executed,
    stepsSucceeded: count('SUCCEEDED'),
    stepsFailed: count('FAILED'),
    stepsCancelled: count('CANCELLED'),
    stepsSkipped: count('SKIPPED'),
    stepsNotRun: count('NOT_RUN') + count('PENDING'),
    nothingExecuted: executed === 0,
    inputs: input.plan.resolvedInputs.map((state) =>
      resultInput(state, input.executionContext.secrets),
    ),
    steps,
  });
}

export function resultInput(state: PlanInput, secrets: SecretMasker): ResultInput {
  const value = state.value;
  if (state.enabled) {
    const common = { id: state.id, source: state.source ?? null, enabled: true as const };
    return state.secret || isSecretString(value)
      ? { ...common, value: null, secret: true }
      : { ...common, value: maskInputValue(value, secrets), secret: false };
  }

  if (state.ignored === undefined) {
    const common = {
      id: state.id,
      source: null,
      enabled: false as const,
    };
    return state.secret || isSecretString(value)
      ? { ...common, value: null, secret: true }
      : { ...common, value: maskInputValue(value, secrets), secret: false };
  }

  if (state.ignored === 'default') {
    throw new InternalError('invalid disabled input provenance');
  }

  // A disabled input's discarded layer is its audit provenance (§5, §10).
  const common = {
    id: state.id,
    source: state.ignored,
    enabled: false as const,
    ignored: 'input disabled' as const,
  };
  return state.secret || isSecretString(value)
    ? { ...common, value: null, secret: true }
    : { ...common, value: maskInputValue(value, secrets), secret: false };
}

export function skippedResultStep(
  step: Extract<PlannedStep, { readonly state: 'SKIPPED' }>,
  secrets: SecretMasker,
): ResultStep {
  return {
    id: step.id,
    title: projectStructuredString(step.title, secrets),
    state: 'SKIPPED',
    exitCode: null,
    durationMs: 0,
    command: null,
    skipReason: projectStructuredString(step.skipReason, secrets),
  };
}

export function commandResultStep(
  step: Extract<PlannedStep, { readonly state: 'PENDING' }>,
  state: 'PENDING' | 'SUCCEEDED' | 'FAILED' | 'CANCELLED' | 'NOT_RUN',
  exitCode: number | null,
  durationMs: number,
  outputTail: readonly ResultOutputLine[],
  secrets: SecretMasker,
): ResultStep {
  const command = maskArgv(step, secrets);
  const identity = {
    id: step.id,
    title: projectStructuredString(step.title, secrets),
    durationMs,
    command,
    skipReason: null,
  };

  switch (state) {
    case 'PENDING':
    case 'CANCELLED':
    case 'NOT_RUN': {
      if (exitCode !== null) {
        throw new InternalError('the executor produced contradictory result step fields');
      }
      return {
        ...identity,
        state,
        exitCode,
      };
    }
    case 'SUCCEEDED': {
      if (exitCode === null) {
        throw new InternalError('the executor produced contradictory result step fields');
      }
      return {
        ...identity,
        state,
        exitCode,
      };
    }
    case 'FAILED':
      return {
        ...identity,
        state,
        exitCode,
        outputTail,
      };
  }
}

export function maskInputValue(
  value: string | boolean | readonly string[],
  secrets: SecretMasker,
): string | boolean | readonly string[] {
  if (typeof value === 'string') {
    return projectStructuredString(value, secrets);
  }
  if (Array.isArray(value)) {
    return value.map((entry) => projectStructuredString(entry, secrets));
  }
  return value;
}

function maskCommandValue(value: string | SecretString, secrets: SecretMasker): string {
  return isSecretString(value) ? MASK : projectStructuredString(value, secrets);
}

function maskArgv(
  step: Extract<PlannedStep, { readonly state: 'PENDING' }>,
  secrets: SecretMasker,
): readonly string[] {
  return step.command.argv.map((entry) => maskCommandValue(entry, secrets));
}
