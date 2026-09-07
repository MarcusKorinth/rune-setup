/**
 * Executes one plan sequentially and owns step transitions, cancellation, and event delivery.
 * Result projection is delegated to results/projection; failure provenance belongs to
 * results/failure (docs/architecture.md §§7, 9.1, 10).
 */

import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';

import { InternalError } from '../errors.js';
import { environmentName } from '../manifest/v1/rules.js';
import { executionContextFor, type ExecutionPlan } from './plan.js';
import type { EngineObserver, RunEvent, StepFinished } from './events.js';
import { deepFreeze } from './freeze.js';
import { projectStructuredString } from './secrets.js';
import { CancelToken } from './cancel.js';
import { transitionStepState, type StepState } from './state.js';
import {
  MAX_OUTPUT_LINE_BYTES,
  OVERSIZED_OUTPUT_LINE_PLACEHOLDER,
  SpawnRunner,
} from '../runners/spawnRunner.js';
import type { Runner, SpawnOutcome, StartFailureReason } from '../runners/base.js';
import {
  EXIT_CODE_BY_STATUS,
  type ResultError,
  type ResultOutputLine,
  type ResultStep,
  type RunResult,
  type RunMode,
  type RunOutcome,
} from '../results/model.js';
import {
  assembleResult,
  commandResultStep,
  skippedResultStep,
  toResultError,
} from '../results/projection.js';

/** How many lines of a failed step's output the result file keeps (§7). */
export const OUTPUT_TAIL_LINES = 50;

export interface ExecuteOptions {
  readonly plan: ExecutionPlan;
  readonly mode: RunMode;
  /** Invocation environment to inherit; defaults to process.env at execution start. */
  readonly environment?: Readonly<Record<string, string | undefined>>;
  readonly observer?: EngineObserver;
  readonly cancel?: CancelToken;
  readonly runner?: Runner;
}

/** Captures the inherited environment without manifest input-control variables. */
export function snapshotParentEnvironment(
  environment: Readonly<Record<string, string | undefined>>,
  inputIds: readonly string[],
  platform: NodeJS.Platform,
): Readonly<Record<string, string | undefined>> {
  const comparableName = (name: string): string =>
    platform === 'win32' ? name.toUpperCase() : name;
  const inputEnvironmentNames = new Set(inputIds.map((id) => comparableName(environmentName(id))));
  const inherited = Object.fromEntries(
    Object.entries(environment).filter(
      ([name]) => !inputEnvironmentNames.has(comparableName(name)),
    ),
  );
  return Object.freeze(inherited);
}

