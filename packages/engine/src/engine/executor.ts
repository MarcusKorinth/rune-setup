/**
 * Executing a plan (docs/architecture.md §7, stage 5).
 *
 * A sequential walk: at most one step runs at a time, every step reaches exactly one
 * terminal state, and everything a frontend or a file learns about the run comes out of the
 * one event stream — pre-masked, so a secret is gone before anyone can render it.
 */

import { randomUUID } from 'node:crypto';

import { InternalError } from '../errors.js';
import { RUNE_VERSION } from '../version.js';
import {
  executionContextFor,
  type ExecutionPlan,
  type PlanExecutionContext,
  type PlanInput,
  type PlannedStep,
} from './plan.js';
import type { RunEvent, EngineObserver } from './events.js';
import { deepFreeze } from './freeze.js';
import type { SecretRegistry } from './secrets.js';
import { MASK, SecretString } from './secrets.js';
import { CancelToken } from './cancel.js';
import type { StepState } from './state.js';
import { SpawnRunner } from '../runners/spawnRunner.js';
import type { Runner } from '../runners/base.js';
import {
  EXIT_CODE_BY_STATUS,
  RESULT_SCHEMA_VERSION,
  type ResultInput,
  type ResultOutputLine,
  type ResultStep,
  type RunResult,
  type RunStatus,
} from '../results/model.js';

/** How many lines of a failed step's output the result file keeps (§7). */
export const OUTPUT_TAIL_LINES = 50;

/** Runner failures must not surface exception text that can contain command values. */
const RUNNER_FAILURE_MESSAGE = 'runner failed before reporting an outcome';

export interface ExecuteOptions {
  readonly plan: ExecutionPlan;
  readonly observer?: EngineObserver;
  readonly cancel?: CancelToken;
  readonly runner?: Runner;
}

