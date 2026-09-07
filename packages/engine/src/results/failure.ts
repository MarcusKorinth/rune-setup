/**
 * Constructs failures outside normal execution from authenticated Session/plan context.
 * The registries and their validation stay together so stale or foreign context cannot
 * weaken result masking or invent execution history (docs/architecture.md §§9.1, 10).
 */

import { randomUUID } from 'node:crypto';

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
import { manifestDescriptorFor, type Manifest } from '../manifest/index.js';
import { RUNE_VERSION } from '../version.js';
import {
  executionContextFor,
  planningFailureContextFor,
  type ExecutionPlan,
  type PlanExecutionContext,
} from '../engine/plan.js';
import { hostPlatform, type Platform } from '../engine/context.js';
import type { InputState } from '../engine/inputs.js';
import { deepFreeze } from '../engine/freeze.js';
import { MASK, projectStructuredString, type SecretMasker } from '../engine/secrets.js';
import type { StepState } from '../engine/state.js';
import {
  EXIT_CODE_BY_STATUS,
  RESULT_SCHEMA_VERSION,
  type ResultInput,
  type ResultError,
  type ResultStep,
  type RunResult,
  type RunMode,
  type RunOutcome,
} from './model.js';
import {
  commandResultStep,
  maskInputValue,
  resultInput,
  skippedResultStep,
  toResultError,
} from './projection.js';

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
