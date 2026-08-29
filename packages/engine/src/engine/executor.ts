/**
 * Executing a plan (docs/architecture.md §7, stage 5).
 *
 * A sequential walk: at most one step runs at a time, every step reaches exactly one
 * terminal state, and everything a frontend or a file learns about the run comes out of the
 * one event stream — pre-masked, so a secret is gone before anyone can render it.
 */

import { randomUUID } from 'node:crypto';

import { RUNE_VERSION } from '../version.js';
import type { InputState, Resolution } from './inputs.js';
import type { ExecutionPlan, PlannedStep } from './plan.js';
import type { RunEvent, EngineObserver } from './events.js';
import type { SecretRegistry } from './secrets.js';
import { MASK, SecretString } from './secrets.js';
import { CancelToken } from './cancel.js';
import type { StepState } from './state.js';
import { SpawnRunner } from '../runners/spawnRunner.js';
import type { Runner } from '../runners/base.js';
import {
  RESULT_SCHEMA_VERSION,
  type ResultInput,
  type ResultStep,
  type RunResult,
  type RunStatus,
} from '../results/model.js';

/** How many lines of a failed step's output the result file keeps (§7). */
export const OUTPUT_TAIL_LINES = 50;

export interface ExecuteOptions {
  readonly plan: ExecutionPlan;
  readonly resolution: Resolution;
  readonly product: { readonly name: string; readonly version: string };
  readonly secrets: SecretRegistry;
  readonly observer?: EngineObserver;
  readonly cancel?: CancelToken;
  readonly runner?: Runner;
}

/** Runs the plan to its end and reports what happened. Never throws for a failing step. */
export async function executeRun(options: ExecuteOptions): Promise<RunResult> {
  const { plan, secrets } = options;
  const observer = options.observer ?? (() => undefined);
  const cancel = options.cancel ?? new CancelToken();
  const runner = options.runner ?? new SpawnRunner();
  const runId = randomUUID();

  const emit = (event: RunEvent): void => {
    try {
      observer(event);
    } catch {
      // A broken renderer must never corrupt a run (§9.1).
    }
  };

  const startedAt = new Date();
  const steps: ResultStep[] = [];
  let failed = false;
  let wasCancelled = false;

  emit({ kind: 'runStarted', plan });

  for (const [index, step] of plan.steps.entries()) {
    if (step.state === 'SKIPPED') {
      steps.push(finishedStep(step, 'SKIPPED', null, 0, null, null));
      emit({
        kind: 'stepFinished',
        stepId: step.id,
        state: 'SKIPPED',
        exitCode: undefined,
        durationMs: 0,
      });
      continue;
    }

    const abort = cancel.cancelled || (failed && plan.failFast);
    if (abort) {
      steps.push(finishedStep(step, 'NOT_RUN', null, 0, maskArgv(step, secrets), null));
      emit({
        kind: 'stepFinished',
        stepId: step.id,
        state: 'NOT_RUN',
        exitCode: undefined,
        durationMs: 0,
      });
      continue;
    }

    emit({
      kind: 'stepStarted',
      stepId: step.id,
      index,
      total: plan.steps.length,
      title: step.title,
    });

    const tail: { stream: string; line: string }[] = [];
    const stepStart = Date.now();

    const outcome = await runner.run({
      command: step.command,
      extraEnv: { RUNE_RUN_ID: runId, RUNE_STEP_ID: step.id },
      cancel,
      onOutput: (stream, rawLine) => {
        const line = secrets.mask(rawLine);
        tail.push({ stream, line });
        if (tail.length > OUTPUT_TAIL_LINES) {
          tail.shift();
        }
        emit({ kind: 'stepOutput', stepId: step.id, stream, line });
      },
    });

    const durationMs = Date.now() - stepStart;
    let state: StepState;
    let exitCode: number | null = null;

    switch (outcome.kind) {
      case 'exited':
        exitCode = outcome.exitCode;
        state = step.command.successExitCodes.includes(outcome.exitCode) ? 'SUCCEEDED' : 'FAILED';
        break;
      case 'timedOut': {
        state = 'FAILED';
        const line = `step "${step.id}" exceeded its timeout of ${step.command.timeoutSeconds} seconds`;
        emit({ kind: 'stepOutput', stepId: step.id, stream: 'stderr', line });
        tail.push({ stream: 'stderr', line });
        break;
      }
      case 'cancelled':
        state = 'CANCELLED';
        break;
      case 'failedToStart': {
        state = 'FAILED';
        const line = `step "${step.id}" could not be started: ${secrets.mask(outcome.message)}`;
        emit({ kind: 'stepOutput', stepId: step.id, stream: 'stderr', line });
        tail.push({ stream: 'stderr', line });
        break;
      }
    }

    if (state === 'FAILED') {
      failed = true;
    }
    if (state === 'CANCELLED') {
      wasCancelled = true;
    }

    steps.push(
      finishedStep(
        step,
        state,
        exitCode,
        durationMs,
        maskArgv(step, secrets),
        state === 'FAILED' ? tail : null,
      ),
    );
    emit({
      kind: 'stepFinished',
      stepId: step.id,
      state,
      exitCode: exitCode ?? undefined,
      durationMs,
    });
  }

  const finishedAt = new Date();
  const result = assembleResult({
    plan,
    resolution: options.resolution,
    product: options.product,
    steps,
    status: wasCancelled || cancel.cancelled ? 'cancelled' : failed ? 'failed' : 'succeeded',
    dryRun: false,
    startedAt,
    finishedAt,
  });

  emit({ kind: 'runFinished', result });
  return result;
}

