/**
 * Planning (docs/architecture.md §7, stage 4).
 *
 * Interpolation and step conditions are evaluated exactly once, here, after all inputs are
 * final — never at load, never lazily during execution (invariant 3). The result is a fully
 * static plan: what dry-run renders is byte for byte what run will spawn (invariant 4).
 */

import { isAbsolute, resolve as resolvePath } from 'node:path';

import { ExecutionError, InternalError } from '../errors.js';
import type { InputValue } from '../inputs/base.js';
import { MASK, SecretString, type SecretRegistry } from './secrets.js';
import type { ManifestV1, CommandSpec } from '../manifest/v1/schema.js';
import { isCommandSpec } from '../manifest/v1/schema.js';
import { inputTypes } from '../inputs/registry.js';
import { evaluateCondition, parseCondition, type ConditionReference } from './conditions.js';
import { resolveReference, type RuntimeContext } from './context.js';
import { renderTemplate } from './interpolate.js';
import type { Resolution, ValueSource } from './inputs.js';
import type { StringTable } from '../i18n/strings.js';

/** One immutable sink projection per canonical plan and registry. */
const sinkProjections = new WeakMap<
  ExecutionPlan,
  WeakMap<SecretRegistry, { readonly registered: number; readonly plan: ExecutionPlan }>
>();

/**
 * A command ready to spawn. Any piece whose rendering touched a secret input stays wrapped
 * in a SecretString inside the plan — serializing or inspecting the plan renders `***` —
 * and is unwrapped only inside the runner, at spawn (§7, §8, invariant 6).
 */
export interface ResolvedCommand {
  readonly argv: readonly (string | SecretString)[];
  readonly cwd: string | SecretString;
  /** Merged over the parent environment at spawn (§8). */
  readonly env: Readonly<Record<string, string | SecretString>>;
  readonly timeoutSeconds: number | null;
  readonly successExitCodes: readonly number[];
}

export type PlannedStep =
  | {
      readonly id: string;
      readonly title: string;
      readonly state: 'PENDING';
      readonly command: ResolvedCommand;
    }
  | {
      readonly id: string;
      readonly title: string;
      readonly state: 'SKIPPED';
      readonly skipReason: string;
    };

/** The execution-plan format is independent of manifest and result schema versions. */
export const EXECUTION_PLAN_VERSION = 1;

/**
 * An input after the resolution stage has finished. The plan deliberately does not retain
 * the manifest's InputSpec: only the immutable state that execution and rendering consume
 * crosses the planning boundary.
 */
export interface ResolvedPlanInput {
  readonly id: string;
  readonly type: ManifestV1['inputs'][string]['type'];
  readonly value: InputValue;
  readonly enabled: boolean;
  readonly source: ValueSource | null;
  readonly ignored: ValueSource | null;
}

export interface ExecutionOptions {
  readonly failFast: boolean;
  /** The effective absolute path after CLI-over-manifest precedence, or null when disabled. */
  readonly logFile: string | null;
}

export interface ExecutionPlan {
  readonly executionPlanVersion: typeof EXECUTION_PLAN_VERSION;
  readonly manifestPath: string;
  readonly manifestSha256: string;
  readonly manifestSchemaVersion: ManifestV1['schemaVersion'];
  /** The session's selected display locale, or nothing for the built-in defaults (§6.3). */
  readonly locale: string | null;
  readonly platform: RuntimeContext['platform'];
  /** True when a foreign platform was previewed; such a plan must never execute (§6.1). */
  readonly preview: boolean;
  readonly resolvedInputs: readonly ResolvedPlanInput[];
  readonly executionOptions: ExecutionOptions;
  readonly steps: readonly PlannedStep[];
}

export interface PlanOptions {
  readonly manifest: ManifestV1;
  readonly manifestPath: string;
  /** SHA-256 of the exact manifest bytes used to produce this plan. */
  readonly manifestSha256: string;
  readonly resolution: Resolution;
  readonly context: RuntimeContext;
  /** Effective log path after CLI-over-manifest precedence and path anchoring. */
  readonly logFile?: string | undefined;
  /** Localized titles land in the plan, so events and results show them (S6.3). */
  readonly strings?: StringTable | undefined;
}

