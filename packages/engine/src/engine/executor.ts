/**
 * Executing a plan (docs/architecture.md §7, stage 5).
 *
 * A sequential walk: at most one step runs at a time, every step reaches exactly one
 * terminal state, and everything a frontend or a file learns about the run comes out of the
 * one event stream — pre-masked, so a secret is gone before anyone can render it.
 */

import { randomUUID } from 'node:crypto';

import { ExecutionError, exitCodeFor, InternalError, type RuneError } from '../errors.js';
import { RUNE_VERSION } from '../version.js';
import { hostPlatform, type Platform } from './context.js';
import type { InputState } from './inputs.js';
import {
  projectPlanForSink,
  type ExecutionPlan,
  type PlannedStep,
  type ResolvedPlanInput,
} from './plan.js';
import type { RunEvent, EngineObserver } from './events.js';
import type { SecretRegistry } from './secrets.js';
import { MASK, MASK_FOR_SINK, SecretString } from './secrets.js';
import { CancelToken } from './cancel.js';
import type { StepState } from './state.js';
import { SpawnRunner } from '../runners/spawnRunner.js';
import type { Runner, SpawnOutcome } from '../runners/base.js';
import {
  EXIT_CODE_BY_STATUS,
  RESULT_SCHEMA_VERSION,
  type ResultInput,
  type ResultStep,
  type RunMode,
  type RunResult,
  type RunStatus,
} from '../results/model.js';

/** How many lines of a failed step's output the result file keeps (§7). */
export const OUTPUT_TAIL_LINES = 50;

export interface ExecuteOptions {
  readonly plan: ExecutionPlan;
  readonly product: { readonly name: string; readonly version: string };
  readonly secrets: SecretRegistry;
  /** The frontend driving this engine run; direct engine callers default to automation. */
  readonly mode?: RunMode;
  readonly observer?: EngineObserver;
  readonly cancel?: CancelToken;
  readonly runner?: Runner;
}

/** The opened-session data an engine-owned failure result preserves (§10). */
export interface FailureResultSession {
  readonly manifest: {
    readonly schemaVersion: 1;
    readonly product: { readonly name: string; readonly version: string };
  };
  readonly manifestPath: string;
  readonly manifestSha256: string;
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
  /** A plan completed before the failure; PENDING stays for dry-run and becomes NOT_RUN live. */
  readonly plan?: ExecutionPlan;
}

