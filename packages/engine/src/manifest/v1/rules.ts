/**
 * Cross-field semantic checks for `schemaVersion: 1` (docs/architecture.md §4.3).
 *
 * The schema in `schema.ts` validates shape; these rules validate meaning. They collect
 * every problem instead of stopping at the first, because an author fixing a manifest wants
 * the whole list, not one round-trip per mistake.
 *
 * Rules that depend on the interpolation and condition grammars — `${...}` reference
 * resolution, `when:` parsing and type checking, input-condition acyclicity — land together
 * with those modules (docs/roadmap.md, milestone 1).
 */

import { statSync, type Stats } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';

import { messageOf, orderIssues, type RuneIssue } from '../../errors.js';
import {
  formatPath,
  startOfFile,
  type Location,
  type PathSegment,
  type SourceMap,
} from '../source.js';
import { isCommandSpec, optionValue, type InputSpec, type ManifestV1 } from './schema.js';

export interface SemanticContext {
  readonly file: string;
  readonly sourceMap: SourceMap;
  /** Directory the manifest lives in; relative asset paths resolve against it (§6.1). */
  readonly manifestDir: string;
  /** Whether `gui:` asset paths are checked on disk — `validate` and `run --gui` do (§4.2). */
  readonly checkAssetFiles: boolean;
}

/** Names an input id may not take, because `${...}` already resolves them (§6.1). */
const BUILT_IN_NAMES = [
  'home',
  'temp',
  'platform',
  'manifestDir',
  'product',
  'env',
  'rune',
  'steps',
];

/** Collects every semantic problem of a manifest that already passed the schema. */
export function checkSemantics(manifest: ManifestV1, ctx: SemanticContext): RuneIssue[] {
  const issues: RuneIssue[] = [];
  checkInputs(manifest, ctx, issues);
  checkSteps(manifest, ctx, issues);
  checkGuiAssets(manifest, ctx, issues);
  // The rules run in the order they are written; the author reads the document top to bottom,
  // and the first problem's position is what the error as a whole points at.
  return orderIssues(issues);
}

function checkInputs(manifest: ManifestV1, ctx: SemanticContext, issues: RuneIssue[]): void {
  const byEnvName = new Map<string, string>();

  for (const [id, input] of Object.entries(manifest.inputs)) {
    const path: PathSegment[] = ['inputs', id];

    if (BUILT_IN_NAMES.includes(id)) {
      issues.push(
        issue(`input id "${id}" collides with the built-in variable \${${id}}`, path, ctx),
      );
    }

    const envName = environmentName(id);
    const other = byEnvName.get(envName);
    if (other !== undefined) {
      issues.push(
        issue(
          `inputs "${other}" and "${id}" both read the environment variable ${envName} — rename one of them`,
          path,
          ctx,
        ),
      );
    } else {
      byEnvName.set(envName, id);
    }

    if (input.type === 'select' || input.type === 'multiselect') {
      checkOptions(input, path, ctx, issues);
    }

    if (input.type === 'text') {
      checkPattern(input, path, ctx, issues);
    }
  }
}

function checkOptions(
  input: Extract<InputSpec, { type: 'select' | 'multiselect' }>,
  path: readonly PathSegment[],
  ctx: SemanticContext,
  issues: RuneIssue[],
): void {
  const optionsPath = [...path, 'options'];
  const values = input.options.map(optionValue);
  const seen = new Map<string, number>();
  values.forEach((value, index) => {
    const first = seen.get(value);
    if (first !== undefined) {
      issues.push(
        issue(
          `${formatPath([...optionsPath, index])} repeats the option value "${value}", already declared by ${formatPath([...optionsPath, first])} — values are what scripts and --set receive, so they must be unique`,
          [...optionsPath, index],
          ctx,
        ),
      );
    } else {
      seen.set(value, index);
    }
  });

  const defaults =
    input.default === undefined
      ? []
      : Array.isArray(input.default)
        ? input.default
        : [input.default];
  const defaultPath = [...path, 'default'];
  for (const value of defaults) {
    if (!seen.has(value)) {
      issues.push(
        issue(
          `${formatPath(defaultPath)} is "${value}", which is not one of the option values (${[...seen.keys()].map((option) => `"${option}"`).join(', ')})`,
          defaultPath,
          ctx,
        ),
      );
    }
  }
}