/** Builds the frozen plan. The manifest was validated, so surprises here are RUNE's bugs. */
export function buildPlan(options: PlanOptions): ExecutionPlan {
  const { manifest, resolution, context } = options;

  const steps = manifest.steps.map((step): PlannedStep => {
    const title = options.strings?.stepTitle(step.id) ?? step.title ?? step.id;

    const command = commandFor(step.run, context);
    if (command === undefined) {
      return {
        id: step.id,
        title,
        state: 'SKIPPED',
        skipReason: 'no run block for platform',
      };
    }

    if (step.when !== undefined && !holds(step.when, step.id, resolution, context)) {
      return {
        id: step.id,
        title,
        state: 'SKIPPED',
        skipReason: `condition false: ${step.when}`,
      };
    }

    return {
      id: step.id,
      title,
      state: 'PENDING',
      command: resolveCommand(command, step.id, resolution, context),
    };
  });

  const resolvedInputs = resolution.inputs.map((state): ResolvedPlanInput => {
    if (state.value === undefined) {
      throw new InternalError(`input "${state.id}" was not resolved before planning`);
    }
    return {
      id: state.id,
      type: state.spec.type,
      value: Array.isArray(state.value) ? [...state.value] : state.value,
      enabled: state.enabled,
      source: state.source ?? null,
      ignored: state.ignored ?? null,
    };
  });

  return deepFreeze({
    executionPlanVersion: EXECUTION_PLAN_VERSION,
    manifestPath: options.manifestPath,
    manifestSha256: options.manifestSha256,
    manifestSchemaVersion: manifest.schemaVersion,
    locale: options.strings?.locale ?? null,
    platform: context.platform,
    preview: context.preview,
    resolvedInputs,
    executionOptions: {
      failFast: manifest.execution.failFast,
      logFile: options.logFile ?? null,
    },
    steps,
  });
}

/**
 * Projects the canonical execution plan across a sink boundary without changing any
 * execution decision. Only free-form/value-bearing strings are masked; ids, enums, hashes,
 * versions, counters, booleans and numbers remain identical. The projection is cached so
 * {@link Session.plan} and `RunStarted.plan` expose the same frozen object.
 */
export function projectPlanForSink(plan: ExecutionPlan, secrets: SecretRegistry): ExecutionPlan {
  let byRegistry = sinkProjections.get(plan);
  if (byRegistry === undefined) {
    byRegistry = new WeakMap();
    sinkProjections.set(plan, byRegistry);
  }
  const existing = byRegistry.get(secrets);
  if (existing?.registered === secrets.size) {
    return existing.plan;
  }

  const projection = deepFreeze({
    executionPlanVersion: plan.executionPlanVersion,
    manifestPath: secrets.mask(plan.manifestPath),
    manifestSha256: plan.manifestSha256,
    manifestSchemaVersion: plan.manifestSchemaVersion,
    locale: plan.locale,
    platform: plan.platform,
    preview: plan.preview,
    resolvedInputs: plan.resolvedInputs.map((input): ResolvedPlanInput => ({
      id: input.id,
      type: input.type,
      value: projectInputValue(input.value, secrets),
      enabled: input.enabled,
      source: input.source,
      ignored: input.ignored,
    })),
    executionOptions: {
      failFast: plan.executionOptions.failFast,
      logFile:
        plan.executionOptions.logFile === null ? null : secrets.mask(plan.executionOptions.logFile),
    },
    steps: plan.steps.map((step): PlannedStep =>
      step.state === 'SKIPPED'
        ? {
            id: step.id,
            title: secrets.mask(step.title),
            state: step.state,
            skipReason: secrets.mask(step.skipReason),
          }
        : {
            id: step.id,
            title: secrets.mask(step.title),
            state: step.state,
            command: {
              argv: step.command.argv.map((entry) => projectText(entry, secrets)),
              cwd: projectText(step.command.cwd, secrets),
              env: Object.fromEntries(
                Object.entries(step.command.env).map(([name, value]) => [
                  name,
                  projectText(value, secrets),
                ]),
              ),
              timeoutSeconds: step.command.timeoutSeconds,
              successExitCodes: [...step.command.successExitCodes],
            },
          },
    ),
  });
  byRegistry.set(secrets, { registered: secrets.size, plan: projection });
  return projection;
}

function projectInputValue(value: InputValue, secrets: SecretRegistry): InputValue {
  if (Array.isArray(value)) {
    return value.map((entry) => secrets.mask(entry));
  }
  return typeof value === 'string' || value instanceof SecretString
    ? projectText(value, secrets)
    : value;
}

function projectText(value: string | SecretString, secrets: SecretRegistry): string {
  return value instanceof SecretString ? MASK : secrets.mask(value);
}

/** The command block that applies on this platform, or nothing when the step skips it. */
function commandFor(
  run: ManifestV1['steps'][number]['run'],
  context: RuntimeContext,
): CommandSpec | undefined {
  if (isCommandSpec(run)) {
    return run;
  }
  return context.platform === 'windows' ? run.windows : run.linux;
}