/** Runs the plan to its end and reports what happened. Never throws for a failing step. */
export async function executeRun(options: ExecuteOptions): Promise<RunResult> {
  const { plan, secrets } = options;
  if (plan.preview) {
    throw new InternalError(
      'a cross-platform preview plan can only be described, never executed (§6.1)',
    );
  }
  const observer = options.observer ?? (() => undefined);
  const cancel = options.cancel ?? new CancelToken();
  const runner = options.runner ?? new SpawnRunner();
  const runId = randomUUID();
  const projectText = (text: string): string => secrets.mask(text);

  const emit = (event: RunEvent): void => {
    try {
      observer(Object.freeze(event));
    } catch {
      // A broken renderer must never corrupt a run (§9.1).
    }
  };

  const startedAt = new Date();
  const steps: ResultStep[] = [];
  let failed = false;
  let wasCancelled = false;

  emit({ kind: 'runStarted', plan: projectPlanForSink(plan, secrets) });

  for (const [index, step] of plan.steps.entries()) {
    if (step.state === 'SKIPPED') {
      steps.push(finishedStep(step, 'SKIPPED', null, 0, null, null, projectText));
      emit({
        kind: 'stepFinished',
        stepId: step.id,
        state: 'SKIPPED',
        exitCode: undefined,
        durationMs: 0,
      });
      continue;
    }

    const abort = cancel.cancelled || (failed && plan.executionOptions.failFast);
    if (abort) {
      steps.push(
        finishedStep(step, 'NOT_RUN', null, 0, maskArgv(step, projectText), null, projectText),
      );
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
      title: projectText(step.title),
    });

    const tail: { stream: string; line: string }[] = [];
    const keepInTail = (stream: string, line: string): void => {
      tail.push({ stream, line });
      if (tail.length > OUTPUT_TAIL_LINES) {
        tail.shift();
      }
    };
    const stepStart = Date.now();

    let outcome: SpawnOutcome;
    try {
      outcome = await runner.run({
        command: step.command,
        extraEnv: { RUNE_RUN_ID: runId, RUNE_STEP_ID: step.id },
        cancel,
        onOutput: (stream, rawLine) => {
          const line = secrets.mask(rawLine);
          keepInTail(stream, line);
          emit({ kind: 'stepOutput', stepId: step.id, stream, line });
        },
      });
    } catch (cause) {
      outcome = {
        kind: 'failedToStart',
        message: cause instanceof Error ? cause.message : String(cause),
      };
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
        const line = `step "${step.id}" exceeded its timeout of ${step.command.timeoutSeconds} seconds`;
        emit({ kind: 'stepOutput', stepId: step.id, stream: 'stderr', line });
        keepInTail('stderr', line);
        break;
      }
      case 'cancelled':
        state = 'CANCELLED';
        break;
      case 'failedToStart': {
        state = 'FAILED';
        const line = `step "${step.id}" could not be started: ${secrets.mask(outcome.message)}`;
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
      finishedStep(
        step,
        state,
        exitCode,
        durationMs,
        maskArgv(step, projectText),
        state === 'FAILED' ? tail : null,
        projectText,
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
    runId,
    source: sourceFromPlan(plan, options.product, projectText),
    mode: options.mode ?? 'non-interactive',
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
  readonly product: { readonly name: string; readonly version: string };
  readonly secrets: SecretRegistry;
  readonly mode?: RunMode;
}): RunResult {
  const now = new Date();
  const projectText = (text: string): string => options.secrets.mask(text);
  const steps = options.plan.steps.map((step): ResultStep => {
    if (step.state === 'SKIPPED') {
      return finishedStep(step, 'SKIPPED', null, 0, null, null, projectText);
    }
    return finishedStep(step, 'PENDING', null, 0, maskArgv(step, projectText), null, projectText);
  });

  return assembleResult({
    runId: randomUUID(),
    source: sourceFromPlan(options.plan, options.product, projectText),
    mode: options.mode ?? 'non-interactive',
    steps,
    status: 'planned',
    dryRun: true,
    startedAt: now,
    finishedAt: now,
  });
}

/**
 * Builds the result for a known run-owned error. Hosts provide invocation/session context;
 * result identity, input projection, step topology, counters, and freezing stay engine-owned.
 */
export function createFailureResult(options: FailureResultOptions): RunResult {
  if (options.plan !== undefined && options.session === undefined) {
    throw new InternalError('a failure result with a plan requires its opened session');
  }
  if (options.plan !== undefined && options.error instanceof ExecutionError) {
    throw new InternalError('a pre-execution failure result cannot carry a completed plan');
  }

  const status = failureStatus(options.error);
  const now = new Date();
  const host = hostPlatform();
  const session = options.session;
  const projectText =
    session === undefined ? identityText : (text: string): string => session[MASK_FOR_SINK](text);
  const platform = options.plan?.platform ?? session?.platform ?? options.platform ?? host;
  const preview = options.plan?.preview ?? session?.preview ?? platform !== host;
  const source: ResultSource =
    options.plan !== undefined && session !== undefined
      ? sourceFromPlan(options.plan, session.manifest.product, projectText)
      : session === undefined
        ? {
            product: { name: '', version: '' },
            manifest: {
              path: projectText(options.manifestPath),
              sha256: null,
              schemaVersion: null,
            },
            platform,
            preview,
            locale: null,
            inputs: [],
          }
        : {
            product: {
              name: projectText(session.manifest.product.name),
              version: session.manifest.product.version,
            },
            manifest: {
              path: projectText(session.manifestPath),
              sha256: session.manifestSha256,
              schemaVersion: session.manifest.schemaVersion,
            },
            platform,
            preview,
            locale: session.getStrings().locale ?? null,
            inputs: session.allInputs().map((input) => resultInput(input, projectText)),
          };

  const steps =
    options.plan?.steps.map((step): ResultStep => {
      if (step.state === 'SKIPPED') {
        return finishedStep(step, 'SKIPPED', null, 0, null, null, projectText);
      }
      return finishedStep(
        step,
        options.dryRun ? 'PENDING' : 'NOT_RUN',
        null,
        0,
        maskArgv(step, projectText),
        null,
        projectText,
      );
    }) ?? [];

  return assembleResult({
    runId: randomUUID(),
    source,
    mode: session?.mode ?? options.mode ?? 'non-interactive',
    steps,
    status,
    dryRun: options.dryRun,
    startedAt: now,
    finishedAt: now,
  });
}

interface ResultSource {
  readonly product: { readonly name: string; readonly version: string };
  readonly manifest: {
    readonly path: string;
    readonly sha256: string | null;
    readonly schemaVersion: number | null;
  };
  readonly platform: string;
  readonly preview: boolean;
  readonly locale: string | null;
  readonly inputs: readonly ResultInput[];
}

function sourceFromPlan(
  plan: ExecutionPlan,
  product: { readonly name: string; readonly version: string },
  projectText: (text: string) => string,
): ResultSource {
  return {
    product: { name: projectText(product.name), version: product.version },
    manifest: {
      path: projectText(plan.manifestPath),
      sha256: plan.manifestSha256,
      schemaVersion: plan.manifestSchemaVersion,
    },
    platform: plan.platform,
    preview: plan.preview,
    locale: plan.locale,
    inputs: plan.resolvedInputs.map((input) => resultInput(input, projectText)),
  };
}

function failureStatus(error: RuneError): RunStatus {
  const exitCode = exitCodeFor(error);
  for (const [status, code] of Object.entries(EXIT_CODE_BY_STATUS)) {
    if (code === exitCode && status !== 'planned' && status !== 'succeeded') {
      return status as RunStatus;
    }
  }
  throw new InternalError('a usage error cannot produce a run result');
}

function assembleResult(input: {
  readonly runId: string;
  readonly source: ResultSource;
  readonly mode: RunMode;
  readonly steps: readonly ResultStep[];
  readonly status: RunStatus;
  readonly dryRun: boolean;
  readonly startedAt: Date;
  readonly finishedAt: Date;
}): RunResult {
  const { steps } = input;
  const { source } = input;
  const count = (state: StepState): number => steps.filter((step) => step.state === state).length;
  const executed = count('SUCCEEDED') + count('FAILED') + count('CANCELLED');

  return deepFreeze({
    resultSchemaVersion: RESULT_SCHEMA_VERSION,
    id: input.runId,
    status: input.status,
    exitCode: EXIT_CODE_BY_STATUS[input.status],
    mode: input.mode,
    dryRun: input.dryRun,
    crossPlatformPreview: source.preview,
    platform: source.platform,
    locale: source.locale,
    startedAt: input.startedAt.toISOString(),
    finishedAt: input.finishedAt.toISOString(),
    durationMs: input.finishedAt.getTime() - input.startedAt.getTime(),
    runeVersion: RUNE_VERSION,
    // Identity only: a manifest's product block may carry more (a description), and the
    // result schema pins exactly these two fields (§10).
    product: source.product,
    manifest: source.manifest,
    stepsTotal: steps.length,
    stepsExecuted: executed,
    stepsSucceeded: count('SUCCEEDED'),
    stepsFailed: count('FAILED'),
    stepsCancelled: count('CANCELLED'),
    stepsSkipped: count('SKIPPED'),
    stepsNotRun: count('NOT_RUN') + count('PENDING'),
    nothingExecuted: executed === 0,
    inputs: source.inputs,
    steps,
  });
}

function resultInput(
  state: ResolvedPlanInput | InputState,
  projectText: (text: string) => string,
): ResultInput {
  const handler = ('type' in state ? state.type : state.spec.type) === 'secret';
  const value = state.value;
  const safeValue: ResultInput['value'] =
    handler || value instanceof SecretString
      ? null
      : Array.isArray(value)
        ? value.map(projectText)
        : typeof value === 'string'
          ? projectText(value)
          : (value ?? null);

  return {
    id: state.id,
    value: safeValue,
    // A disabled input's discarded value keeps its provenance: the layer that supplied it
    // lives in `ignored`, and the result records it as the source (§5, §10).
    source: state.source ?? state.ignored ?? null,
    secret: handler,
    enabled: state.enabled,
    ignored: state.ignored === null || state.ignored === undefined ? null : 'input disabled',
  };
}

function finishedStep(
  step: PlannedStep,
  state: StepState,
  exitCode: number | null,
  durationMs: number,
  command: readonly string[] | null,
  outputTail: readonly { stream: string; line: string }[] | null,
  projectText: (text: string) => string,
): ResultStep {
  return {
    id: step.id,
    title: projectText(step.title),
    state,
    exitCode,
    durationMs,
    command,
    skipReason: step.state === 'SKIPPED' ? projectText(step.skipReason) : null,
    outputTail:
      outputTail === null
        ? null
        : outputTail.map((entry) => ({ stream: entry.stream, line: projectText(entry.line) })),
  };
}

function maskArgv(
  step: PlannedStep,
  projectText: (text: string) => string,
): readonly string[] | null {
  if (step.state !== 'PENDING') {
    return null;
  }
  return step.command.argv.map((entry) =>
    entry instanceof SecretString ? MASK : projectText(entry),
  );
}

function identityText(text: string): string {
  return text;
}

function deepFreeze<T>(value: T): T {
  if (typeof value !== 'object' || value === null || Object.isFrozen(value)) {
    return value;
  }
  Object.freeze(value);
  for (const entry of Object.values(value as Record<string, unknown>)) {
    deepFreeze(entry);
  }
  return value;
}