/** Runs the plan to its end and reports what happened. Never throws for a failing step. */
export async function executeRun(options: ExecuteOptions): Promise<RunResult> {
  const { plan } = options;
  const executionContext = executionContextFor(plan);
  const { secrets } = executionContext;
  if (plan.preview) {
    throw new InternalError(
      'a cross-platform preview plan can only be described, never executed (§6.1)',
    );
  }
  const observer = options.observer ?? (() => undefined);
  const cancel = options.cancel ?? new CancelToken();
  const runner = options.runner ?? new SpawnRunner();
  const runId = randomUUID();

  const emit = (event: RunEvent): void => {
    try {
      observer(deepFreeze(event));
    } catch {
      // A broken renderer must never corrupt a run (§9.1).
    }
  };

  const startedAt = new Date();
  const steps: ResultStep[] = [];
  let failed = false;
  let wasCancelled = false;

  emit({ kind: 'runStarted', plan: planForObserver(plan, secrets) });

  for (const [index, step] of plan.steps.entries()) {
    if (step.state === 'SKIPPED') {
      steps.push(finishedStep(step, 'SKIPPED', null, 0, null, [], secrets));
      emit({
        kind: 'stepFinished',
        stepId: step.id,
        state: 'SKIPPED',
        exitCode: undefined,
        durationMs: 0,
      });
      continue;
    }

    // Once fail-fast has made the rest of the plan unreachable, a later token change
    // cannot cancel work that the engine was no longer going to run. Otherwise, consume
    // cancellation exactly when it prevents a pending step from starting. `wasCancelled`
    // also carries a runner-reported cancellation forward when a custom runner does not
    // own the supplied token.
    const abortForFailure = failed && plan.executionOptions.failFast;
    const abortForCancellation = !abortForFailure && (wasCancelled || cancel.cancelled);
    if (abortForCancellation) {
      wasCancelled = true;
    }
    if (abortForFailure || abortForCancellation) {
      steps.push(finishedStep(step, 'NOT_RUN', null, 0, maskArgv(step, secrets), [], secrets));
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
      title: secrets.mask(step.title),
    });

    const tail: ResultOutputLine[] = [];
    const keepInTail = (stream: ResultOutputLine['stream'], line: string): void => {
      tail.push({ stream, line });
      if (tail.length > OUTPUT_TAIL_LINES) {
        tail.shift();
      }
    };
    const stepStart = Date.now();

    let acceptingOutput = true;
    let outcome: Awaited<ReturnType<Runner['run']>>;
    try {
      outcome = await runner
        .run({
          command: step.command,
          extraEnv: { RUNE_RUN_ID: runId, RUNE_STEP_ID: step.id },
          cancel,
          onOutput: (stream, rawLine) => {
            // Deferring delivery by one microtask lets the runner's settlement handler close
            // this gate before output queued after resolve/reject can reach an engine sink.
            queueMicrotask(() => {
              if (!acceptingOutput) {
                return;
              }
              const line = secrets.mask(rawLine);
              keepInTail(stream, line);
              emit({ kind: 'stepOutput', stepId: step.id, stream, line });
            });
          },
        })
        .then(
          (reportedOutcome) => {
            acceptingOutput = false;
            return reportedOutcome;
          },
          () => {
            acceptingOutput = false;
            return { kind: 'failedToStart', message: RUNNER_FAILURE_MESSAGE } as const;
          },
        );
    } catch {
      acceptingOutput = false;
      outcome = { kind: 'failedToStart', message: RUNNER_FAILURE_MESSAGE };
    }

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
        const line = secrets.mask(
          `step "${step.id}" exceeded its timeout of ${step.command.timeoutSeconds} seconds`,
        );
        emit({ kind: 'stepOutput', stepId: step.id, stream: 'stderr', line });
        keepInTail('stderr', line);
        break;
      }
      case 'cancelled':
        state = 'CANCELLED';
        break;
      case 'failedToStart': {
        state = 'FAILED';
        const line = secrets.mask(`step "${step.id}" could not be started: ${outcome.message}`);
        emit({ kind: 'stepOutput', stepId: step.id, stream: 'stderr', line });
        keepInTail('stderr', line);
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
      finishedStep(step, state, exitCode, durationMs, maskArgv(step, secrets), tail, secrets),
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
    runId,
    plan,
    executionContext,
    steps,
    status: wasCancelled ? 'cancelled' : failed ? 'failed' : 'succeeded',
    dryRun: false,
    startedAt,
    finishedAt,
  });

  emit({ kind: 'runFinished', result });
  return result;
}

/** The result of a dry-run: the plan described, nothing executed (§10, status `planned`). */
export function describePlan(options: { readonly plan: ExecutionPlan }): RunResult {
  const executionContext = executionContextFor(options.plan);
  const now = new Date();
  const steps = options.plan.steps.map((step): ResultStep => {
    if (step.state === 'SKIPPED') {
      return finishedStep(step, 'SKIPPED', null, 0, null, [], executionContext.secrets);
    }
    return finishedStep(
      step,
      'PENDING',
      null,
      0,
      maskArgv(step, executionContext.secrets),
      [],
      executionContext.secrets,
    );
  });

  return assembleResult({
    runId: randomUUID(),
    plan: options.plan,
    executionContext,
    steps,
    status: 'planned',
    dryRun: true,
    startedAt: now,
    finishedAt: now,
  });
}