function holds(
  condition: string,
  stepId: string,
  resolution: Resolution,
  context: RuntimeContext,
): boolean {
  const parsed = parseCondition(condition);
  if (!parsed.ok) {
    throw new InternalError(`the condition of step "${stepId}" did not parse: ${parsed.message}`);
  }
  return evaluateCondition(parsed.ast, (reference) => lookup(reference, resolution, context));
}

function lookup(
  reference: ConditionReference,
  resolution: Resolution,
  context: RuntimeContext,
): boolean | string | readonly string[] {
  const resolved = resolveReference(reference.segments, [...resolution.byId.keys()]);
  if (!resolved.ok) {
    throw new InternalError(`the condition names ${reference.text}: ${resolved.message}`);
  }
  if (resolved.reference.kind !== 'input') {
    return context.valueOf(resolved.reference);
  }
  const state = resolution.byId.get(resolved.reference.id);
  if (state === undefined) {
    throw new InternalError(`${reference.text} was not resolved before planning`);
  }
  const handler = inputTypes.get(state.spec.type);
  return handler.compare(state.value ?? handler.empty(state.spec));
}

function resolveCommand(
  spec: CommandSpec,
  stepId: string,
  resolution: Resolution,
  context: RuntimeContext,
): ResolvedCommand {
  const render = (template: string): string | SecretString => {
    let touchedSecret = false;
    const text = renderTemplate(template, (reference) => {
      const resolved = resolveReference(reference.segments, [...resolution.byId.keys()]);
      if (!resolved.ok) {
        throw new InternalError(
          `${reference.text} was not caught by validation: ${resolved.message}`,
        );
      }
      if (resolved.reference.kind !== 'input') {
        return context.valueOf(resolved.reference);
      }
      const state = resolution.byId.get(resolved.reference.id);
      if (state === undefined) {
        throw new InternalError(`${reference.text} was not resolved before planning`);
      }
      const handler = inputTypes.get(state.spec.type);
      const value = state.value ?? handler.empty(state.spec);
      if (value instanceof SecretString) {
        touchedSecret = true;
        return value.reveal();
      }
      return handler.render(value);
    });
    // Anything a secret flowed into stays wrapped: the plan itself never holds a secret in
    // the clear, and only the runner unwraps it, at spawn (§8).
    return touchedSecret ? new SecretString(text) : text;
  };

  const command = rewrap(render(spec.command), (text) => anchorCommand(text, context));
  const commandShown = command instanceof SecretString ? MASK : command;

  // The Windows honesty rule, applied to the final interpolated command so dry-run surfaces
  // it before anything executes (§8): a batch file needs a shell, and RUNE never provides
  // one implicitly.
  if (context.platform === 'windows' && /\.(bat|cmd)$/i.test(textOf(command))) {
    throw new ExecutionError(
      'RUNE-405',
      `step "${stepId}" runs "${commandShown}", which needs a shell — write it explicitly: command: cmd, args: ["/c", "${commandShown}", ...]`,
    );
  }

  const cwd =
    spec.cwd === undefined
      ? context.manifestDir
      : rewrap(render(spec.cwd), (text) => anchorPath(text, context));

  const env: Record<string, string | SecretString> = {};
  for (const [name, value] of Object.entries(spec.env)) {
    env[name] = render(value);
  }

  return {
    argv: [command, ...spec.args.map(render)],
    cwd,
    env,
    timeoutSeconds: spec.timeoutSeconds,
    successExitCodes: [...spec.successExitCodes],
  };
}

/**
 * Applies a plan-time text transformation (anchoring, the batch-file test) to a rendering.
 * A secret-wrapped rendering is open only for the duration of the call and wrapped again
 * before anything stores it — the plan never carries the clear text.
 */
function rewrap(
  value: string | SecretString,
  transform: (text: string) => string,
): string | SecretString {
  return value instanceof SecretString
    ? new SecretString(transform(value.reveal()))
    : transform(value);
}

function textOf(value: string | SecretString): string {
  return value instanceof SecretString ? value.reveal() : value;
}

/**
 * A command that is written as a path resolves against the manifest's directory, never the
 * caller's cwd (invariant 13); a bare name is left for the PATH lookup at spawn.
 */
function anchorCommand(command: string, context: RuntimeContext): string {
  const looksLikePath = command.includes('/') || command.includes('\\');
  return looksLikePath ? anchorPath(command, context) : command;
}

function anchorPath(path: string, context: RuntimeContext): string {
  return isAbsolute(path) ? path : resolvePath(context.manifestDir, path);
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
