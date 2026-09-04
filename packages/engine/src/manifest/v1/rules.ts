/**
 * Cross-field semantic checks for `schemaVersion: 1` (docs/architecture.md §4.3).
 *
 * The schema in `schema.ts` validates shape; these rules validate meaning. They collect
 * every problem instead of stopping at the first, because an author fixing a manifest wants
 * the whole list, not one round-trip per mistake.
 *
 * The checks that need the expression grammars — `${...}` references, `when:` parsing and
 * typing, and the rule that an input condition may only look backwards — live here too, and
 * report what a reader has to change rather than what a parser saw.
 */

import { statSync, type Stats } from 'node:fs';
import { stat } from 'node:fs/promises';
import { isAbsolute } from 'node:path';

import {
  childrenOf,
  parseCondition,
  typeCheckCondition,
  type ConditionNode,
  type ConditionReference,
  type TypeResolver,
} from '../../engine/conditions.js';
import {
  BUILT_IN_NAMES,
  BUILT_IN_VARIABLES,
  createInputReferenceIndex,
  PRODUCT_NAMESPACE,
  resolveReference,
  typeOfReference,
  type InputReferenceIndex,
} from '../../engine/context.js';
import { scanTemplate, type TemplateReference } from '../../engine/interpolate.js';
import { resolveManifestRelativePathFrom } from '../../engine/paths.js';
import { messageOf, orderIssues, type RuneIssue } from '../../errors.js';
import {
  formatLocation,
  formatPath,
  startOfFile,
  type Location,
  type PathSegment,
  type SourceMap,
} from '../source.js';
import {
  isCommandSpec,
  optionValue,
  type CommandSpec,
  type InputSpec,
  type ManifestV1,
} from './schema.js';

export interface SemanticContext {
  readonly file: string;
  readonly sourceMap: SourceMap;
  /** Directory the manifest lives in; relative asset paths resolve against it (§6.1). */
  readonly manifestDir: string;
  /** Whether `gui:` asset paths are checked on disk — `validate` and `run --gui` do (§4.2). */
  readonly checkAssetFiles: boolean;
}

/** Collects every semantic problem of a manifest that already passed the schema. */
export function checkSemantics(manifest: ManifestV1, ctx: SemanticContext): RuneIssue[] {
  const issues = checkInMemorySemantics(manifest, ctx);
  checkGuiAssets(manifest, ctx, issues);
  return orderIssues(issues);
}

/** Session-only semantic pass whose optional GUI asset checks use asynchronous filesystem I/O. */
export async function checkSemanticsAsync(
  manifest: ManifestV1,
  ctx: SemanticContext,
): Promise<RuneIssue[]> {
  const issues = checkInMemorySemantics(manifest, ctx);
  await checkGuiAssetsAsync(manifest, ctx, issues);
  return orderIssues(issues);
}

function checkInMemorySemantics(manifest: ManifestV1, ctx: SemanticContext): RuneIssue[] {
  const issues: RuneIssue[] = [];
  checkInputs(manifest, ctx, issues);
  checkSteps(manifest, ctx, issues);
  checkExecution(manifest, ctx, issues);
  checkExpressions(manifest, ctx, issues);
  return issues;
}

/** A Windows drive letter followed by anything but a separator, such as `C:run.log`. */
const WINDOWS_DRIVE_RELATIVE_PATH_PATTERN = /^[A-Za-z]:(?![\\/])/;

/**
 * A drive-relative log path cannot be anchored to the manifest directory: its meaning depends on
 * per-drive process state, and anchoring it as a literal component addresses an NTFS alternate
 * data stream on Windows. It is rejected like a drive-relative command (§8, §10).
 */
