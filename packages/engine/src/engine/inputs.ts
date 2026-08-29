/**
 * Value resolution (docs/architecture.md §5).
 *
 * Five layers, lowest to highest — manifest defaults, values files, `RUNE_INPUT_*`, `--set`,
 * interactive answers — merged in *one* code path for all three frontends, with the layer
 * that supplied each value recorded. That single path is what makes a GUI run, an interactive
 * run and a pipeline run agree about what the values are (invariant 7).
 *
 * Resolution is a pure function of what it is given: a frontend that changes one answer
 * resolves again rather than patching state, which is what keeps conditional inputs honest.
 */

import { InputError, InternalError, ResolutionError, type RuneIssue } from '../errors.js';
import type { InputValue } from '../inputs/base.js';
import { inputTypes } from '../inputs/registry.js';
import { loadYamlFile } from '../manifest/loader.js';
import { startOfFile, type Location, type SourceMap } from '../manifest/source.js';
import { environmentName } from '../manifest/v1/rules.js';
import type { InputSpec, ManifestV1 } from '../manifest/v1/schema.js';
import { suggest } from '../suggest.js';
import { evaluateCondition, parseCondition, type ConditionReference } from './conditions.js';
import { resolveReference, type RuntimeContext } from './context.js';
import { renderTemplate } from './interpolate.js';
import { SecretRegistry, SecretString } from './secrets.js';

/** Where a value came from. The order is the precedence order of §5, lowest first. */
export const VALUE_SOURCES = ['default', 'values', 'environment', 'set', 'answer'] as const;
export type ValueSource = (typeof VALUE_SOURCES)[number];

/** How a source is named in a message, so a reader knows where to go and change it. */
const SOURCE_NAMES: Readonly<Record<ValueSource, string>> = {
  default: 'the manifest default',
  values: 'a values file',
  environment: 'the environment',
  set: '--set',
  answer: 'the answer',
};

export interface InputState {
  readonly id: string;
  readonly spec: InputSpec;
  /** False when the input's `when:` is false: not required, never prompted, empty (§5). */
  readonly enabled: boolean;
  /** The resolved value, or nothing when a required enabled input is still unanswered. */
  readonly value: InputValue | undefined;
  readonly source: ValueSource | undefined;
  /** The layer whose value was discarded because the input turned out to be disabled. */
  readonly ignored: ValueSource | undefined;
}

/** A values file, already read (layer 2). */
export interface ValuesDocument {
  readonly file: string;
  readonly values: ReadonlyMap<string, unknown>;
  readonly sourceMap: SourceMap;
}

export interface ResolveInputsOptions {
  readonly manifest: ManifestV1;
  readonly context: RuntimeContext;
  /** Values files in the order they were given; a later file overrides an earlier one. */
  readonly values?: readonly ValuesDocument[];
  /** Defaults to this process's environment. */
  readonly environment?: Readonly<Record<string, string | undefined>>;
  /** `--set key=value`, already split. */
  readonly overrides?: ReadonlyMap<string, string>;
  /** What an interactive frontend has been told so far (layer 5). */
  readonly answers?: ReadonlyMap<string, InputValue>;
  /** Registers secrets for masking as they resolve — before any step can launch (§10). */
  readonly secrets?: SecretRegistry;
  /**
   * What to do with a value the registry rejected. `throw` is what a pipeline needs: nothing
   * runs and the process exits. A frontend that can ask again takes `collect`, which records
   * the problem and treats the input as unanswered, so the CLI re-prompts and the GUI marks
   * the field (§5).
   */
  readonly invalidValues?: 'throw' | 'collect';
}

export interface Resolution {
  readonly inputs: readonly InputState[];
  readonly byId: ReadonlyMap<string, InputState>;
  /** The registry every secret in this resolution was registered with. */
  readonly secrets: SecretRegistry;
  /**
   * Enabled required inputs still without an answer — what a frontend must ask for. A value
   * that resolves to nothing counts as no answer: an environment variable that was never set
   * expands to the empty string, and a required input must not be satisfied by that.
   */
  readonly missing: readonly string[];
  /** Things a run should say out loud but not fail over (§5, §10). */
  readonly warnings: readonly string[];
  /** Values the registry rejected, when the caller asked to collect rather than throw. */
  readonly problems: readonly RuneIssue[];
}