function checkPattern(
  input: Extract<InputSpec, { type: 'text' }>,
  path: readonly PathSegment[],
  ctx: SemanticContext,
  issues: RuneIssue[],
): void {
  const patternPath = [...path, 'pattern'];

  if (input.pattern !== undefined) {
    try {
      new RegExp(input.pattern, 'u');
    } catch (cause) {
      const reason = messageOf(cause);
      issues.push(
        issue(
          `${formatPath(patternPath)} is not a valid regular expression: ${reason} — patterns use ECMAScript syntax (constructs from other engines such as (?P<name>…) or \\Z are not accepted)`,
          patternPath,
          ctx,
        ),
      );
    }
  }

  if (input.patternHint !== undefined && input.pattern === undefined) {
    issues.push(
      issue(
        `${formatPath([...path, 'patternHint'])} has no effect without ${formatPath(patternPath)}`,
        [...path, 'patternHint'],
        ctx,
      ),
    );
  }
}

function checkSteps(manifest: ManifestV1, ctx: SemanticContext, issues: RuneIssue[]): void {
  const seen = new Map<string, number>();

  manifest.steps.forEach((step, index) => {
    const path: PathSegment[] = ['steps', index];
    const idPath = [...path, 'id'];
    const first = seen.get(step.id);
    if (first !== undefined) {
      issues.push(
        issue(
          `${formatPath(idPath)} "${step.id}" is already used by ${formatPath(['steps', first])} — step ids identify steps in logs and result files, so they must be unique`,
          idPath,
          ctx,
        ),
      );
    } else {
      seen.set(step.id, index);
    }

    if (!isCommandSpec(step.run)) {
      const runPath = [...path, 'run'];
      if (step.run.windows === undefined && step.run.linux === undefined) {
        issues.push(
          issue(
            `${formatPath(runPath)} has no platform block — declare windows, linux, or both (a step that should not run everywhere simply omits the platform it skips)`,
            runPath,
            ctx,
          ),
        );
      }
    }
  });
}

function checkGuiAssets(manifest: ManifestV1, ctx: SemanticContext, issues: RuneIssue[]): void {
  if (!ctx.checkAssetFiles || manifest.gui === undefined) {
    return;
  }

  for (const key of ['logo', 'banner', 'theme'] as const) {
    const value = manifest.gui[key];
    if (value === undefined) {
      continue;
    }
    const path: PathSegment[] = ['gui', key];

    if (value.trim() === '') {
      issues.push(issue(`${formatPath(path)} is empty`, path, ctx));
      continue;
    }

    const absolute = isAbsolute(value) ? value : resolve(ctx.manifestDir, value);
    // A stat rather than a bare existence probe: an icon, an image and a stylesheet are
    // files, and a path that happens to be a directory would otherwise pass validation and
    // fail only when the shell tries to load it.
    let stats: Stats | undefined;
    try {
      stats = statSync(absolute, { throwIfNoEntry: false });
    } catch (cause) {
      // `throwIfNoEntry` covers a missing entry and nothing else: a path with a NUL byte, a
      // component that is not a directory, a directory RUNE may not read all still throw. A
      // path an author wrote is their problem to fix, never an internal error (exit 70).
      issues.push(
        issue(
          `${formatPath(path)} points at "${value}", which cannot be read: ${messageOf(cause)}`,
          path,
          ctx,
        ),
      );
      continue;
    }
    if (stats === undefined) {
      issues.push(
        issue(
          `${formatPath(path)} points at "${value}", which does not exist (resolved against the manifest's directory)`,
          path,
          ctx,
        ),
      );
    } else if (!stats.isFile()) {
      issues.push(
        issue(`${formatPath(path)} points at "${value}", which is not a file`, path, ctx),
      );
    }
  }
}

/** The environment variable an input is settable through (docs/architecture.md §5, layer 3). */
export function environmentName(inputId: string): string {
  return `RUNE_INPUT_${inputId.toUpperCase().replace(/[^A-Z0-9]/g, '_')}`;
}

function issue(message: string, path: readonly PathSegment[], ctx: SemanticContext): RuneIssue {
  return { code: 'RUNE-104', message, location: locate(path, ctx) };
}

function locate(path: readonly PathSegment[], ctx: SemanticContext): Location {
  return ctx.sourceMap.best(path) ?? startOfFile(ctx.file);
}