/** The result of a dry-run: the plan described, nothing executed (§10, status `planned`). */
export function describePlan(options: {
  readonly plan: ExecutionPlan;
  readonly resolution: Resolution;
  readonly product: { readonly name: string; readonly version: string };
  readonly secrets: SecretRegistry;
}): RunResult {
  const now = new Date();
  const steps = options.plan.steps.map((step): ResultStep => {
    if (step.state === 'SKIPPED') {
      return finishedStep(step, 'SKIPPED', null, 0, null, null);
    }
    return finishedStep(step, 'PENDING', null, 0, maskArgv(step, options.secrets), null);
  });

  return assembleResult({
    plan: options.plan,
    resolution: options.resolution,
    product: options.product,
    steps,
    status: 'planned',
    dryRun: true,
    startedAt: now,
    finishedAt: now,
  });
}

const STATUS_EXIT_CODES: Readonly<Record<RunStatus, number>> = {
  succeeded: 0,
  planned: 0,
  failed: 1,
  cancelled: 6,
};

function assembleResult(input: {
  readonly plan: ExecutionPlan;
  readonly resolution: Resolution;
  readonly product: { readonly name: string; readonly version: string };
  readonly steps: readonly ResultStep[];
  readonly status: RunStatus;
  readonly dryRun: boolean;
  readonly startedAt: Date;
  readonly finishedAt: Date;
}): RunResult {
  const { steps } = input;
  const count = (state: StepState): number => steps.filter((step) => step.state === state).length;
  const executed = count('SUCCEEDED') + count('FAILED') + count('CANCELLED');

  return {
    resultSchemaVersion: RESULT_SCHEMA_VERSION,
    status: input.status,
    exitCode: STATUS_EXIT_CODES[input.status],
    dryRun: input.dryRun,
    crossPlatformPreview: input.plan.preview,
    platform: input.plan.platform,
    startedAt: input.startedAt.toISOString(),
    finishedAt: input.finishedAt.toISOString(),
    durationMs: input.finishedAt.getTime() - input.startedAt.getTime(),
    runeVersion: RUNE_VERSION,
    product: input.product,
    manifestPath: input.plan.manifestPath,
    stepsTotal: steps.length,
    stepsExecuted: executed,
    stepsSucceeded: count('SUCCEEDED'),
    stepsFailed: count('FAILED'),
    stepsCancelled: count('CANCELLED'),
    stepsSkipped: count('SKIPPED'),
    stepsNotRun: count('NOT_RUN') + count('PENDING'),
    nothingExecuted: executed === 0,
    inputs: input.resolution.inputs.map(resultInput),
    steps,
  };
}

function resultInput(state: InputState): ResultInput {
  const handler = state.spec.type === 'secret';
  const value = state.value;

  return {
    id: state.id,
    value: handler || value instanceof SecretString ? null : (value ?? null),
    source: state.source ?? null,
    secret: handler,
    enabled: state.enabled,
    ignored: state.ignored === undefined ? null : 'input disabled',
  };
}

function finishedStep(
  step: PlannedStep,
  state: StepState,
  exitCode: number | null,
  durationMs: number,
  command: readonly string[] | null,
  outputTail: readonly { stream: string; line: string }[] | null,
): ResultStep {
  return {
    id: step.id,
    title: step.title,
    state,
    exitCode,
    durationMs,
    command,
    skipReason: step.state === 'SKIPPED' ? step.skipReason : null,
    outputTail,
  };
}

function maskArgv(step: PlannedStep, secrets: SecretRegistry): readonly string[] | null {
  if (step.state !== 'PENDING') {
    return null;
  }
  return step.command.argv.map((entry) =>
    entry instanceof SecretString ? MASK : secrets.mask(entry),
  );
}