/** Runs the plan to its end and reports what happened. Never throws for a failing step. */
export async function executeRun(options: ExecuteOptions): Promise<RunResult> {
  const { plan, mode } = options;
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

  let delivery = Promise.resolve();
  const emit = (event: RunEvent): Promise<void> => {
    delivery = delivery.then(async () => {
      try {
        const returned = observer(deepFreeze(event));
        if (returned instanceof Promise) await returned;
      } catch {
        // A broken renderer must never corrupt a run (§9.1).
      }
    });
    return delivery;
  };

  const startedAt = new Date();
  const runStartedAt = performance.now();
  const steps: ResultStep[] = [];
  let failed = false;
  let fatalTerminationFailure = false;
  let fatalInternalError: InternalError | undefined;

  const parentEnv = snapshotParentEnvironment(
    options.environment ?? process.env,
    plan.resolvedInputs.map((input) => input.id),
    process.platform,
  );
  await emit({ kind: 'runStarted', plan });
  let wasCancelled = cancel.isCancelled;

  for (const [index, step] of plan.steps.entries()) {
    if (step.state === 'SKIPPED') {
      steps.push(skippedResultStep(step, secrets));
      await emit({
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
    const abortForFailure =
      !fatalTerminationFailure &&
      fatalInternalError === undefined &&
      failed &&
      plan.executionOptions.failFast;
    const abortForCancellation =
      !fatalTerminationFailure &&
      fatalInternalError === undefined &&
      !abortForFailure &&
      (wasCancelled || cancel.isCancelled);
    if (abortForCancellation) {
      wasCancelled = true;
    }
    if (
      fatalTerminationFailure ||
      fatalInternalError !== undefined ||
      abortForFailure ||
      abortForCancellation
    ) {
      transitionStepState(step.state, 'NOT_RUN');
      const state = 'NOT_RUN';
      steps.push(commandResultStep(step, state, null, 0, [], secrets));
      await emit({
        kind: 'stepFinished',
        stepId: step.id,
        state,
        exitCode: undefined,
        durationMs: 0,
      });
      continue;
    }

    let state = transitionStepState(step.state, 'RUNNING');

    await emit({
      kind: 'stepStarted',
      stepId: step.id,
      index,
      total: plan.steps.length,
      title: projectStructuredString(step.title, secrets),
    });

    const tail: ResultOutputLine[] = [];
    const keepInTail = (stream: ResultOutputLine['stream'], line: string): void => {
      tail.push({ stream, line });
      if (tail.length > OUTPUT_TAIL_LINES) {
        tail.shift();
      }
    };
    const stepStartedAt = performance.now();

    let acceptingOutput = true;
    let outputContractError: InternalError | undefined;
    let outcome: unknown;
    try {
      outcome = await runner
        .run({
          command: step.command,
          parentEnv,
          extraEnv: { RUNE_RUN_ID: runId, RUNE_STEP_ID: step.id },
          cancel,
          onOutput: (stream, rawLine) => {
            // Deferring delivery by one microtask lets the runner's settlement handler close
            // this gate before output queued after resolve/reject can reach an engine sink.
            return Promise.resolve().then(() => {
              if (!acceptingOutput) {
                return;
              }
              if (
                (stream !== 'stdout' && stream !== 'stderr') ||
                typeof rawLine !== 'string' ||
                rawLine.includes('\n')
              ) {
                acceptingOutput = false;
                outputContractError = new InternalError(
                  `runner emitted an invalid output payload for step "${step.id}"`,
                );
                return;
              }
              const boundedLine =
                Buffer.byteLength(rawLine, 'utf8') > MAX_OUTPUT_LINE_BYTES
                  ? OVERSIZED_OUTPUT_LINE_PLACEHOLDER
                  : rawLine;
              const line = projectStructuredString(boundedLine, secrets);
              keepInTail(stream, line);
              return emit({ kind: 'stepOutput', stepId: step.id, stream, line });
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
            return { kind: 'failedToStart', reason: 'other' } as const;
          },
        );
    } catch {
      acceptingOutput = false;
      outcome = { kind: 'failedToStart', reason: 'other' };
    }

    // Also drain accepted output from custom runners which settle in the same turn.
    await delivery;
    const durationMs = Math.max(0, performance.now() - stepStartedAt);
    let terminalState: 'SUCCEEDED' | 'FAILED' | 'CANCELLED';
    let exitCode: number | null = null;
    let diagnostic: string | undefined;

    if (outputContractError !== undefined) {
      terminalState = 'FAILED';
      fatalInternalError = outputContractError;
      diagnostic = `RUNE-500 runner emitted an invalid output payload for step "${step.id}"`;
    } else if (!isSpawnOutcome(outcome)) {
      terminalState = 'FAILED';
      fatalInternalError = new InternalError(
        `runner returned an invalid outcome for step "${step.id}"`,
      );
      diagnostic = `RUNE-500 runner returned an invalid outcome for step "${step.id}"`;
    } else {
      switch (outcome.kind) {
        case 'exited': {
          if (step.command.successExitCodes.includes(outcome.exitCode)) {
            exitCode = outcome.exitCode;
            terminalState = 'SUCCEEDED';
          } else if (cancel.isCancelled) {
            // A runner that reports a non-success exit after cancellation was requested makes
            // the request the cause (§7); the step takes the shape of a runner-reported
            // cancellation: no exit code, no diagnostic. SpawnRunner never reports one — its
            // kill path owns a requested cancellation and settles cancelled or
            // terminationFailed — so this branch covers a runner that ignores the token, not
            // the Windows console Ctrl+C race (§8).
            terminalState = 'CANCELLED';
          } else {
            exitCode = outcome.exitCode;
            terminalState = 'FAILED';
            diagnostic = `RUNE-401 step "${step.id}" exited with code ${outcome.exitCode}; expected one of [${step.command.successExitCodes.join(', ')}]`;
          }
          break;
        }
        case 'signalled': {
          terminalState = 'FAILED';
          diagnostic = `RUNE-401 step "${step.id}" terminated by a signal`;
          break;
        }
        case 'timedOut': {
          terminalState = 'FAILED';
          diagnostic = `RUNE-402 step "${step.id}" exceeded its timeout of ${step.command.timeoutSeconds} seconds`;
          break;
        }
        case 'cancelled':
          terminalState = 'CANCELLED';
          break;
        case 'terminationFailed': {
          terminalState = 'FAILED';
          fatalTerminationFailure = true;
          diagnostic = `RUNE-401 step "${step.id}" process-tree termination could not be confirmed`;
          break;
        }
        case 'streamFailed': {
          terminalState = 'FAILED';
          diagnostic = `RUNE-401 step "${step.id}" ${outcome.stream} stream could not be read`;
          break;
        }
        case 'failedToStart': {
          terminalState = 'FAILED';
          diagnostic = startFailureDiagnostic(step.id, outcome.reason);
          break;
        }
      }
    }

    if (diagnostic !== undefined) {
      const maskedDiagnostic = projectStructuredString(diagnostic, secrets);
      const line =
        Buffer.byteLength(maskedDiagnostic, 'utf8') > MAX_OUTPUT_LINE_BYTES
          ? OVERSIZED_OUTPUT_LINE_PLACEHOLDER
          : maskedDiagnostic;
      keepInTail('stderr', line);
      await emit({ kind: 'stepOutput', stepId: step.id, stream: 'stderr', line });
    }

    transitionStepState(state, terminalState);
    state = terminalState;

    if (state === 'FAILED') {
      failed = true;
    }
    if (state === 'CANCELLED') {
      wasCancelled = true;
    }

    steps.push(commandResultStep(step, state, exitCode, durationMs, tail, secrets));
    await emit(finishedStepEvent(step.id, state, exitCode, durationMs));
  }

  const finishedAt = new Date();
  const durationMs = Math.max(0, performance.now() - runStartedAt);
  const outcome: RunOutcome =
    fatalInternalError !== undefined
      ? {
          status: 'internal_error',
          exitCode: EXIT_CODE_BY_STATUS.internal_error,
          dryRun: false,
          error: toResultError(fatalInternalError, secrets) as ResultError<'RUNE-500'>,
        }
      : fatalTerminationFailure || failed
        ? { status: 'failed', exitCode: EXIT_CODE_BY_STATUS.failed, dryRun: false, error: null }
        : wasCancelled
          ? {
              status: 'cancelled',
              exitCode: EXIT_CODE_BY_STATUS.cancelled,
              dryRun: false,
              error: {
                code: 'RUNE-601',
                message: 'the run was cancelled',
                location: null,
              },
            }
          : {
              status: 'succeeded',
              exitCode: EXIT_CODE_BY_STATUS.succeeded,
              dryRun: false,
              error: null,
            };
  const result = assembleResult({
    runId,
    plan,
    mode,
    executionContext,
    steps,
    outcome,
    startedAt,
    finishedAt,
    durationMs,
  });

  await emit({ kind: 'runFinished', result });
  if (fatalInternalError !== undefined) {
    throw fatalInternalError;
  }
  return result;
}

/** Runtime check at the public runner seam; extra properties remain intentionally irrelevant. */
function isSpawnOutcome(value: unknown): value is SpawnOutcome {
  if (value === null || typeof value !== 'object') {
    return false;
  }
  const outcome = value as Readonly<Record<string, unknown>>;
  switch (outcome['kind']) {
    case 'exited':
      return typeof outcome['exitCode'] === 'number' && Number.isSafeInteger(outcome['exitCode']);
    case 'signalled':
    case 'timedOut':
    case 'cancelled':
    case 'terminationFailed':
      return true;
    case 'streamFailed':
      return outcome['stream'] === 'stdout' || outcome['stream'] === 'stderr';
    case 'failedToStart':
      return (
        outcome['reason'] === 'commandNotFound' ||
        outcome['reason'] === 'invalidCwd' ||
        outcome['reason'] === 'shellRequired' ||
        outcome['reason'] === 'other'
      );
    default:
      return false;
  }
}

/** Builds a terminal event without allowing executor state and exit code to drift apart. */
function finishedStepEvent(
  stepId: string,
  state: StepState,
  exitCode: number | null,
  durationMs: number,
): StepFinished {
  const identity = { kind: 'stepFinished' as const, stepId, durationMs };

  switch (state) {
    case 'SUCCEEDED':
      if (exitCode !== null) {
        return { ...identity, state, exitCode };
      }
      break;
    case 'FAILED':
      return { ...identity, state, exitCode: exitCode ?? undefined };
    case 'SKIPPED':
    case 'CANCELLED':
    case 'NOT_RUN':
      if (exitCode === null) {
        return { ...identity, state, exitCode: undefined };
      }
      break;
    case 'PENDING':
    case 'RUNNING':
      break;
  }

  throw new InternalError('the executor produced an invalid terminal step event');
}

function startFailureDiagnostic(stepId: string, reason: StartFailureReason): string {
  switch (reason) {
    case 'commandNotFound':
      return `RUNE-403 step "${stepId}" command was not found`;
    case 'invalidCwd':
      return `RUNE-404 step "${stepId}" working directory is invalid`;
    case 'shellRequired':
      return `RUNE-405 step "${stepId}" requires an explicit command interpreter`;
    case 'other':
      return `RUNE-401 step "${stepId}" runner failed while starting the process`;
  }
}