function assembleResult(input: {
  readonly runId: string;
  readonly plan: ExecutionPlan;
  readonly executionContext: PlanExecutionContext;
  readonly steps: readonly ResultStep[];
  readonly status: RunStatus;
  readonly dryRun: boolean;
  readonly startedAt: Date;
  readonly finishedAt: Date;
}): RunResult {
  const { steps } = input;
  const count = (state: StepState): number => steps.filter((step) => step.state === state).length;
  const executed = count('SUCCEEDED') + count('FAILED') + count('CANCELLED');

  return deepFreeze({
    resultSchemaVersion: RESULT_SCHEMA_VERSION,
    id: input.runId,
    status: input.status,
    exitCode: EXIT_CODE_BY_STATUS[input.status],
    dryRun: input.dryRun,
    crossPlatformPreview: input.plan.preview,
    platform: input.plan.platform,
    startedAt: input.startedAt.toISOString(),
    finishedAt: input.finishedAt.toISOString(),
    durationMs: input.finishedAt.getTime() - input.startedAt.getTime(),
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

function resultInput(state: PlanInput, secrets: SecretRegistry): ResultInput {
  const value = state.value;
  const result = {
    id: state.id,
    value: state.secret || value instanceof SecretString ? null : maskInputValue(value, secrets),
    // A disabled input's discarded value keeps its provenance: the layer that supplied it
    // lives in `ignored`, and the result records it as the source (§5, §10).
    source: state.source ?? state.ignored ?? null,
    secret: state.secret,
    enabled: state.enabled,
  };
  return state.ignored === undefined ? result : { ...result, ignored: 'input disabled' };
}

function finishedStep(
  step: PlannedStep,
  state: StepState,
  exitCode: number | null,
  durationMs: number,
  command: readonly string[] | null,
  outputTail: readonly ResultOutputLine[],
  secrets: SecretRegistry,
): ResultStep {
  const result = {
    id: step.id,
    title: secrets.mask(step.title),
    state,
    exitCode,
    durationMs,
    command,
    skipReason: step.state === 'SKIPPED' ? secrets.mask(step.skipReason) : null,
  };
  return state === 'FAILED' ? { ...result, outputTail } : result;
}

/** A clone-safe projection: observers never receive the opaque values used for spawning. */
function planForObserver(plan: ExecutionPlan, secrets: SecretRegistry): ExecutionPlan {
  return deepFreeze({
    planSchemaVersion: plan.planSchemaVersion,
    manifestPath: plan.manifestPath,
    manifestSha256: plan.manifestSha256,
    platform: plan.platform,
    preview: plan.preview,
    resolvedInputs: plan.resolvedInputs.map((input): PlanInput => ({
      id: input.id,
      value: maskPlanInputValue(input, secrets),
      source: input.source,
      secret: input.secret,
      enabled: input.enabled,
      ignored: input.ignored,
    })),
    executionOptions: {
      failFast: plan.executionOptions.failFast,
      logFile: plan.executionOptions.logFile,
    },
    steps: plan.steps.map((step): PlannedStep => {
      if (step.state === 'SKIPPED') {
        return {
          id: step.id,
          title: secrets.mask(step.title),
          state: step.state,
          skipReason: secrets.mask(step.skipReason),
        };
      }
      return {
        id: step.id,
        title: secrets.mask(step.title),
        state: step.state,
        command: {
          argv: step.command.argv.map((entry) => maskCommandValue(entry, secrets)),
          cwd: maskCommandValue(step.command.cwd, secrets),
          env: Object.fromEntries(
            Object.entries(step.command.env).map(([name, value]) => [
              name,
              maskCommandValue(value, secrets),
            ]),
          ),
          timeoutSeconds: step.command.timeoutSeconds,
          successExitCodes: [...step.command.successExitCodes],
        },
      };
    }),
  });
}

function maskInputValue(
  value: string | boolean | readonly string[],
  secrets: SecretRegistry,
): ResultInput['value'] {
  if (typeof value === 'string') {
    return secrets.mask(value);
  }
  if (Array.isArray(value)) {
    return value.map((entry) => secrets.mask(entry));
  }
  return value;
}

function maskPlanInputValue(input: PlanInput, secrets: SecretRegistry): PlanInput['value'] {
  if (input.secret || input.value instanceof SecretString) {
    return MASK;
  }
  if (typeof input.value === 'string') {
    return secrets.mask(input.value);
  }
  if (Array.isArray(input.value)) {
    return input.value.map((entry) => secrets.mask(entry));
  }
  return input.value;
}

function maskCommandValue(value: string | SecretString, secrets: SecretRegistry): string {
  return value instanceof SecretString ? MASK : secrets.mask(value);
}

function maskArgv(step: PlannedStep, secrets: SecretRegistry): readonly string[] | null {
  if (step.state !== 'PENDING') {
    return null;
  }
  return step.command.argv.map((entry) => maskCommandValue(entry, secrets));
}
