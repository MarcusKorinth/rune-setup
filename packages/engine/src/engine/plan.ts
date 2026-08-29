/**
 * Planning (docs/architecture.md §7, stage 4).
 *
 * Interpolation and step conditions are evaluated exactly once, here, after all inputs are
 * final — never at load, never lazily during execution (invariant 3). The result is a fully
 * static plan: what dry-run renders is byte for byte what run will spawn (invariant 4).
 */

import { isAbsolute, resolve as resolvePath } from 'node:path';

import {
  ExecutionError,
  InputError,
  InternalError,
  ResolutionError,
  type RuneIssue,
} from '../errors.js';
import {
  manifestDescriptorFor,
  type Manifest,
  type ManifestDescriptor,
} from '../manifest/index.js';
import {
  composeSecretString,
  isSecretString,
  MASK,
  resolveSecretPathFrom,
  secretMatches,
  type SecretString,
} from './secrets.js';
import type { ManifestV1, CommandSpec } from '../manifest/v1/schema.js';
import { isCommandSpec } from '../manifest/v1/schema.js';
import { inputTypes } from '../inputs/registry.js';
import { evaluateCondition, parseCondition, type ConditionReference } from './conditions.js';
import { resolveReference, runtimeContextFor, type RuntimeContext } from './context.js';
import { scanTemplate, type TemplateReference } from './interpolate.js';
import {
  resolutionSnapshotFor,
  type InputState,
  type Resolution,
  type ResolutionSnapshot,
  type ValueSource,
} from './inputs.js';
import type { SecretRegistry } from './secrets.js';
import { deepFreeze } from './freeze.js';

/** The independently versioned public shape of an execution plan (§7). */
export const PLAN_SCHEMA_VERSION = 1;

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

/** One final input state captured in the static plan. */
export interface PlanInput {
  readonly id: string;
  readonly value: string | boolean | readonly string[] | SecretString;
  readonly source: ValueSource | undefined;
  readonly secret: boolean;
  readonly enabled: boolean;
  readonly ignored: ValueSource | undefined;
}

/** Execution settings captured alongside the inputs and steps they govern. */
export interface PlanExecutionOptions {
  readonly failFast: boolean;
  readonly logFile: string | undefined;
}

export interface ExecutionPlan {
  readonly planSchemaVersion: typeof PLAN_SCHEMA_VERSION;
  readonly manifestPath: string;
  readonly manifestSha256: string;
  readonly platform: RuntimeContext['platform'];
  /** True when a foreign platform was previewed; such a plan must never execute (§6.1). */
  readonly preview: boolean;
  readonly resolvedInputs: readonly PlanInput[];
  readonly executionOptions: PlanExecutionOptions;
  readonly steps: readonly PlannedStep[];
}

export interface PlanOptions {
  readonly manifest: Manifest;
  readonly resolution: Resolution;
  readonly context: RuntimeContext;
}

/** Execution-only context. Deliberately not re-exported from the package entry point. */
export interface PlanExecutionContext {
  readonly product: { readonly name: string; readonly version: string };
  readonly manifest: ManifestDescriptor;
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
  const manifestDescriptor = manifestDescriptorFor(manifest);
  const resolved = resolutionSnapshotFor(resolution);
  const trustedContext = runtimeContextFor(context);
  if (resolved.manifest !== manifest) {
    throw new InternalError('the input resolution belongs to a different manifest');
  }
  if (resolved.context !== trustedContext) {
    throw new InternalError('the input resolution belongs to a different runtime context');
  }
  rejectIncompleteResolution(resolved);
  const resolvedInputs = resolved.inputs.map(snapshotInput);

  const steps = manifest.steps.map((step): PlannedStep => {
    const title = step.title ?? step.id;

    const command = commandFor(step.run, trustedContext);
    if (command === undefined) {
      return {
        id: step.id,
        title,
        state: 'SKIPPED',
        skipReason: 'no run block for platform',
      };
    }

    if (step.when !== undefined && !holds(step.when, step.id, resolved, trustedContext)) {
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
      command: resolveCommand(command, step.id, resolved, trustedContext),
    };
  });

