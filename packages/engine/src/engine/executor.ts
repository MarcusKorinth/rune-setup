/**
 * Executing a plan (docs/architecture.md §7, stage 5).
 *
 * A sequential walk: at most one step runs at a time, every step reaches exactly one
 * terminal state, and everything a frontend or a file learns about the run comes out of the
 * one event stream. `RunStarted` carries the opaque execution plan itself; fields intended
 * for rendering are masked before they reach their sink.
 */

import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';

import {
  CancelledError,
  ConditionError,
  ExecutionError,
  InputError,
  InternalError,
  ManifestError,
  ResolutionError,
  type RuneError,
} from '../errors.js';
import { environmentName } from '../manifest/v1/rules.js';
import { manifestDescriptorFor, type Manifest } from '../manifest/index.js';
import { RUNE_VERSION } from '../version.js';
import {
  executionContextFor,
  type ExecutionPlan,
  type PlanExecutionContext,
  type PlanInput,
  type PlannedStep,
} from './plan.js';
import { hostPlatform, type Platform } from './context.js';
import type { InputState } from './inputs.js';
import type { EngineObserver, RunEvent, StepFinished } from './events.js';
import { deepFreeze } from './freeze.js';
import {
  isSecretString,
  MASK,
  MASK_FOR_SINK,
  type SecretMasker,
  type SecretString,
} from './secrets.js';
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
  RESULT_SCHEMA_VERSION,
  type ResultInput,
  type ResultError,
  type ResultOutputLine,
  type ResultStep,
  type RunResult,
  type RunMode,
  type RunOutcome,
} from '../results/model.js';

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

/** Opened-session context used to build honest results for failures before a plan exists. */
export interface FailureResultSession {
  readonly manifest: Manifest;
  readonly mode: RunMode;
  readonly platform: Platform;
  readonly preview: boolean;
  allInputs(): readonly InputState[];
  getStrings(): { readonly locale: string | undefined };
  /** Engine-internal masking capability; the symbol is not part of the package root API. */
  [MASK_FOR_SINK](text: string): string;
}

export interface FailureResultOptions {
  readonly error: RuneError;
  readonly manifestPath: string;
  readonly dryRun: boolean;
  readonly mode?: RunMode;
  readonly platform?: Platform;
  readonly session?: FailureResultSession;
  /** A completed plan is retained only for failures after planning, such as log I/O. */
  readonly plan?: ExecutionPlan;
}

const openFailureContexts = new WeakMap<RuneError, FailureResultSession>();