/**
 * Merges the layers for every input of a manifest.
 *
 * Throws {@link InputError} listing *every* problem: a value no type accepts, a key that
 * names no input. Missing values are not a failure here — a frontend is allowed to ask —
 * they are reported in {@link Resolution.missing}.
 */
export function resolveInputs(options: ResolveInputsOptions): Resolution {
  const { manifest, context } = options;
  const ids = Object.keys(manifest.inputs);
  const environment = options.environment ?? process.env;
  const secrets = options.secrets ?? new SecretRegistry();

  const issues: RuneIssue[] = [];
  const warnings: string[] = [];

  checkUnknownKeys(options, ids, issues);

  const states = new Map<string, InputState>();
  const order: string[] = [];

  for (const [index, id] of ids.entries()) {
    const spec = manifest.inputs[id];
    if (spec === undefined) {
      continue;
    }
    const handler = inputTypes.get(spec.type);
    const enabled = isEnabled(spec, id, ids.slice(0, index), states, context);
    const supplied = highestLayer(id, spec, options, environment);

    if (!enabled) {
      // A manifest default is not something anybody *supplied* for this run: it is what the
      // author wrote for the case where the input is used at all. Only a value from layers
      // 2–5 is worth a warning, and only that is recorded as discarded (§5, §10).
      const discarded =
        supplied !== undefined && supplied.source !== 'default' ? supplied : undefined;
      if (discarded !== undefined) {
        warnings.push(
          `${id} was set from ${SOURCE_NAMES[discarded.source]}, but its condition is false — the value is ignored`,
        );
      }
      states.set(id, {
        id,
        spec,
        enabled: false,
        value: handler.empty(spec),
        source: undefined,
        ignored: discarded?.source,
      });
      order.push(id);
      continue;
    }

    if (supplied === undefined) {
      states.set(id, {
        id,
        spec,
        enabled: true,
        // A required input that nobody answered stays empty-handed on purpose: the frontends
        // ask, and the non-interactive driver refuses (§10).
        value: spec.required ? undefined : handler.empty(spec),
        source: undefined,
        ignored: undefined,
      });
      order.push(id);
      continue;
    }

    const coerced = coerce(supplied, spec, id, context);
    if (!coerced.ok) {
      issues.push({ code: 'RUNE-202', message: coerced.message, location: supplied.location });
      states.set(id, {
        id,
        spec,
        enabled: true,
        value: undefined,
        source: undefined,
        ignored: undefined,
      });
      order.push(id);
      continue;
    }

    if (handler.secret) {
      // The one place that unwraps a secret outside the runner: it has to know the text to
      // be able to remove it from everything a run prints (§10).
      const text = coerced.value instanceof SecretString ? coerced.value.reveal() : '';
      if (text !== '' && !secrets.register(text)) {
        warnings.push(
          `${id} is too short to mask reliably, so it may appear in logs — a value of at least 4 characters is masked everywhere`,
        );
      }
    }

    states.set(id, {
      id,
      spec,
      enabled: true,
      value: coerced.value,
      source: supplied.source,
      ignored: undefined,
    });
    order.push(id);
  }

  if (issues.length > 0 && (options.invalidValues ?? 'throw') === 'throw') {
    // A batch of nothing but unknown keys is an unknown-key error; anything mixed is about
    // the values (§7).
    const onlyUnknownKeys = issues.every((issue) => issue.code === 'RUNE-203');
    throw InputError.fromIssues(onlyUnknownKeys ? 'RUNE-203' : 'RUNE-202', issues);
  }

  const inputs = order.map((id) => states.get(id)).filter((state) => state !== undefined);
  return {
    inputs,
    byId: states,
    secrets,
    missing: inputs.filter((state) => stillNeeded(state)).map((state) => state.id),
    warnings,
    problems: issues,
  };
}

/** Whether an input is enabled, required, and has nothing that counts as an answer. */
function stillNeeded(state: InputState): boolean {
  if (!state.enabled || !state.spec.required) {
    return false;
  }
  return state.value === undefined || inputTypes.get(state.spec.type).isAbsent(state.value);
}

/** A raw value and where it came from, before any type knows what to make of it. */
interface SuppliedValue {
  readonly source: ValueSource;
  readonly raw: unknown;
  readonly location: Location | undefined;
  /** How the source is named in a message; the environment names the variable it read. */
  readonly origin: string;
}

