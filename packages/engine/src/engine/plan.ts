/**
 * Planning (docs/architecture.md §7, stage 4).
 *
 * Interpolation and step conditions are evaluated exactly once, here, after all inputs are
 * final — never at load, never lazily during execution (invariant 3). The result is a fully
 * static plan: what dry-run renders is byte for byte what run will spawn (invariant 4).
 */

import { isAbsolute, resolve as resolvePath } from 'node:path';

import { ExecutionError, InputError, InternalError, type RuneIssue } from '../errors.js';
import { MASK } from './secrets.js';
import type { ManifestV1, CommandSpec } from '../manifest/v1/schema.js';
import { isCommandSpec } from '../manifest/v1/schema.js';
import { inputTypes } from '../inputs/registry.js';
import { evaluateCondition, parseCondition, type ConditionReference } from './conditions.js';
import { resolveReference, type RuntimeContext } from './context.js';
import { renderTemplate } from './interpolate.js';
import type { InputState, Resolution, ValueSource } from './inputs.js';
import { SecretString } from './secrets.js';
import type { SecretRegistry } from './secrets.js';

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

export interface ExecutionPlan {
  readonly manifestPath: string;
  readonly platform: RuntimeContext['platform'];
  /** True when a foreign platform was previewed; such a plan must never execute (§6.1). */
  readonly preview: boolean;
  readonly failFast: boolean;
  readonly logFile: string | undefined;
  readonly steps: readonly PlannedStep[];
}

export interface PlanOptions {
  readonly manifest: ManifestV1;
  readonly manifestPath: string;
  readonly resolution: Resolution;
  readonly context: RuntimeContext;
}

/** Result metadata bound to one concrete plan without becoming part of its public JSON. */
export interface PlanInputSnapshot {
  readonly id: string;
  readonly value: string | boolean | readonly string[] | null;
  readonly source: ValueSource | null;
  readonly secret: boolean;
  readonly enabled: boolean;
  readonly ignored: ValueSource | undefined;
}

/** Execution-only context. Deliberately not re-exported from the package entry point. */
export interface PlanExecutionContext {
  readonly product: { readonly name: string; readonly version: string };
  readonly inputs: readonly PlanInputSnapshot[];
  readonly secrets: SecretRegistry;
}

const executionContexts = new WeakMap<ExecutionPlan, PlanExecutionContext>();

/** Returns the context belonging to this exact plan instance, or fails closed. */
export function executionContextFor(plan: ExecutionPlan): PlanExecutionContext {
  const executionContext = executionContexts.get(plan);
  if (executionContext === undefined) {
    throw new InternalError('the execution plan was not created by buildPlan');
  }
  return executionContext;
}

/** Builds the frozen plan. The manifest was validated, so surprises here are RUNE's bugs. */
export function buildPlan(options: PlanOptions): ExecutionPlan {
  const { manifest, resolution, context } = options;
  rejectIncompleteResolution(resolution);

  const steps = manifest.steps.map((step): PlannedStep => {
    const title = step.title ?? step.id;

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

  const plan = deepFreeze({
    manifestPath: options.manifestPath,
    platform: context.platform,
    preview: context.preview,
    failFast: manifest.execution.failFast,
    logFile: manifest.execution.logFile,
    steps,
  });
  executionContexts.set(plan, snapshotExecutionContext(manifest, resolution));
  return plan;
}

function snapshotExecutionContext(
  manifest: ManifestV1,
  resolution: Resolution,
): PlanExecutionContext {
  const product = Object.freeze({
    name: manifest.product.name,
    version: manifest.product.version,
  });
  const inputs = Object.freeze(resolution.inputs.map(snapshotInput));
  return Object.freeze({ product, inputs, secrets: resolution.secrets });
}

function snapshotInput(state: InputState): PlanInputSnapshot {
  const secret = state.spec.type === 'secret' || state.value instanceof SecretString;
  const value =
    secret || state.value === undefined
      ? null
      : Array.isArray(state.value)
        ? Object.freeze([...state.value])
        : state.value;

  return Object.freeze({
    id: state.id,
    value,
    source: state.source ?? state.ignored ?? null,
    secret,
    enabled: state.enabled,
    ignored: state.ignored,
  });
}

/** Planning is the last gate before execution, so incomplete frontend state fails closed. */
function rejectIncompleteResolution(resolution: Resolution): void {
  const missingIssues: RuneIssue[] = resolution.missing.map((id) => ({
    code: 'RUNE-201',
    message: `required input "${id}" is missing`,
    location: undefined,
  }));
  const issues = [...resolution.problems, ...missingIssues];
  if (issues.length === 0) {
    return;
  }

  // Keep collected coercion/unknown-key issues intact and use the same top-level distinction
  // as resolveInputs. A missing-input issue only leads when there is no more specific problem.
  const code =
    resolution.problems.length === 0
      ? 'RUNE-201'
      : resolution.problems.every((issue) => issue.code === 'RUNE-203')
        ? 'RUNE-203'
        : 'RUNE-202';
  throw InputError.fromIssues(code, issues);
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