/** Package-internal handoff for a Session.open failure after manifest validation. */
export function registerOpenFailureContext(error: RuneError, context: FailureResultSession): void {
  openFailureContexts.set(error, context);
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

  const emit = (event: RunEvent): void => {
    try {
      const returned = (observer as (event: RunEvent) => unknown)(deepFreeze(event));
      if (returned instanceof Promise) {
        void returned.then(undefined, () => undefined);
      }
    } catch {
      // A broken renderer must never corrupt a run (§9.1).
    }
  };

  const startedAt = new Date();
  const runStartedAt = performance.now();
  const steps: ResultStep[] = [];
  let failed = false;
  let wasCancelled = false;
  let fatalTerminationFailure = false;
  let fatalInternalError: InternalError | undefined;

  const parentEnv = snapshotParentEnvironment(
    options.environment ?? process.env,
    plan.resolvedInputs.map((input) => input.id),
    process.platform,
  );
  emit({ kind: 'runStarted', plan });
  wasCancelled = cancel.isCancelled;

  for (const [index, step] of plan.steps.entries()) {
    if (step.state === 'SKIPPED') {
      steps.push(skippedResultStep(step, secrets));
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
      emit({
        kind: 'stepFinished',
        stepId: step.id,
        state,
        exitCode: undefined,
        durationMs: 0,
      });
      continue;
    }

    let state = transitionStepState(step.state, 'RUNNING');

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
    const stepStartedAt = performance.now();

    let acceptingOutput = true;
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
            return { kind: 'failedToStart', reason: 'other' } as const;
          },
        );
    } catch {
      acceptingOutput = false;
      outcome = { kind: 'failedToStart', reason: 'other' };
    }

    const durationMs = Math.max(0, performance.now() - stepStartedAt);
    let terminalState: 'SUCCEEDED' | 'FAILED' | 'CANCELLED';
    let exitCode: number | null = null;
    let diagnostic: string | undefined;

    if (!isSpawnOutcome(outcome)) {
      terminalState = 'FAILED';
      fatalInternalError = new InternalError(
        `runner returned an invalid outcome for step "${step.id}"`,
      );
      diagnostic = `RUNE-500 runner returned an invalid outcome for step "${step.id}"`;
    } else {
      switch (outcome.kind) {
        case 'exited': {
          exitCode = outcome.exitCode;
          terminalState = step.command.successExitCodes.includes(outcome.exitCode)
            ? 'SUCCEEDED'
            : 'FAILED';
          if (terminalState === 'FAILED') {
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
      const maskedDiagnostic = secrets.mask(diagnostic);
      const line =
        Buffer.byteLength(maskedDiagnostic, 'utf8') > MAX_OUTPUT_LINE_BYTES
          ? OVERSIZED_OUTPUT_LINE_PLACEHOLDER
          : maskedDiagnostic;
      keepInTail('stderr', line);
      emit({ kind: 'stepOutput', stepId: step.id, stream: 'stderr', line });
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
    emit(finishedStepEvent(step.id, state, exitCode, durationMs));
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

  emit({ kind: 'runFinished', result });
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

/** Builds the machine-readable outcome for a run-owned failure outside normal execution. */
export function createFailureResult(options: FailureResultOptions): RunResult {
  const session = options.session ?? openFailureContexts.get(options.error);
  const executionContext =
    options.plan === undefined ? undefined : executionContextFor(options.plan);

  if (options.plan !== undefined && session === undefined) {
    throw new InternalError('a failure result with a plan requires its opened session');
  }
  if (
    options.plan !== undefined &&
    options.error instanceof ExecutionError &&
    options.error.code !== 'RUNE-406'
  ) {
    throw new InternalError('a pre-execution failure result cannot carry a completed plan');
  }

  const secrets =
    executionContext?.secrets ??
    (session === undefined
      ? IDENTITY_MASKER
      : Object.freeze({ mask: (text: string): string => session[MASK_FOR_SINK](text) }));
  const outcome = failureOutcome(options.error, options.dryRun, secrets);
  if (
    session === undefined &&
    outcome.status !== 'config_error' &&
    outcome.status !== 'internal_error'
  ) {
    throw new InternalError('a post-validation failure result requires opened-session context');
  }

  const platform =
    options.plan?.platform ?? session?.platform ?? options.platform ?? hostPlatform();
  const preview = options.plan?.preview ?? session?.preview ?? platform !== hostPlatform();
  const source = failureSource(
    options.manifestPath,
    options.plan,
    executionContext,
    session,
    secrets,
  );
  const steps = failureSteps(options.plan, options.dryRun, secrets);
  const now = new Date();

  return assembleFailureResult({
    runId: randomUUID(),
    mode: session?.mode ?? options.mode ?? 'non-interactive',
    platform,
    preview,
    locale: options.plan?.locale ?? session?.getStrings().locale ?? null,
    source,
    steps,
    outcome,
    startedAt: now,
    finishedAt: now,
    durationMs: 0,
  });
}

/**
 * Reclassifies a completed execution when its engine-owned log sink fails, or preserves the
 * executor's topology while surfacing a fatal internal error. No step history is invented.
 */
export function createCompletedRunFailureResult(error: RuneError, completed: RunResult): RunResult {
  let outcome: RunOutcome;
  if (error instanceof ExecutionError && error.code === 'RUNE-406') {
    if (completed.dryRun) {
      throw new InternalError('a log finalization failure cannot reclassify a dry-run result');
    }
    outcome = {
      status: 'failed',
      exitCode: EXIT_CODE_BY_STATUS.failed,
      dryRun: false,
      error: toResultError(error, IDENTITY_MASKER) as ResultError<'RUNE-406'>,
    };
  } else if (error instanceof InternalError) {
    outcome = {
      status: 'internal_error',
      exitCode: EXIT_CODE_BY_STATUS.internal_error,
      dryRun: completed.dryRun,
      error: toResultError(error, IDENTITY_MASKER) as ResultError<'RUNE-500'>,
    };
  } else {
    throw new InternalError('a completed run can only be reclassified by a log or internal error');
  }

  return deepFreeze({ ...completed, ...outcome }) as RunResult;
}

interface FailureSource {
  readonly product: { readonly name: string; readonly version: string } | null;
  readonly manifest: {
    readonly path: string;
    readonly sha256: string | null;
    readonly schemaVersion: number | null;
  };
  readonly inputs: readonly ResultInput[];
}

function failureSource(
  manifestPath: string,
  plan: ExecutionPlan | undefined,
  executionContext: PlanExecutionContext | undefined,
  session: FailureResultSession | undefined,
  secrets: SecretMasker,
): FailureSource {
  if (plan !== undefined && executionContext !== undefined) {
    return {
      product: executionContext.product,
      manifest: executionContext.manifest,
      inputs: plan.resolvedInputs.map((input) => resultInput(input, secrets)),
    };
  }
  if (session !== undefined) {
    const descriptor = manifestDescriptorFor(session.manifest);
    return {
      product: {
        name: secrets.mask(session.manifest.product.name),
        version: secrets.mask(session.manifest.product.version),
      },
      manifest: {
        path: secrets.mask(descriptor.path),
        sha256: descriptor.sha256,
        schemaVersion: descriptor.schemaVersion,
      },
      inputs: session
        .allInputs()
        .filter((input) => input.value !== undefined)
        .map((input) => sessionResultInput(input, secrets)),
    };
  }
  return {
    product: null,
    manifest: { path: secrets.mask(manifestPath), sha256: null, schemaVersion: null },
    inputs: [],
  };
}

function failureSteps(
  plan: ExecutionPlan | undefined,
  dryRun: boolean,
  secrets: SecretMasker,
): readonly ResultStep[] {
  return (
    plan?.steps.map((step): ResultStep => {
      if (step.state === 'SKIPPED') {
        return skippedResultStep(step, secrets);
      }
      return commandResultStep(step, dryRun ? 'PENDING' : 'NOT_RUN', null, 0, [], secrets);
    }) ?? []
  );
}

function sessionResultInput(state: InputState, secrets: SecretMasker): ResultInput {
  const value = state.value;
  if (value === undefined) {
    throw new InternalError(`input "${state.id}" has no value in a failure result`);
  }
  const secret = state.spec.type === 'secret' || isSecretString(value);

  if (state.enabled) {
    const common = { id: state.id, source: state.source ?? null, enabled: true as const };
    return secret
      ? { ...common, value: null, secret: true }
      : { ...common, value: maskSessionInputValue(value, secrets), secret: false };
  }
  if (state.ignored === undefined) {
    const common = { id: state.id, source: null, enabled: false as const };
    return secret
      ? { ...common, value: null, secret: true }
      : { ...common, value: maskSessionInputValue(value, secrets), secret: false };
  }
  if (state.ignored === 'default') {
    throw new InternalError('invalid disabled input provenance');
  }
  const common = {
    id: state.id,
    source: state.ignored,
    enabled: false as const,
    ignored: 'input disabled' as const,
  };
  return secret
    ? { ...common, value: null, secret: true }
    : { ...common, value: maskSessionInputValue(value, secrets), secret: false };
}

function maskSessionInputValue(
  value: InputState['value'],
  secrets: SecretMasker,
): string | boolean | readonly string[] {
  if (value === undefined || isSecretString(value)) {
    throw new InternalError('a secret or missing value reached a public result input');
  }
  return maskInputValue(value, secrets);
}

function failureOutcome(error: RuneError, dryRun: boolean, secrets: SecretMasker): RunOutcome {
  if (error instanceof ManifestError) {
    return {
      status: 'config_error',
      exitCode: EXIT_CODE_BY_STATUS.config_error,
      dryRun,
      error: toResultError(error, secrets) as ResultError<
        'RUNE-101' | 'RUNE-102' | 'RUNE-103' | 'RUNE-104'
      >,
    };
  }
  if (error instanceof InputError) {
    return {
      status: 'input_error',
      exitCode: EXIT_CODE_BY_STATUS.input_error,
      dryRun,
      error: toResultError(error, secrets) as ResultError<'RUNE-201' | 'RUNE-202' | 'RUNE-203'>,
    };
  }
  if (error instanceof ResolutionError || error instanceof ConditionError) {
    return {
      status: 'resolution_error',
      exitCode: EXIT_CODE_BY_STATUS.resolution_error,
      dryRun,
      error: toResultError(error, secrets) as ResultError<
        'RUNE-301' | 'RUNE-302' | 'RUNE-311' | 'RUNE-312'
      >,
    };
  }
  if (error instanceof CancelledError) {
    return {
      status: 'cancelled',
      exitCode: EXIT_CODE_BY_STATUS.cancelled,
      dryRun,
      error: toResultError(error, secrets) as ResultError<'RUNE-601'>,
    };
  }
  if (error instanceof ExecutionError) {
    if (error.code === 'RUNE-406') {
      if (dryRun) {
        throw new InternalError('a log-file failure cannot belong to a dry-run result');
      }
      return {
        status: 'failed',
        exitCode: EXIT_CODE_BY_STATUS.failed,
        dryRun: false,
        error: toResultError(error, secrets) as ResultError<'RUNE-406'>,
      };
    }
    if (error.code === 'RUNE-401' || error.code === 'RUNE-404' || error.code === 'RUNE-405') {
      return {
        status: 'failed',
        exitCode: EXIT_CODE_BY_STATUS.failed,
        dryRun,
        error: toResultError(error, secrets) as ResultError<'RUNE-401' | 'RUNE-404' | 'RUNE-405'>,
      };
    }
    throw new InternalError('this execution error cannot produce a pre-execution result');
  }
  if (error instanceof InternalError) {
    return {
      status: 'internal_error',
      exitCode: EXIT_CODE_BY_STATUS.internal_error,
      dryRun,
      error: toResultError(error, secrets) as ResultError<'RUNE-500'>,
    };
  }
  throw new InternalError('this RuneError cannot produce a run result');
}

function toResultError(error: RuneError, secrets: SecretMasker): ResultError {
  return {
    code: error.code as ResultError['code'],
    message: secrets.mask(error.message),
    location:
      error.location === undefined
        ? null
        : {
            file: secrets.mask(error.location.file),
            line: error.location.line,
            column: error.location.column,
          },
  };
}

const IDENTITY_MASKER: SecretMasker = Object.freeze({ mask: (text: string): string => text });

function assembleFailureResult(input: {
  readonly runId: string;
  readonly mode: RunMode;
  readonly platform: Platform;
  readonly preview: boolean;
  readonly locale: string | null;
  readonly source: FailureSource;
  readonly steps: readonly ResultStep[];
  readonly outcome: RunOutcome;
  readonly startedAt: Date;
  readonly finishedAt: Date;
  readonly durationMs: number;
}): RunResult {
  const count = (state: StepState): number =>
    input.steps.filter((step) => step.state === state).length;
  const executed = count('SUCCEEDED') + count('FAILED') + count('CANCELLED');
  return deepFreeze({
    resultSchemaVersion: RESULT_SCHEMA_VERSION,
    id: input.runId,
    ...input.outcome,
    mode: input.mode,
    crossPlatformPreview: input.preview,
    platform: input.platform,
    locale: input.locale,
    startedAt: input.startedAt.toISOString(),
    finishedAt: input.finishedAt.toISOString(),
    durationMs: input.durationMs,
    runeVersion: RUNE_VERSION,
    product: input.source.product,
    manifest: input.source.manifest,
    stepsTotal: input.steps.length,
    stepsExecuted: executed,
    stepsSucceeded: count('SUCCEEDED'),
    stepsFailed: count('FAILED'),
    stepsCancelled: count('CANCELLED'),
    stepsSkipped: count('SKIPPED'),
    stepsNotRun: count('NOT_RUN') + count('PENDING'),
    nothingExecuted: executed === 0,
    inputs: input.source.inputs,
    steps: input.steps,
  }) as RunResult;
}

function assembleResult(input: {
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

function resultInput(state: PlanInput, secrets: SecretMasker): ResultInput {
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

function skippedResultStep(
  step: Extract<PlannedStep, { readonly state: 'SKIPPED' }>,
  secrets: SecretMasker,
): ResultStep {
  return {
    id: step.id,
    title: secrets.mask(step.title),
    state: 'SKIPPED',
    exitCode: null,
    durationMs: 0,
    command: null,
    skipReason: secrets.mask(step.skipReason),
  };
}

function commandResultStep(
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
    title: secrets.mask(step.title),
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

function maskInputValue(
  value: string | boolean | readonly string[],
  secrets: SecretMasker,
): string | boolean | readonly string[] {
  if (typeof value === 'string') {
    return secrets.mask(value);
  }
  if (Array.isArray(value)) {
    return value.map((entry) => secrets.mask(entry));
  }
  return value;
}

function maskCommandValue(value: string | SecretString, secrets: SecretMasker): string {
  return isSecretString(value) ? MASK : secrets.mask(value);
}

function maskArgv(
  step: Extract<PlannedStep, { readonly state: 'PENDING' }>,
  secrets: SecretMasker,
): readonly string[] {
  return step.command.argv.map((entry) => maskCommandValue(entry, secrets));
}