/** The value of the highest layer that supplied one, which is the value that wins (§5). */
function highestLayer(
  id: string,
  spec: InputSpec,
  options: ResolveInputsOptions,
  environment: Readonly<Record<string, string | undefined>>,
): SuppliedValue | undefined {
  const answer = options.answers?.get(id);
  if (answer !== undefined) {
    return { source: 'answer', raw: answer, location: undefined, origin: SOURCE_NAMES.answer };
  }

  const override = options.overrides?.get(id);
  if (override !== undefined) {
    return { source: 'set', raw: override, location: undefined, origin: `--set ${id}=…` };
  }

  const variable = environmentName(id);
  const fromEnvironment = environment[variable];
  if (fromEnvironment !== undefined) {
    return {
      source: 'environment',
      raw: fromEnvironment,
      location: undefined,
      origin: `the environment variable ${variable}`,
    };
  }

  // Later files override earlier ones, so the last one that mentions the input wins.
  for (const document of [...(options.values ?? [])].reverse()) {
    if (document.values.has(id)) {
      return {
        source: 'values',
        raw: document.values.get(id),
        location: document.sourceMap.best([id]) ?? startOfFile(document.file),
        origin: document.file,
      };
    }
  }

  // A `secret` has no default at all — the type carries no such key, which is why this asks
  // the value rather than the type (§4.2).
  if ('default' in spec && spec.default !== undefined) {
    return {
      source: 'default',
      raw: spec.default,
      location: undefined,
      origin: SOURCE_NAMES.default,
    };
  }

  return undefined;
}

type CoercionOutcome =
  | { readonly ok: true; readonly value: InputValue }
  | { readonly ok: false; readonly message: string };

function coerce(
  supplied: SuppliedValue,
  spec: InputSpec,
  id: string,
  context: RuntimeContext,
): CoercionOutcome {
  const handler = inputTypes.get(spec.type);
  let raw = supplied.raw;

  // A default is a template: it is rendered before it is read, and it may name only what is
  // known before the other inputs are (§6.1). A reference that resolves to nothing is a
  // resolution error and stays one — it is not a value a user got wrong (§7, invariant 9).
  if (supplied.source === 'default' && typeof raw === 'string' && isTemplated(spec)) {
    raw = renderDefault(raw, id, context);
  }

  const result =
    typeof raw === 'string' ? handler.fromString(raw, spec) : handler.fromNative(raw, spec);

  // The type names the value and says what is wrong with it; resolution adds which input it
  // belongs to and where the value came from, which is what a reader needs to go and fix it.
  return result.ok
    ? result
    : { ok: false, message: `${id} (from ${supplied.origin}): ${result.message}` };
}

/** Only the free-text types carry templates; a select default is one of its option values. */
function isTemplated(spec: InputSpec): boolean {
  return spec.type === 'text' || spec.type === 'file' || spec.type === 'directory';
}

function renderDefault(text: string, id: string, context: RuntimeContext): string {
  const where = `inputs.${id}.default`;
  return renderTemplate(text, (reference) => {
    // No inputs are in scope: a default is rendered before the other inputs are known, which
    // `validate` already refused to let an author rely on.
    const resolved = resolveReference(reference.segments, []);
    if (!resolved.ok) {
      throw new ResolutionError('RUNE-301', `${where}: ${resolved.message}`);
    }
    try {
      return context.valueOf(resolved.reference);
    } catch (cause) {
      if (cause instanceof ResolutionError) {
        throw new ResolutionError('RUNE-301', `${where}: ${cause.message}`, { cause });
      }
      throw cause;
    }
  });
}

/** Whether an input's `when:` holds, given the inputs declared above it (§5, §6.2). */
function isEnabled(
  spec: InputSpec,
  id: string,
  earlier: readonly string[],
  states: ReadonlyMap<string, InputState>,
  context: RuntimeContext,
): boolean {
  if (spec.when === undefined) {
    return true;
  }

  const parsed = parseCondition(spec.when);
  if (!parsed.ok) {
    // The manifest was validated before it got here, so a condition that does not parse is
    // a bug in RUNE, not a mistake an author can make.
    throw new InternalError(`the condition of input "${id}" did not parse: ${parsed.message}`);
  }

  try {
    return evaluateCondition(parsed.ast, (reference) =>
      lookup(reference, earlier, states, context),
    );
  } catch (cause) {
    // Without the attribution the message is "the environment variable CI is not set", with
    // nothing to say which of a dozen conditions asked for it.
    if (cause instanceof ResolutionError) {
      throw new ResolutionError('RUNE-301', `inputs.${id}.when: ${cause.message}`, { cause });
    }
    throw cause;
  }
}

