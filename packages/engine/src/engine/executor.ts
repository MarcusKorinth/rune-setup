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
import { types } from 'node:util';

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
import { formatDiagnostic, formatDiagnosticRecords } from '../diagnostics.js';
import { environmentName } from '../manifest/v1/rules.js';
import { manifestDescriptorFor, type Manifest } from '../manifest/index.js';
import { RUNE_VERSION } from '../version.js';
import {
  executionContextFor,
  planningFailureContextFor,
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
  projectStructuredString,
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

interface FailureResultSessionContext {
  readonly secrets: SecretMasker;
  readonly plan: ExecutionPlan | undefined;
}

const sessionFailureContexts = new WeakMap<FailureResultSession, FailureResultSessionContext>();
const failedPlanningSessionContexts = new WeakSet<FailureResultSessionContext>();

type FailureProjectionKind =
  | 'config_error'
  | 'input_error'
  | 'resolution_error'
  | 'cancelled'
  | 'plan_failure'
  | 'log_failure'
  | 'internal_error';

interface FailureErrorProjection {
  readonly kind: FailureProjectionKind;
  readonly error: ResultError;
}

interface RegisteredSessionFailureError {
  readonly kind: 'session';
  readonly session: FailureResultSession;
  readonly projection: FailureErrorProjection;
  readonly sessionContext?: FailureResultSessionContext;
  readonly openSecrets?: SecretMasker;
  readonly planningSecrets?: SecretMasker;
  readonly failClosedInputValues?: boolean;
}

interface PreManifestFailureContext {
  readonly manifestPath: string;
  readonly mode: RunMode;
  readonly platform: Platform;
  readonly preview: boolean;
  readonly locale: string | null;
}

interface RegisteredPreManifestFailureError {
  readonly kind: 'pre_manifest';
  readonly context: PreManifestFailureContext;
  readonly projection: FailureErrorProjection;
}

type RegisteredFailureError = RegisteredSessionFailureError | RegisteredPreManifestFailureError;

const registeredFailureErrors = new WeakMap<RuneError, RegisteredFailureError>();

/** Package-internal registration for an authentic Session and its current resolution. */
export function registerFailureResultSession(
  session: FailureResultSession,
  secrets: SecretMasker,
  plan?: ExecutionPlan,
): void {
  sessionFailureContexts.set(session, { secrets, plan });
}

/** Package-internal binding for a safe RuneError projection leaving an opened Session. */
export function registerFailureResultError(
  error: RuneError,
  session: FailureResultSession,
  planningError?: RuneError,
): void {
  const sessionContext = sessionFailureContexts.get(session);
  if (sessionContext === undefined) {
    throw new InternalError('a failure error requires an authentic opened Session');
  }
  const planningFailure =
    planningError === undefined ? undefined : planningFailureContextFor(planningError);
  if (planningError !== undefined && planningFailure === undefined) {
    throw new InternalError('a planning failure error requires authentic buildPlan provenance');
  }
  if (planningFailure !== undefined) {
    failedPlanningSessionContexts.add(sessionContext);
  }
  registeredFailureErrors.set(error, {
    kind: 'session',
    session,
    sessionContext,
    projection: snapshotSessionFailureError(error),
    ...(planningFailure === undefined
      ? {}
      : {
          planningSecrets: planningFailure.secrets,
          failClosedInputValues: planningFailure.incompleteSecretRegistration,
        }),
  });
}

/** Package-internal handoff for a Session.open failure after manifest validation. */
export function registerOpenFailureContext(
  error: RuneError,
  context: FailureResultSession,
  secrets: SecretMasker,
): void {
  registeredFailureErrors.set(error, {
    kind: 'session',
    session: context,
    projection: snapshotSessionFailureError(error),
    openSecrets: secrets,
  });
}

/** Package-internal binding for a failure before a validated Manifest exists. */
export function registerPreManifestFailureContext(
  error: RuneError,
  context: PreManifestFailureContext,
): void {
  registeredFailureErrors.set(error, {
    kind: 'pre_manifest',
    context: Object.freeze({ ...context }),
    projection: snapshotSessionFailureError(error),
  });
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
        if (types.isPromise(returned)) await returned;
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
  // Snapshot every caller-controlled option once. In particular, a getter must not supply one
  // error for provenance lookup and a different error for result projection.
  const optionPlan = options.plan;
  const error = options.error;
  const manifestPath = options.manifestPath;
  const dryRun = options.dryRun;
  const optionMode = options.mode;
  const optionPlatform = options.platform;
  const explicitSession = options.session;
  const registeredError = registeredFailureErrors.get(error);
  const registeredPreManifestError =
    registeredError?.kind === 'pre_manifest' ? registeredError : undefined;
  const preManifestContext = registeredPreManifestError?.context;
  const registeredSessionError = registeredError?.kind === 'session' ? registeredError : undefined;
  const plan = preManifestContext === undefined ? optionPlan : undefined;
  const effectiveExplicitSession = preManifestContext === undefined ? explicitSession : undefined;
  const session =
    preManifestContext === undefined
      ? (effectiveExplicitSession ??
        (registeredSessionError?.openSecrets === undefined
          ? undefined
          : registeredSessionError.session))
      : undefined;
  const sessionContext =
    effectiveExplicitSession === undefined
      ? undefined
      : sessionFailureContexts.get(effectiveExplicitSession);
  const sessionSecrets =
    effectiveExplicitSession === undefined
      ? registeredSessionError?.openSecrets
      : sessionContext?.secrets;
  const registeredErrorIsCurrent =
    registeredSessionError !== undefined &&
    registeredSessionError.session === session &&
    (registeredSessionError.openSecrets !== undefined
      ? registeredSessionError.openSecrets === sessionSecrets
      : registeredSessionError.sessionContext === sessionContext);

  if (
    preManifestContext !== undefined &&
    (explicitSession !== undefined || optionPlan !== undefined)
  ) {
    throw new InternalError('a pre-manifest failure result cannot carry session or plan context');
  }
  if (effectiveExplicitSession !== undefined && sessionSecrets === undefined) {
    throw new InternalError('a failure result requires an authentic opened Session');
  }
  if (
    effectiveExplicitSession === undefined &&
    session !== undefined &&
    sessionSecrets === undefined
  ) {
    throw new InternalError('an open failure context requires its secret snapshot');
  }
  if (plan !== undefined && session === undefined) {
    throw new InternalError('a failure result with a plan requires its opened session');
  }
  if (plan !== undefined && sessionContext?.plan !== plan) {
    throw new InternalError('a failure result requires the current plan of its opened Session');
  }
  if (
    plan !== undefined &&
    registeredErrorIsCurrent &&
    registeredSessionError?.projection.kind === 'plan_failure'
  ) {
    throw new InternalError('a pre-execution failure result cannot carry a completed plan');
  }

  const executionContext = plan === undefined ? undefined : executionContextFor(plan);
  const planningSecrets =
    registeredErrorIsCurrent && registeredSessionError !== undefined
      ? registeredSessionError.planningSecrets
      : undefined;
  const secrets = executionContext?.secrets ?? planningSecrets ?? sessionSecrets ?? IDENTITY_MASKER;
  const projection =
    registeredPreManifestError !== undefined
      ? registeredPreManifestError.projection
      : session === undefined
        ? snapshotFailureError(error)
        : registeredErrorIsCurrent && registeredSessionError !== undefined
          ? registeredSessionError.projection
          : registeredSessionError === undefined && error instanceof CancelledError
            ? CANONICAL_CANCELLED_PROJECTION
            : GENERIC_INTERNAL_PROJECTION;
  const failClosedInputValues =
    executionContext === undefined &&
    ((registeredErrorIsCurrent && registeredSessionError?.failClosedInputValues === true) ||
      (projection === GENERIC_INTERNAL_PROJECTION && sessionContext?.plan === undefined) ||
      (sessionContext !== undefined &&
        failedPlanningSessionContexts.has(sessionContext) &&
        planningSecrets === undefined));
  const outcome = failureOutcome(projection, dryRun);
  if (
    session === undefined &&
    preManifestContext === undefined &&
    outcome.status !== 'config_error' &&
    outcome.status !== 'internal_error'
  ) {
    throw new InternalError('a post-validation failure result requires opened-session context');
  }

  const platform =
    preManifestContext?.platform ??
    plan?.platform ??
    session?.platform ??
    optionPlatform ??
    hostPlatform();
  const preview =
    preManifestContext?.preview ?? plan?.preview ?? session?.preview ?? platform !== hostPlatform();
  const source = failureSource(
    preManifestContext?.manifestPath ?? manifestPath,
    plan,
    executionContext,
    session,
    secrets,
    failClosedInputValues,
  );
  const steps = failureSteps(plan, dryRun, secrets);
  const now = new Date();

  return assembleFailureResult({
    runId: randomUUID(),
    mode: preManifestContext?.mode ?? session?.mode ?? optionMode ?? 'non-interactive',
    platform,
    preview,
    locale: preManifestContext?.locale ?? plan?.locale ?? session?.getStrings().locale ?? null,
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
  failClosedInputValues: boolean,
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
        name: session.manifest.product.name,
        version: session.manifest.product.version,
      },
      manifest: {
        path: descriptor.path,
        sha256: descriptor.sha256,
        schemaVersion: descriptor.schemaVersion,
      },
      inputs: session
        .allInputs()
        .filter((input) => input.value !== undefined)
        .map((input) => sessionResultInput(input, secrets, failClosedInputValues)),
    };
  }
  return {
    product: null,
    manifest: {
      path: projectStructuredString(manifestPath, secrets),
      sha256: null,
      schemaVersion: null,
    },
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

function sessionResultInput(
  state: InputState,
  secrets: SecretMasker,
  failClosedInputValues: boolean,
): ResultInput {
  if (state.value === undefined) {
    throw new InternalError(`input "${state.id}" has no value in a failure result`);
  }

  if (state.enabled) {
    const common = { id: state.id, source: state.source ?? null, enabled: true as const };
    if (state.secret) {
      return { ...common, value: null, secret: true };
    }
    return {
      ...common,
      value: maskSessionInputValue(state.value, secrets, failClosedInputValues),
      secret: false,
    };
  }
  if (state.ignored === undefined) {
    const common = { id: state.id, source: null, enabled: false as const };
    if (state.secret) {
      return { ...common, value: null, secret: true };
    }
    return {
      ...common,
      value: maskSessionInputValue(state.value, secrets, failClosedInputValues),
      secret: false,
    };
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
  if (state.secret) {
    return { ...common, value: null, secret: true };
  }
  return {
    ...common,
    value: maskSessionInputValue(state.value, secrets, failClosedInputValues),
    secret: false,
  };
}

function maskSessionInputValue(
  value: string | boolean | readonly string[],
  secrets: SecretMasker,
  failClosed: boolean,
): string | boolean | readonly string[] {
  if (!failClosed || typeof value === 'boolean') {
    return maskInputValue(value, secrets);
  }
  return typeof value === 'string' ? MASK : value.map(() => MASK);
}

function failureOutcome(projection: FailureErrorProjection, dryRun: boolean): RunOutcome {
  if (projection.kind === 'config_error') {
    return {
      status: 'config_error',
      exitCode: EXIT_CODE_BY_STATUS.config_error,
      dryRun,
      error: projection.error as ResultError<'RUNE-101' | 'RUNE-102' | 'RUNE-103' | 'RUNE-104'>,
    };
  }
  if (projection.kind === 'input_error') {
    return {
      status: 'input_error',
      exitCode: EXIT_CODE_BY_STATUS.input_error,
      dryRun,
      error: projection.error as ResultError<'RUNE-201' | 'RUNE-202' | 'RUNE-203'>,
    };
  }
  if (projection.kind === 'resolution_error') {
    return {
      status: 'resolution_error',
      exitCode: EXIT_CODE_BY_STATUS.resolution_error,
      dryRun,
      error: projection.error as ResultError<'RUNE-301' | 'RUNE-302' | 'RUNE-311' | 'RUNE-312'>,
    };
  }
  if (projection.kind === 'cancelled') {
    return {
      status: 'cancelled',
      exitCode: EXIT_CODE_BY_STATUS.cancelled,
      dryRun,
      error: projection.error as ResultError<'RUNE-601'>,
    };
  }
  if (projection.kind === 'log_failure') {
    if (dryRun) {
      throw new InternalError('a log-file failure cannot belong to a dry-run result');
    }
    return {
      status: 'failed',
      exitCode: EXIT_CODE_BY_STATUS.failed,
      dryRun: false,
      error: projection.error as ResultError<'RUNE-406'>,
    };
  }
  if (projection.kind === 'plan_failure') {
    return {
      status: 'failed',
      exitCode: EXIT_CODE_BY_STATUS.failed,
      dryRun,
      error: projection.error as ResultError<'RUNE-401' | 'RUNE-404' | 'RUNE-405'>,
    };
  }
  if (projection.kind === 'internal_error') {
    return {
      status: 'internal_error',
      exitCode: EXIT_CODE_BY_STATUS.internal_error,
      dryRun,
      error: projection.error as ResultError<'RUNE-500'>,
    };
  }
  throw new InternalError('this RuneError cannot produce a run result');
}

const IDENTITY_MASKER: SecretMasker = Object.freeze({
  mask: (text: string): string => text,
  maskFragments: (fragments: readonly string[]) =>
    fragments.map((text, sourceIndex) => ({
      text,
      sourceIndices: [sourceIndex],
      replacement: false,
    })),
  safeFallbackMarker: () => String.fromCodePoint(0x10000),
});

function snapshotFailureError(error: RuneError): FailureErrorProjection {
  const resultError = deepFreeze(toResultError(error, IDENTITY_MASKER));
  let kind: FailureProjectionKind;
  if (error instanceof ManifestError) {
    kind = 'config_error';
  } else if (error instanceof InputError) {
    kind = 'input_error';
  } else if (error instanceof ResolutionError || error instanceof ConditionError) {
    kind = 'resolution_error';
  } else if (error instanceof CancelledError) {
    kind = 'cancelled';
  } else if (error instanceof ExecutionError) {
    if (resultError.code === 'RUNE-406') {
      kind = 'log_failure';
    } else if (
      resultError.code === 'RUNE-401' ||
      resultError.code === 'RUNE-404' ||
      resultError.code === 'RUNE-405'
    ) {
      kind = 'plan_failure';
    } else {
      throw new InternalError('this execution error cannot produce a pre-execution result');
    }
  } else if (error instanceof InternalError) {
    kind = 'internal_error';
  } else {
    throw new InternalError('this RuneError cannot produce a run result');
  }
  return deepFreeze({ kind, error: resultError });
}

const GENERIC_INTERNAL_PROJECTION = snapshotFailureError(
  new InternalError('an unexpected error escaped the run pipeline'),
);
const CANONICAL_CANCELLED_PROJECTION = snapshotFailureError(new CancelledError());

function snapshotSessionFailureError(error: RuneError): FailureErrorProjection {
  try {
    return snapshotFailureError(error);
  } catch {
    return GENERIC_INTERNAL_PROJECTION;
  }
}

function toResultError(error: RuneError, secrets: SecretMasker): ResultError {
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
    title: projectStructuredString(step.title, secrets),
    state: 'SKIPPED',
    exitCode: null,
    durationMs: 0,
    command: null,
    skipReason: projectStructuredString(step.skipReason, secrets),
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

function maskInputValue(
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