function checkExecution(manifest: ManifestV1, ctx: SemanticContext, issues: RuneIssue[]): void {
  const logFile = manifest.execution.logFile;
  if (logFile === undefined || !WINDOWS_DRIVE_RELATIVE_PATH_PATTERN.test(logFile)) {
    return;
  }
  const path: PathSegment[] = ['execution', 'logFile'];
  issues.push(
    issue(
      `${formatPath(path)} "${logFile}" is drive-relative and cannot be anchored to \${manifestDir} — use an absolute or manifest-relative path`,
      path,
      ctx,
    ),
  );
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
      compileInputPattern(input.pattern);
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
  for (const asset of guiAssets(manifest, ctx, issues)) {
    // A stat rather than a bare existence probe: an icon, an image and a stylesheet are
    // files, and a path that happens to be a directory would otherwise pass validation and
    // fail only when the shell tries to load it.
    let stats: Stats | undefined;
    try {
      stats = statSync(asset.absolute, { throwIfNoEntry: false });
    } catch (cause) {
      // `throwIfNoEntry` covers a missing entry and nothing else: a path with a NUL byte, a
      // component that is not a directory, a directory RUNE may not read all still throw. A
      // path an author wrote is their problem to fix, never an internal error (exit 70).
      reportGuiAssetFailure(asset, cause, ctx, issues);
      continue;
    }
    reportGuiAssetStats(asset, stats, ctx, issues);
  }
}

async function checkGuiAssetsAsync(
  manifest: ManifestV1,
  ctx: SemanticContext,
  issues: RuneIssue[],
): Promise<void> {
  for (const asset of guiAssets(manifest, ctx, issues)) {
    let stats: Stats | undefined;
    try {
      stats = await stat(asset.absolute);
    } catch (cause) {
      if (cause instanceof Error && (cause as NodeJS.ErrnoException).code === 'ENOENT') {
        stats = undefined;
      } else {
        reportGuiAssetFailure(asset, cause, ctx, issues);
        continue;
      }
    }
    reportGuiAssetStats(asset, stats, ctx, issues);
  }
}

interface GuiAsset {
  readonly value: string;
  readonly path: readonly PathSegment[];
  readonly absolute: string;
}

function guiAssets(
  manifest: ManifestV1,
  ctx: SemanticContext,
  issues: RuneIssue[],
): readonly GuiAsset[] {
  if (!ctx.checkAssetFiles || manifest.gui === undefined) {
    return [];
  }

  const assets: GuiAsset[] = [];
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
    assets.push({
      value,
      path,
      absolute: isAbsolute(value) ? value : resolveManifestRelativePathFrom(value, ctx.manifestDir),
    });
  }
  return assets;
}

function reportGuiAssetFailure(
  asset: GuiAsset,
  cause: unknown,
  ctx: SemanticContext,
  issues: RuneIssue[],
): void {
  issues.push(
    issue(
      `${formatPath(asset.path)} points at "${asset.value}", which cannot be read: ${messageOf(cause)}`,
      asset.path,
      ctx,
    ),
  );
}

function reportGuiAssetStats(
  asset: GuiAsset,
  stats: Stats | undefined,
  ctx: SemanticContext,
  issues: RuneIssue[],
): void {
  if (stats === undefined) {
    issues.push(
      issue(
        `${formatPath(asset.path)} points at "${asset.value}", which does not exist (resolved against the manifest's directory)`,
        asset.path,
        ctx,
      ),
    );
  } else if (!stats.isFile()) {
    issues.push(
      issue(
        `${formatPath(asset.path)} points at "${asset.value}", which is not a file`,
        asset.path,
        ctx,
      ),
    );
  }
}

/**
 * A field whose text is interpolated before it is used (docs/architecture.md §6.1). The
 * exhaustive list lives here, in one place: adding a field to it is what makes `${...}` work
 * there, and forgetting to add it is what leaves a `${...}` sitting in an argument verbatim.
 */
interface InterpolatedField {
  readonly path: readonly PathSegment[];
  readonly text: string;
  /**
   * Whether the field may name other inputs. An input `default` may not: it is rendered
   * before the other inputs are known, so it sees built-ins and the environment only (§5).
   */
  readonly mayReferenceInputs: boolean;
}