function lookup(
  reference: ConditionReference,
  visible: readonly string[],
  states: ReadonlyMap<string, InputState>,
  context: RuntimeContext,
): boolean | string | readonly string[] {
  const resolved = resolveReference(reference.segments, visible);
  if (!resolved.ok) {
    throw new InternalError(`the condition names ${reference.text}: ${resolved.message}`);
  }

  if (resolved.reference.kind !== 'input') {
    return context.valueOf(resolved.reference);
  }

  const state = states.get(resolved.reference.id);
  if (state === undefined) {
    throw new InternalError(`${reference.text} was read before it was resolved`);
  }
  const handler = inputTypes.get(state.spec.type);
  // An input nobody has answered yet counts as its empty value, so a field that depends on an
  // unanswered checkbox starts out disabled and turns on the moment the box is ticked.
  return handler.compare(state.value ?? handler.empty(state.spec));
}

/** A key that names no input is a hard error: a typo that no-ops in a pipeline is worse (§5). */
function checkUnknownKeys(
  options: ResolveInputsOptions,
  ids: readonly string[],
  issues: RuneIssue[],
): void {
  const report = (key: string, origin: string, location: Location | undefined): void => {
    if (ids.includes(key)) {
      return;
    }
    const suggestion = suggest(key, ids);
    issues.push({
      code: 'RUNE-203',
      message: `"${key}" is not an input of this manifest${
        suggestion === undefined ? '' : ` — did you mean "${suggestion}"?`
      } (set from ${origin})`,
      location,
    });
  };

  for (const key of options.overrides?.keys() ?? []) {
    report(key, SOURCE_NAMES.set, undefined);
  }
  for (const document of options.values ?? []) {
    for (const key of document.values.keys()) {
      report(key, document.file, document.sourceMap.best([key]) ?? startOfFile(document.file));
    }
  }
  for (const key of options.answers?.keys() ?? []) {
    report(key, 'the answer', undefined);
  }
}

/**
 * Reads a values file (§5, layer 2): one flat mapping of input id to value. Values are
 * written in their own type — a YAML boolean, a list of strings — or as strings; anything
 * else is refused here, where the file and the line are still known.
 */
export function parseValuesFile(path: string, file: string = path): ValuesDocument {
  const document = loadYamlFile(file, path);
  const values = new Map<string, unknown>();
  const issues: RuneIssue[] = [];

  const raw = document.value;
  if (raw === null || raw === undefined) {
    return { file: document.file, values, sourceMap: document.sourceMap };
  }

  if (typeof raw !== 'object' || Array.isArray(raw)) {
    throw new InputError('RUNE-202', `${file} must contain a mapping of input ids to values`, {
      location: startOfFile(document.file),
    });
  }

  for (const [key, value] of Object.entries(raw)) {
    const location = document.sourceMap.best([key]) ?? startOfFile(document.file);
    const problem = shapeProblem(value);
    if (problem === undefined) {
      values.set(key, value);
    } else {
      issues.push({ code: 'RUNE-202', message: `${key} ${problem}`, location });
    }
  }

  if (issues.length > 0) {
    throw InputError.fromIssues('RUNE-202', issues);
  }

  return { file: document.file, values, sourceMap: document.sourceMap };
}

/**
 * What a values file may hold, before any input type has an opinion about it.
 *
 * No message here repeats the value. This runs before anything knows which input a key
 * belongs to, so it cannot know that the value it is about to quote is a secret — and a
 * digits-only API key written without quotes is exactly the value that lands here (§10).
 * The position in the message is enough to find it.
 */
function shapeProblem(value: unknown): string | undefined {
  if (typeof value === 'string' || typeof value === 'boolean') {
    return undefined;
  }
  if (Array.isArray(value)) {
    return value.every((entry) => typeof entry === 'string')
      ? undefined
      : 'is a list with an entry that is not a string';
  }
  if (typeof value === 'number' || typeof value === 'bigint') {
    return 'is a number — write it in quotes so it means exactly what it says';
  }
  if (value === null) {
    return 'has no value — remove the key, or give it one';
  }
  return 'is a mapping; a values file is one flat mapping of input ids to values';
}