  const plan: ExecutionPlan = deepFreeze({
    planSchemaVersion: PLAN_SCHEMA_VERSION,
    manifestPath: manifestDescriptor.path,
    manifestSha256: manifestDescriptor.sha256,
    platform: trustedContext.platform,
    preview: trustedContext.preview,
    resolvedInputs,
    executionOptions: {
      failFast: manifest.execution.failFast,
      logFile: manifest.execution.logFile,
    },
    steps,
  });
  executionContexts.set(
    plan,
    snapshotExecutionContext(manifest, manifestDescriptor, resolved.secrets),
  );
  return plan;
}

function snapshotExecutionContext(
  manifest: ManifestV1,
  manifestDescriptor: ManifestDescriptor,
  secrets: SecretRegistry,
): PlanExecutionContext {
  const product = Object.freeze({
    name: manifest.product.name,
    version: manifest.product.version,
  });
  return Object.freeze({
    product,
    manifest: manifestDescriptor,
    secrets,
  });
}

function snapshotInput(state: InputState): PlanInput {
  if (state.value === undefined) {
    throw new InternalError(`input "${state.id}" has no value after resolution was accepted`);
  }
  if (state.spec.type === 'secret' && !isSecretString(state.value)) {
    throw new InternalError(`secret input "${state.id}" is not wrapped after resolution`);
  }
  const secret = state.spec.type === 'secret' || isSecretString(state.value);
  const value = Array.isArray(state.value) ? [...state.value] : state.value;

  return {
    id: state.id,
    value,
    source: state.source,
    secret,
    enabled: state.enabled,
    ignored: state.ignored,
  };
}

/** Planning is the last gate before execution, so incomplete frontend state fails closed. */
function rejectIncompleteResolution(resolution: ResolutionSnapshot): void {
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
  resolution: ResolutionSnapshot,
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
  resolution: ResolutionSnapshot,
  context: RuntimeContext,
): boolean | string | readonly string[] | SecretString {
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
  resolution: ResolutionSnapshot,
  context: RuntimeContext,
): ResolvedCommand {
  const inputIds = [...resolution.byId.keys()];
  const render = (template: string): string | SecretString => {
    const scan = scanTemplate(template);
    if (!scan.ok) {
      throw new ResolutionError('RUNE-302', scan.message);
    }

    const resolve = (reference: TemplateReference): string | SecretString => {
      const resolved = resolveReference(reference.segments, inputIds);
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
      if (isSecretString(value)) {
        return value;
      }
      return handler.render(value);
    };

    const parts = scan.parts.map((part) =>
      part.kind === 'literal' ? part.text : resolve(part.reference),
    );
    return parts.some(isSecretString) ? composeSecretString(parts) : parts.join('');
  };

  const manifestDir = context.manifestDir;
  const command = anchorCommandValue(render(spec.command), manifestDir);
  const commandShown = isSecretString(command) ? MASK : command;

  // The Windows honesty rule, applied to the final interpolated command so dry-run surfaces
  // it before anything executes (§8): a batch file needs a shell, and RUNE never provides
  // one implicitly.
  const isBatchFile = isSecretString(command)
    ? secretMatches(command, /\.(bat|cmd)$/i)
    : /\.(bat|cmd)$/i.test(command);
  if (context.platform === 'windows' && isBatchFile) {
    const message = `step "${stepId}" runs "${commandShown}", which needs a shell — write it explicitly: command: cmd, args: ["/c", "${commandShown}", ...]`;
    throw new ExecutionError('RUNE-405', resolution.secrets.mask(message));
  }

  const cwd =
    spec.cwd === undefined ? context.manifestDir : anchorPathValue(render(spec.cwd), manifestDir);

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

function anchorCommandValue(
  value: string | SecretString,
  manifestDir: string,
): string | SecretString {
  if (isSecretString(value)) {
    return secretMatches(value, /[\\/]/) ? resolveSecretPathFrom(value, manifestDir) : value;
  }
  return anchorCommand(value, manifestDir);
}

function anchorPathValue(value: string | SecretString, manifestDir: string): string | SecretString {
  return isSecretString(value)
    ? resolveSecretPathFrom(value, manifestDir)
    : anchorPath(value, manifestDir);
}

/**
 * A command that is written as a path resolves against the manifest's directory, never the
 * caller's cwd (invariant 13); a bare name is left for the PATH lookup at spawn.
 */
function anchorCommand(command: string, manifestDir: string): string {
  const looksLikePath = command.includes('/') || command.includes('\\');
  return looksLikePath ? anchorPath(command, manifestDir) : command;
}

function anchorPath(path: string, manifestDir: string): string {
  return isAbsolute(path) ? path : resolvePath(manifestDir, path);
}