interface CommandField {
  readonly path: readonly PathSegment[];
  readonly command: CommandSpec;
}

function* commandFields(manifest: ManifestV1): Generator<CommandField> {
  for (const [index, step] of manifest.steps.entries()) {
    const runPath: PathSegment[] = ['steps', index, 'run'];
    const commands = isCommandSpec(step.run)
      ? [{ path: runPath, command: step.run }]
      : [
          { path: [...runPath, 'windows'], command: step.run.windows },
          { path: [...runPath, 'linux'], command: step.run.linux },
        ];

    for (const { path, command } of commands) {
      if (command !== undefined) {
        yield { path, command };
      }
    }
  }
}

function* interpolatedFields(manifest: ManifestV1): Generator<InterpolatedField> {
  for (const [id, input] of Object.entries(manifest.inputs)) {
    // Only the free-text defaults are templates; a select default is one of its option
    // values, and a boolean default is a boolean.
    if (
      (input.type === 'text' || input.type === 'file' || input.type === 'directory') &&
      input.default !== undefined
    ) {
      yield { path: ['inputs', id, 'default'], text: input.default, mayReferenceInputs: false };
    }
  }

  for (const { path, command } of commandFields(manifest)) {
    yield { path: [...path, 'command'], text: command.command, mayReferenceInputs: true };
    for (const [position, argument] of command.args.entries()) {
      yield { path: [...path, 'args', position], text: argument, mayReferenceInputs: true };
    }
    if (command.cwd !== undefined) {
      yield { path: [...path, 'cwd'], text: command.cwd, mayReferenceInputs: true };
    }
    for (const [name, value] of Object.entries(command.env)) {
      yield { path: [...path, 'env', name], text: value, mayReferenceInputs: true };
    }
  }
}

/**
 * Value-free warnings for declared secrets interpolated into argv (§4.3). This runs only after
 * semantic validation, so every reference already resolves; scanning here classifies the exact
 * argument templates without inspecting or resolving any input value.
 */
export function secretArgumentWarnings(manifest: ManifestV1): readonly string[] {
  const inputIds = Object.keys(manifest.inputs);
  const inputIndex = createInputReferenceIndex(inputIds);
  const warnings: string[] = [];

  for (const { path, command } of commandFields(manifest)) {
    for (const [position, argument] of command.args.entries()) {
      const argumentPath = [...path, 'args', position];
      const scan = scanTemplate(argument);
      if (!scan.ok) {
        continue;
      }
      const warned = new Set<string>();
      for (const part of scan.parts) {
        if (part.kind !== 'reference') {
          continue;
        }
        const resolved = resolveReference(
          part.reference.segments,
          inputIndex,
          inputIds.length,
          false,
        );
        if (
          !resolved.ok ||
          resolved.reference.kind !== 'input' ||
          manifest.inputs[resolved.reference.id]?.type !== 'secret' ||
          warned.has(resolved.reference.id)
        ) {
          continue;
        }
        warned.add(resolved.reference.id);
        warnings.push(
          `${formatPath(argumentPath)} interpolates secret input "${resolved.reference.id}" into argv, which may be visible in OS process listings — use env: instead`,
        );
      }
    }
  }

  return Object.freeze(warnings);
}

/** Every `when:` in the manifest: the steps', and the inputs' with what each may look at. */
interface ConditionField {
  readonly path: readonly PathSegment[];
  readonly text: string;
  /** The inputs this condition may name; everything else declared is visible but forbidden. */
  readonly visibleInputCount: number;
  /** The input this condition belongs to, so a reference back to it can say so. */
  readonly owner: string | undefined;
}

/** Optional typo hints may never make a bounded manifest require unbounded edit matrices. */
const REFERENCE_SUGGESTION_WORK_BUDGET = 250_000;
const REFERENCE_SUGGESTION_WORK_CAP = REFERENCE_SUGGESTION_WORK_BUDGET + 1;
const BUILT_IN_SUGGESTION_WIDTH = [...BUILT_IN_VARIABLES, PRODUCT_NAMESPACE].reduce(
  (width, name) => saturatingSuggestionAdd(width, suggestionStringWidth(name)),
  0,
);

