/**
 * Planning (docs/architecture.md §7, stage 4).
 *
 * Interpolation and step conditions are evaluated exactly once, here, after all inputs are
 * final — never at load, never lazily during execution (invariant 3). The result is a fully
 * static plan: what dry-run renders is byte for byte what run will spawn (invariant 4).
 */

import { isAbsolute, resolve as resolvePath } from 'node:path';

import { ExecutionError, InternalError } from '../errors.js';
import type { ManifestV1, CommandSpec } from '../manifest/v1/schema.js';
import { isCommandSpec } from '../manifest/v1/schema.js';
import { inputTypes } from '../inputs/registry.js';
import { evaluateCondition, parseCondition, type ConditionReference } from './conditions.js';
import { resolveReference, type RuntimeContext } from './context.js';
import { renderTemplate } from './interpolate.js';
import type { Resolution } from './inputs.js';
import { SecretString } from './secrets.js';

/**
 * A command ready to spawn. The argv is the real text — a secret is already revealed in it,
 * because the child process needs the value, not the mask. Nothing renders a plan directly:
 * every display and every serialization goes through the SecretRegistry (§10, invariant 6).
 */
export interface ResolvedCommand {
  readonly argv: readonly string[];
  readonly cwd: string;
  /** Merged over the parent environment at spawn (§8). */
  readonly env: Readonly<Record<string, string>>;
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

/** Builds the frozen plan. The manifest was validated, so surprises here are RUNE's bugs. */
export function buildPlan(options: PlanOptions): ExecutionPlan {
  const { manifest, resolution, context } = options;

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

  return deepFreeze({
    manifestPath: options.manifestPath,
    platform: context.platform,
    preview: context.preview,
    failFast: manifest.execution.failFast,
    logFile: manifest.execution.logFile,
    steps,
  });
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
  const render = (template: string): string =>
    renderTemplate(template, (reference) => {
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
      // The child process needs the secret itself, not the mask; this text never reaches a
      // sink unmasked, because every sink runs through the SecretRegistry (§10).
      return value instanceof SecretString ? value.reveal() : handler.render(value);
    });

  const command = anchorCommand(render(spec.command), context);

  // The Windows honesty rule, applied to the final interpolated command so dry-run surfaces
  // it before anything executes (§8): a batch file needs a shell, and RUNE never provides
  // one implicitly.
  if (context.platform === 'windows' && /\.(bat|cmd)$/i.test(command)) {
    throw new ExecutionError(
      'RUNE-405',
      `step "${stepId}" runs "${command}", which needs a shell — write it explicitly: command: cmd, args: ["/c", "${command}", ...]`,
    );
  }

  const cwd = spec.cwd === undefined ? context.manifestDir : anchorPath(render(spec.cwd), context);

  const env: Record<string, string> = {};
  for (const [name, value] of Object.entries(spec.env)) {
    env[name] = render(value);
  }

  return {
    argv: [command, ...spec.args.map(render)],
    cwd,
    env,
    timeoutSeconds: spec.timeoutSeconds,
    successExitCodes: spec.successExitCodes,
  };
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