/**
 * One deterministic budget shared by every reference diagnostic in a semantic pass.
 * Prefix widths are built only after the first unknown name, so valid manifests pay nothing.
 */
class ReferenceSuggestionBudget {
  readonly #inputIds: readonly string[];
  #inputPrefixWidths: readonly number[] | undefined;
  #remaining = REFERENCE_SUGGESTION_WORK_BUDGET;

  constructor(inputIds: readonly string[]) {
    this.#inputIds = inputIds;
  }

  allow(name: string, visibleInputCount: number): boolean {
    const visible = Math.max(0, Math.min(visibleInputCount, this.#inputIds.length));
    const candidateWidth = saturatingSuggestionAdd(
      this.#prefixWidths()[visible] ?? REFERENCE_SUGGESTION_WORK_CAP,
      BUILT_IN_SUGGESTION_WIDTH,
    );
    const work = saturatingSuggestionProduct(suggestionStringWidth(name), candidateWidth);
    if (work > this.#remaining) {
      return false;
    }
    this.#remaining -= work;
    return true;
  }

  #prefixWidths(): readonly number[] {
    if (this.#inputPrefixWidths === undefined) {
      const widths = [0];
      for (const id of this.#inputIds) {
        widths.push(saturatingSuggestionAdd(widths.at(-1)!, suggestionStringWidth(id)));
      }
      this.#inputPrefixWidths = widths;
    }
    return this.#inputPrefixWidths;
  }
}

/**
 * Conservative matrix work for `suggest()`: every lowercased candidate is treated as though
 * it passes the length filter, and each matrix includes its initial row and column.
 */
function suggestionStringWidth(value: string): number {
  return Math.min(value.toLowerCase().length + 1, REFERENCE_SUGGESTION_WORK_CAP);
}

function saturatingSuggestionAdd(left: number, right: number): number {
  return left >= REFERENCE_SUGGESTION_WORK_CAP - right
    ? REFERENCE_SUGGESTION_WORK_CAP
    : left + right;
}

function saturatingSuggestionProduct(left: number, right: number): number {
  if (left === 0 || right === 0) {
    return 0;
  }
  return left > Math.floor(REFERENCE_SUGGESTION_WORK_CAP / right)
    ? REFERENCE_SUGGESTION_WORK_CAP
    : left * right;
}

function* conditionFields(
  manifest: ManifestV1,
  inputIndex: InputReferenceIndex,
): Generator<ConditionField> {
  const { orderedIds: ids } = inputIndex;

  for (const [index, id] of ids.entries()) {
    const input = manifest.inputs[id];
    if (input?.when !== undefined) {
      // Declaration order is evaluation order, so an input condition sees exactly the inputs
      // written above it — which is what makes a cycle unwritable (§6.2).
      yield {
        path: ['inputs', id, 'when'],
        text: input.when,
        visibleInputCount: index,
        owner: id,
      };
    }
  }

  for (const [index, step] of manifest.steps.entries()) {
    if (step.when !== undefined) {
      yield {
        path: ['steps', index, 'when'],
        text: step.when,
        visibleInputCount: ids.length,
        owner: undefined,
      };
    }
  }
}

function checkExpressions(manifest: ManifestV1, ctx: SemanticContext, issues: RuneIssue[]): void {
  const inputIds = Object.keys(manifest.inputs);
  const inputIndex = createInputReferenceIndex(inputIds);
  const suggestionBudget = new ReferenceSuggestionBudget(inputIds);

  // What is wrong with a reference depends only on what was written and whether inputs are in
  // scope — never on the field it stands in. A manifest may repeat the same typo in thousands
  // of arguments, and the search for a near miss is not cheap; it is paid once per name.
  const explained = new Map<string, string | undefined>();

  for (const field of interpolatedFields(manifest)) {
    const scan = scanTemplate(field.text);
    if (!scan.ok) {
      issues.push(issue(`${formatPath(field.path)}: ${scan.message}`, field.path, ctx));
      continue;
    }

    for (const part of scan.parts) {
      if (part.kind !== 'reference') {
        continue;
      }
      const key = `${String(field.mayReferenceInputs)}:${part.reference.text}`;
      if (!explained.has(key)) {
        explained.set(
          key,
          referenceProblem(part.reference, inputIndex, field.mayReferenceInputs, suggestionBudget),
        );
      }
      const problem = explained.get(key);
      if (problem !== undefined) {
        issues.push(issue(`${formatPath(field.path)}: ${problem}`, field.path, ctx));
      }
    }
  }

  const conditionReferences = new Map<string, ReturnType<TypeResolver>>();
  for (const field of conditionFields(manifest, inputIndex)) {
    const parsed = parseCondition(field.text);
    if (!parsed.ok) {
      issues.push(issue(`${formatPath(field.path)}: ${parsed.message}`, field.path, ctx));
      continue;
    }

    const resolver = typeResolver(
      manifest,
      inputIndex,
      field.visibleInputCount,
      field.owner,
      conditionReferences,
      suggestionBudget,
    );
    for (const problem of typeCheckCondition(parsed.ast, resolver)) {
      issues.push(issue(`${formatPath(field.path)}: ${problem}`, field.path, ctx));
    }
  }
}

/** Why a reference cannot stand where it stands, or nothing when it can. */
function referenceProblem(
  reference: TemplateReference,
  inputIndex: InputReferenceIndex,
  mayReferenceInputs: boolean,
  suggestions: ReferenceSuggestionBudget,
): string | undefined {
  const visibleInputCount = mayReferenceInputs ? inputIndex.orderedIds.length : 0;
  const head = reference.segments[0] ?? '';
  const includeSuggestion =
    maySuggestReference(head, inputIndex) && suggestions.allow(head, visibleInputCount);
  const resolved = resolveReference(
    reference.segments,
    inputIndex,
    visibleInputCount,
    includeSuggestion,
  );

  if (!resolved.ok) {
    // An input default that names an input gets the reason, not "no such variable": the name
    // exists, it just is not available yet.
    if (!mayReferenceInputs && inputIndex.ordinals.has(reference.segments[0] ?? '')) {
      return `${reference.text} cannot be used in a default — defaults are rendered before the other inputs are known, so they may only use built-in variables and \${env.*}`;
    }
    return resolved.message;
  }

  return undefined;
}

/**
 * Types a condition's references. Everything an input condition may not see is reported as
 * such rather than as an unknown name, because the fix differs: reorder, do not rename.
 */
function typeResolver(
  manifest: ManifestV1,
  inputIndex: InputReferenceIndex,
  visibleInputCount: number,
  owner: string | undefined,
  cache: Map<string, ReturnType<TypeResolver>>,
  suggestions: ReferenceSuggestionBudget,
): TypeResolver {
  return (reference: ConditionReference) => {
    const cacheKey = JSON.stringify([reference.text, visibleInputCount, owner]);
    const cached = cache.get(cacheKey);
    if (cached !== undefined) {
      return cached;
    }

    const head = reference.segments[0] ?? '';
    const ordinal = inputIndex.ordinals.get(head);
    if (ordinal !== undefined && ordinal >= visibleInputCount) {
      const result = {
        ok: false,
        message:
          head === owner
            ? `${reference.text} is this input's own value — a condition cannot depend on the input it decides about`
            : `${reference.text} is declared below this input — a condition may only use inputs written above it, so move "${head}" up`,
      } as const;
      cache.set(cacheKey, result);
      return result;
    }

    const includeSuggestion =
      maySuggestReference(head, inputIndex) && suggestions.allow(head, visibleInputCount);
    const resolved = resolveReference(
      reference.segments,
      inputIndex,
      visibleInputCount,
      includeSuggestion,
    );
    if (!resolved.ok) {
      cache.set(cacheKey, resolved);
      return resolved;
    }

    const type = typeOfReference(resolved.reference, (id) => manifest.inputs[id]?.type);
    const result: ReturnType<TypeResolver> =
      type === undefined
        ? { ok: false, message: `${reference.text} has no type` }
        : { ok: true, type };
    cache.set(cacheKey, result);
    return result;
  };
}

/** Only a truly unknown head reaches the optional typo-suggestion path. */
function maySuggestReference(head: string, inputIndex: InputReferenceIndex): boolean {
  return !inputIndex.ordinals.has(head) && !BUILT_IN_NAMES.includes(head);
}

/**
 * Every environment variable the manifest reads, with the places that read it — the audit
 * report `rune validate` ends with (§4.3). `${env.*}` references are static text, so the list
 * is exact: a reviewer sees what a manifest consumes without grepping for it.
 */
export interface EnvironmentUse {
  readonly name: string;
  readonly locations: readonly Location[];
}

export function environmentReferences(
  manifest: ManifestV1,
  ctx: Pick<SemanticContext, 'file' | 'sourceMap'>,
): readonly EnvironmentUse[] {
  const uses = new Map<string, Map<string, Location>>();
  // Read once, not once per reference. The declared ids do not change while the manifest is
  // walked, and a manifest may repeat references in thousands of arguments — the same reason
  // the reference explanations above are computed per name rather than per occurrence.
  const inputIds = Object.keys(manifest.inputs);
  const inputIndex = createInputReferenceIndex(inputIds);

  const record = (segments: readonly string[], path: readonly PathSegment[]): void => {
    const resolved = resolveReference(segments, inputIndex, inputIds.length, false);
    if (!resolved.ok || resolved.reference.kind !== 'environment') {
      return;
    }
    // Locations are per field, so two reads of the same variable in one argument are one
    // place to look at, not two identical lines in the report.
    const at = ctx.sourceMap.best(path) ?? startOfFile(ctx.file);
    const places = uses.get(resolved.reference.name) ?? new Map<string, Location>();
    places.set(formatLocation(at), at);
    uses.set(resolved.reference.name, places);
  };

  for (const field of interpolatedFields(manifest)) {
    const scan = scanTemplate(field.text);
    if (scan.ok) {
      for (const part of scan.parts) {
        if (part.kind === 'reference') {
          record(part.reference.segments, field.path);
        }
      }
    }
  }

  for (const field of conditionFields(manifest, inputIndex)) {
    const parsed = parseCondition(field.text);
    if (parsed.ok) {
      for (const reference of referencesIn(parsed.ast)) {
        record(reference.segments, field.path);
      }
    }
  }

  return [...uses.entries()]
    .map(([name, places]) => ({
      name,
      locations: [...places.values()].sort((a, b) => a.line - b.line || a.column - b.column),
    }))
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

/** Every `${...}` in a parsed condition, in source order. The tree it walks is capped (§6.2). */
function referencesIn(node: ConditionNode): readonly ConditionReference[] {
  return node.kind === 'reference' ? [node.reference] : childrenOf(node).flatMap(referencesIn);
}

/**
 * The flags every `pattern:` is compiled with — here, where a manifest is validated, and later
 * wherever a supplied value is matched against it. One definition, because the flags decide
 * which patterns exist at all (`[\w-.]` is a range error under `u` and legal without it), and a
 * pattern accepted by `validate` but rejected at the prompt would break mode parity.
 */
export const INPUT_PATTERN_FLAGS = 'u';

/** Compiles a `pattern:` the one way RUNE compiles it. Throws if it is not a valid one. */
export function compileInputPattern(pattern: string): RegExp {
  return new RegExp(pattern, INPUT_PATTERN_FLAGS);
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
