/**
 * Value resolution (docs/architecture.md §5).
 *
 * Five layers, lowest to highest — manifest defaults, values files, `RUNE_INPUT_*`, `--set`,
 * interactive answers — merged in *one* code path for all three frontends, with the layer
 * that supplied each value recorded. That single path is what makes a GUI run, an interactive
 * run and a pipeline run agree about what the values are (invariant 7).
 *
 * Resolution is recomputed completely and reproducibly from what it is given: a frontend
 * that changes one answer resolves again rather than patching state, which is what keeps
 * conditional inputs honest. Secret registrations are published as the active snapshot only
 * after resolution succeeds; an error leaves the caller's registry unchanged.
 */

import {
  ConditionError,
  formatIssues,
  InputError,
  InternalError,
  ManifestError,
  ResolutionError,
  RuneError,
  type RuneIssue,
  withValuesDocumentOrdinal,
} from '../errors.js';
import { escapeDiagnosticText, formatDiagnostic, quotedDiagnostic } from '../diagnostics.js';
import type { InputValue } from '../inputs/base.js';
import { inputTypes } from '../inputs/registry.js';
import { nativeStringArraySnapshot } from '../inputs/snapshot.js';
import { loadYamlFile } from '../manifest/loader.js';
import { startOfFile, type Location, type SourceMap } from '../manifest/source.js';
import { environmentName } from '../manifest/v1/rules.js';
import type { InputSpec, ManifestV1 } from '../manifest/v1/schema.js';
import { suggest } from '../suggest.js';
import {
  evaluateCondition,
  parseCondition,
  type ConditionReference,
  type ConditionValue,
} from './conditions.js';
import {
  createInputReferenceIndex,
  resolveReference,
  type InputReferenceIndex,
  type RuntimeContext,
} from './context.js';
import { renderTemplate } from './interpolate.js';
import { SecretRegistry, type SecretMasker } from './secrets.js';

/** Where a value came from. The order is the precedence order of §5, lowest first. */
export const VALUE_SOURCES = ['default', 'values', 'environment', 'set', 'answer'] as const;
export type ValueSource = (typeof VALUE_SOURCES)[number];

/** A rejected value retained only as safe, frontend-readable input state. */
export interface InputRejection {
  /** The value a frontend may prefill; unsafe native values and secrets are never retained. */
  readonly candidate: string | boolean | readonly string[] | undefined;
  readonly source: ValueSource;
  /** The exact issue also present in {@link Resolution.problems}. */
  readonly issue: RuneIssue;
}

/** How a source is named in a message, so a reader knows where to go and change it. */
const SOURCE_NAMES: Readonly<Record<ValueSource, string>> = {
  default: 'the manifest default',
  values: 'a values file',
  environment: 'the environment',
  set: '--set',
  answer: 'the answer',
};

/**
 * Upper bound for optional unknown-key suggestion work during one input resolution.
 *
 * The bound covers the Levenshtein matrix dimensions for every candidate scan. Unknown keys
 * are always reported; spending this budget only decides whether their optional hint is shown.
 */
export const UNKNOWN_KEY_SUGGESTION_WORK_BUDGET = 250_000;
const SUGGESTION_WORK_CAP = UNKNOWN_KEY_SUGGESTION_WORK_BUDGET + 1;

export interface InputState {
  readonly id: string;
  readonly spec: InputSpec;
  /** False when the input's `when:` is false: not required, never prompted, empty (§5). */
  readonly enabled: boolean;
  /** The successfully validated value; unanswered and rejected inputs have no value. */
  readonly value: InputValue | undefined;
  /** Provenance of the validated value only; a rejection carries its own source below. */
  readonly source: ValueSource | undefined;
  /** Details of the supplied value rejected by the input handler, if one was collected. */
  readonly rejection: InputRejection | undefined;
  /** The layer whose value was discarded because the input turned out to be disabled. */
  readonly ignored: ValueSource | undefined;
}

/** A values file, already read (layer 2). */
export interface ValuesDocument {
  readonly file: string;
  readonly values: ReadonlyMap<string, unknown>;
  readonly sourceMap?: SourceMap;
  /** Load and shape problems retained until declared secrets are available for redaction. */
  readonly problems?: readonly DeferredValuesProblem[];
}

interface DeferredValuesShapeProblem {
  readonly kind: 'shape';
  readonly rawKey: string;
  readonly reason: string;
  readonly location: Location;
}

type DeferredValuesProblem = RuneIssue | DeferredValuesShapeProblem;

export interface ResolveInputsOptions {
  readonly manifest: ManifestV1;
  readonly context: RuntimeContext;
  /** Values files in the order they were given; a later file overrides an earlier one. */
  readonly values?: readonly ValuesDocument[];
  /** `--set key=value`, already split. */
  readonly overrides?: ReadonlyMap<string, string>;
  /** What an interactive frontend has been told so far (layer 5). */
  readonly answers?: ReadonlyMap<string, unknown>;
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

/** Canonical resolution state kept behind the exact public facade returned to the caller. */
export interface ResolutionSnapshot {
  readonly manifest: ManifestV1;
  readonly context: RuntimeContext;
  readonly inputIndex: InputReferenceIndex;
  readonly inputs: readonly InputState[];
  readonly byId: ReadonlyMap<string, InputState>;
  readonly secrets: SecretMasker;
  readonly missing: readonly string[];
  readonly warnings: readonly string[];
  readonly problems: readonly RuneIssue[];
}

const resolutionSnapshots = new WeakMap<Resolution, ResolutionSnapshot>();

/** A runtime-immutable map view; freezing a Map does not freeze its internal slots. */
class ImmutableReadonlyMap<K, V> implements ReadonlyMap<K, V> {
  readonly #source: ReadonlyMap<K, V>;

  constructor(source: ReadonlyMap<K, V>) {
    this.#source = source;
  }

  get size(): number {
    return this.#source.size;
  }

  get(key: K): V | undefined {
    return this.#source.get(key);
  }

  has(key: K): boolean {
    return this.#source.has(key);
  }

  entries(): MapIterator<[K, V]> {
    return this.#source.entries();
  }

  keys(): MapIterator<K> {
    return this.#source.keys();
  }

  values(): MapIterator<V> {
    return this.#source.values();
  }

  [Symbol.iterator](): MapIterator<[K, V]> {
    return this.entries();
  }

  forEach(callbackfn: (value: V, key: K, map: ReadonlyMap<K, V>) => void, thisArg?: unknown): void {
    this.#source.forEach((value, key) => {
      callbackfn.call(thisArg, value, key, this);
    });
  }
}

Object.freeze(ImmutableReadonlyMap.prototype);

/** Internal fail-closed lookup: structural resolution copies have no resolver provenance. */
export function resolutionSnapshotFor(resolution: Resolution): ResolutionSnapshot {
  const snapshot = resolutionSnapshots.get(resolution);
  if (snapshot === undefined) {
    throw new InternalError('the input resolution was not created by resolveInputs');
  }
  return snapshot;
}

/**
 * Merges the layers for every input of a manifest.
 *
 * Throws {@link InputError} listing every unknown key and, unless a frontend is collecting,
 * every value no type accepts. Missing values are not a failure here — a frontend is allowed
 * to ask — they are reported in {@link Resolution.missing}.
 */
export function resolveInputs(options: ResolveInputsOptions): Resolution {
  return resolveInputsWithRegistry(options, new SecretRegistry());
}

/** Internal resolver seam for a session that retains masking across re-resolution. */
export function resolveInputsWithRegistry(
  options: ResolveInputsOptions,
  secrets: SecretRegistry,
): Resolution {
  const attempt: ResolutionAttempt = { stagedSecrets: new SecretRegistry() };
  try {
    return resolveInputsStaged(options, secrets, attempt);
  } catch (cause) {
    if (cause instanceof RuneError) {
      const redactor = attempt.redactor ?? secrets.combinedWith(attempt.stagedSecrets);
      throw redactRuneError(cause, redactor);
    }
    throw cause;
  }
}

interface ResolutionAttempt {
  readonly stagedSecrets: SecretRegistry;
  redactor?: SecretRegistry;
}

function resolveInputsStaged(
  options: ResolveInputsOptions,
  publishedSecrets: SecretRegistry,
  attempt: ResolutionAttempt,
): Resolution {
  const { manifest, context } = options;
  const { stagedSecrets } = attempt;
  const ids = Object.keys(manifest.inputs);
  const inputIndex = createInputReferenceIndex(ids);
  const valuesLayer = indexValuesLayer(options.values);
  const suppliedSecrets = stageSuppliedSecrets(options, ids, valuesLayer, stagedSecrets);
  const redactor = publishedSecrets.combinedWith(stagedSecrets);
  attempt.redactor = redactor;

  // A malformed values-file entry must not hide unknown keys or independent coercion errors
  // from the rest of the document. Its presence remains fatal even for an interactive caller
  // that otherwise collects rejected values to re-prompt.
  const hasDeferredValuesProblems = valuesLayer.problems.length > 0;
  const issues: RuneIssue[] = valuesLayer.problems.map(({ problem, documentOrdinal }) =>
    withValuesDocumentOrdinal(materializeValuesProblem(problem, redactor), documentOrdinal),
  );
  const warnings: string[] = [];

  checkUnknownKeys(options, inputIndex, valuesLayer.entries, issues, redactor);

  const states = new Map<string, InputState>();
  const order: string[] = [];

  try {
    for (const id of ids) {
      const spec = manifest.inputs[id];
      if (spec === undefined) {
        continue;
      }
      const handler = inputTypes.get(spec.type);
      const enabled = isEnabled(spec, id, inputIndex, order.length, states, context);
      const supplied = handler.secret
        ? suppliedSecrets.get(id)?.supplied
        : highestLayer(id, spec, options, valuesLayer.byId);

      if (!enabled) {
        // A direct frontend answer is still an attempted edit even while `when:` is false.
        // Validate it before discarding it so Session.setValue never accepts a value that
        // would become invalid merely by enabling the input later.
        if (supplied?.source === 'answer') {
          const coerced = coerce(supplied, spec, id, context, inputIndex, redactor);
          if (!coerced.ok) {
            issues.push({
              code: 'RUNE-202',
              message: coerced.message,
              location: supplied.location,
            });
          }
        }
        // A manifest default is not something anybody *supplied* for this run: it is what the
        // author wrote for the case where the input is used at all. Only a value from layers
        // 2–5 is worth a warning, and only that is recorded as discarded (§5, §10).
        const discarded =
          supplied !== undefined && supplied.source !== 'default' ? supplied : undefined;
        if (discarded !== undefined) {
          warnings.push(
            `${id} was set from ${SOURCE_NAMES[discarded.source]}, but its condition is false — the value is ignored`,
          );
          warnIfUnreliablyMasked(id, suppliedSecrets.get(id), warnings);
        }
        states.set(id, {
          id,
          spec,
          enabled: false,
          value: handler.empty(spec),
          source: undefined,
          rejection: undefined,
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
          rejection: undefined,
          ignored: undefined,
        });
        order.push(id);
        continue;
      }

      if (handler.secret) {
        warnIfUnreliablyMasked(id, suppliedSecrets.get(id), warnings);
      }

      const coerced = coerce(supplied, spec, id, context, inputIndex, redactor);
      if (!coerced.ok) {
        const issue: RuneIssue = {
          code: 'RUNE-202',
          message: coerced.message,
          location: supplied.location,
        };
        issues.push(
          supplied.valuesDocumentOrdinal === undefined
            ? issue
            : withValuesDocumentOrdinal(issue, supplied.valuesDocumentOrdinal),
        );
        states.set(id, {
          id,
          spec,
          enabled: true,
          value: undefined,
          source: undefined,
          rejection: { candidate: coerced.candidate, source: supplied.source, issue },
          ignored: undefined,
        });
        order.push(id);
        continue;
      }

      states.set(id, {
        id,
        spec,
        enabled: true,
        value: coerced.value,
        source: supplied.source,
        rejection: undefined,
        ignored: undefined,
      });
      order.push(id);
    }
  } catch (cause) {
    if (
      hasDeferredValuesProblems &&
      (cause instanceof ResolutionError || cause instanceof ConditionError)
    ) {
      throwCollectedInputIssues(issues);
    }
    throw cause;
  }

  const hasUnknownKey = issues.some((issue) => issue.code === 'RUNE-203');
  if (
    issues.length > 0 &&
    ((options.invalidValues ?? 'throw') === 'throw' || hasUnknownKey || hasDeferredValuesProblems)
  ) {
    throwCollectedInputIssues(issues);
  }

  const frozenIssues = issues.map((issue) => freezeIssue(redactIssue(issue, redactor)));
  const issueReplacements = new Map(issues.map((issue, index) => [issue, frozenIssues[index]!]));
  for (const [id, state] of states) {
    if (state.rejection === undefined) {
      continue;
    }
    const issue = issueReplacements.get(state.rejection.issue);
    if (issue === undefined) {
      throw new InternalError(`the rejection of input "${id}" has no collected issue`);
    }
    states.set(id, {
      ...state,
      rejection: {
        ...state.rejection,
        candidate: redactCandidate(state.rejection.candidate, redactor),
        issue,
      },
    });
  }

  const inputs = Object.freeze(
    order
      .map((id) => states.get(id))
      .filter((state) => state !== undefined)
      .map(snapshotInputState),
  );
  const canonicalById = new Map(inputs.map((state) => [state.id, state]));
  const publicById = Object.freeze(new ImmutableReadonlyMap(canonicalById));
  const missing = Object.freeze(
    inputs.filter((state) => stillNeeded(state)).map((state) => state.id),
  );
  const frozenWarnings = Object.freeze(
    warnings.map((warning) => escapeDiagnosticText(redactor.mask(warning))),
  );
  const problems = Object.freeze(frozenIssues);
  const secretMasker = stagedSecrets.snapshot();
  const resolution: Resolution = Object.freeze({
    inputs,
    byId: publicById,
    missing,
    warnings: frozenWarnings,
    problems,
  });
  const snapshot: ResolutionSnapshot = Object.freeze({
    manifest,
    context,
    inputIndex,
    inputs,
    byId: canonicalById,
    secrets: secretMasker,
    missing,
    warnings: frozenWarnings,
    problems,
  });

  // Publish only after every caller-visible object and execution capability is complete.
  publishedSecrets.replaceWith(stagedSecrets);
  resolutionSnapshots.set(resolution, snapshot);
  return resolution;
}

function snapshotInputState(state: InputState): InputState {
  const value = Array.isArray(state.value) ? Object.freeze([...state.value]) : state.value;
  const rejection =
    state.rejection === undefined
      ? undefined
      : Object.freeze({
          ...state.rejection,
          candidate: Array.isArray(state.rejection.candidate)
            ? Object.freeze([...state.rejection.candidate])
            : state.rejection.candidate,
        });
  return Object.freeze({ ...state, value, rejection });
}

function freezeIssue(issue: RuneIssue): RuneIssue {
  const location = issue.location === undefined ? undefined : Object.freeze({ ...issue.location });
  return Object.freeze({ ...issue, location });
}

/** Throws collected issues under their aggregate code, preserving the existing taxonomy. */
function throwCollectedInputIssues(issues: readonly RuneIssue[]): never {
  // A batch of nothing but unknown keys is an unknown-key error; anything mixed is about
  // the values (§7).
  const onlyUnknownKeys = issues.every((issue) => issue.code === 'RUNE-203');
  throw InputError.fromIssues(onlyUnknownKeys ? 'RUNE-203' : 'RUNE-202', issues);
}

interface StagedSecret {
  readonly supplied: SuppliedValue;
  /** Undefined means no raw candidate could be read safely as authentic secret text. */
  readonly maskable: boolean | undefined;
}

/**
 * Registers every safely readable layer-2–5 candidate for each declared secret before
 * resolution can diagnose anything. The registry remains staged until success, but it can
 * already redact an error raised by an earlier-declared input. Candidate registration is
 * deliberately separate from precedence: the winning value and its provenance are unchanged.
 */
function stageSuppliedSecrets(
  options: ResolveInputsOptions,
  ids: readonly string[],
  values: ValuesLayerIndex,
  stagedSecrets: SecretRegistry,
): ReadonlyMap<string, StagedSecret> {
  const suppliedSecrets = new Map<string, StagedSecret>();

  for (const id of ids) {
    const spec = options.manifest.inputs[id];
    if (spec?.type !== 'secret') {
      continue;
    }

    const fromValues = values.byId.get(id);
    const fromEnvironment = environmentLayer(id, options);
    const fromSet = overrideLayer(id, options);
    const fromAnswer = answerLayer(id, options);
    const supplied = fromAnswer ?? fromSet ?? fromEnvironment ?? fromValues;
    if (supplied === undefined) {
      continue;
    }

    let maskable: boolean | undefined;
    const registerCandidate = (candidate: SuppliedValue | undefined): void => {
      if (candidate === undefined) return;
      const candidateMaskable = stagedSecrets.registerCandidate(candidate.raw);
      if (candidateMaskable === undefined) {
        return;
      }
      maskable = maskable === undefined ? candidateMaskable : maskable && candidateMaskable;
    };

    for (const candidate of values.candidatesById.get(id) ?? []) {
      registerCandidate(candidate);
    }
    registerCandidate(fromEnvironment);
    registerCandidate(fromSet);
    registerCandidate(fromAnswer);

    suppliedSecrets.set(id, {
      supplied,
      maskable,
    });
  }

  return suppliedSecrets;
}

function warnIfUnreliablyMasked(
  id: string,
  staged: StagedSecret | undefined,
  warnings: string[],
): void {
  if (staged?.maskable === false) {
    warnings.push(
      `${id} cannot be masked reliably: all or part of its value may appear in logs; it needs non-empty content, and each content line must be at least 4 characters after trimming whitespace`,
    );
  }
}

/** Redacts the frontend-readable parts of a collected rejected value. */
function redactCandidate(
  candidate: InputRejection['candidate'],
  secrets: SecretRegistry,
): InputRejection['candidate'] {
  if (typeof candidate === 'string') {
    return secrets.mask(candidate);
  }
  if (Array.isArray(candidate)) {
    return Object.freeze(candidate.map((entry) => secrets.mask(entry)));
  }
  return candidate;
}

function redactIssue(issue: RuneIssue, secrets: SecretRegistry): RuneIssue {
  return {
    ...issue,
    message: escapeDiagnosticText(secrets.mask(issue.message)),
    location: redactLocation(issue.location, secrets),
  };
}

/** Redacts a source name without changing or retaining the caller-owned location object. */
function redactLocation(
  location: Location | undefined,
  secrets: SecretRegistry,
): Location | undefined {
  return location === undefined
    ? undefined
    : {
        file: secrets.mask(location.file),
        line: location.line,
        column: location.column,
      };
}

/**
 * Sanitizes a deliberate resolver error in place, preserving its class, code, cause chain,
 * property descriptors, object identity, and exit-code identity. Reporting locations are
 * replaced with redacted copies, so caller-owned location objects remain untouched.
 */
function redactRuneError(error: RuneError, secrets: SecretRegistry): RuneError {
  redactError(error, secrets, new Set());
  return error;
}

function redactError(error: Error, secrets: SecretRegistry, seen: Set<Error>): void {
  if (seen.has(error)) {
    return;
  }
  seen.add(error);

  const rawMessage = error.message;
  const rawStack = error.stack;
  const messageWasFormattedFromIssues =
    error instanceof RuneError && rawMessage === formatIssues(error.issues);
  const redactedIssues =
    error instanceof RuneError
      ? error.issues.map((issue) => redactIssue(issue, secrets))
      : undefined;
  const maskedMessage = secrets.mask(rawMessage);
  error.message =
    messageWasFormattedFromIssues && redactedIssues !== undefined
      ? formatIssues(redactedIssues)
      : escapeDiagnosticText(maskedMessage);
  if (rawStack !== undefined) {
    const maskedStack = secrets.mask(rawStack);
    const maskedHeader = secrets.mask(`${error.name}: ${rawMessage}`);
    error.stack = sanitizeMaskedStack(maskedStack, maskedHeader);
  }

  if (error instanceof RuneError) {
    Object.defineProperty(error, 'location', {
      ...Object.getOwnPropertyDescriptor(error, 'location'),
      value: redactLocation(error.location, secrets),
    });
    Object.defineProperty(error, 'issues', {
      ...Object.getOwnPropertyDescriptor(error, 'issues'),
      value: redactedIssues,
    });
  }

  if (error.cause instanceof Error) {
    redactError(error.cause, secrets, seen);
  } else if (typeof error.cause === 'string') {
    Object.defineProperty(error, 'cause', {
      ...Object.getOwnPropertyDescriptor(error, 'cause'),
      value: escapeDiagnosticText(secrets.mask(error.cause)),
    });
  }
}

/** Escapes stack content while retaining only the formatter's LF frame separators. */
function sanitizeMaskedStack(maskedStack: string, maskedHeader: string): string {
  if (!maskedStack.startsWith(maskedHeader)) {
    return escapeDiagnosticText(maskedStack);
  }

  const suffix = maskedStack.slice(maskedHeader.length);
  const safeSuffix = suffix
    .split('\n')
    .map((frame) => escapeDiagnosticText(frame))
    .join('\n');
  return escapeDiagnosticText(maskedHeader) + safeSuffix;
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
  /** The values-file invocation order, when this value came from that layer. */
  readonly valuesDocumentOrdinal?: number;
}

/** One values-file entry retained for unknown-key validation in source order. */
interface ValuesLayerEntry {
  readonly id: string;
  readonly origin: string;
  readonly location: Location;
  readonly documentOrdinal: number;
}

interface ValuesLayerProblem {
  readonly problem: DeferredValuesProblem;
  readonly documentOrdinal: number;
}

interface ValuesLayerIndex {
  readonly byId: ReadonlyMap<string, SuppliedValue>;
  /** Every entry per id in document order, retained for secret candidate staging. */
  readonly candidatesById: ReadonlyMap<string, readonly SuppliedValue[]>;
  readonly entries: readonly ValuesLayerEntry[];
  readonly problems: readonly ValuesLayerProblem[];
}

function materializeValuesProblem(
  problem: DeferredValuesProblem,
  redactor: SecretRegistry,
): RuneIssue {
  return 'kind' in problem
    ? {
        code: 'RUNE-202',
        message: formatDiagnostic([quotedDiagnostic(problem.rawKey), ' ', problem.reason], (part) =>
          redactor.mask(part),
        ),
        location: problem.location,
      }
    : { code: problem.code, message: problem.message, location: problem.location };
}

/**
 * Folds values files once per resolution. Later documents replace earlier values per input,
 * while the entry list preserves unknown-key diagnostics and their suggestion order.
 */
function indexValuesLayer(documents: readonly ValuesDocument[] | undefined): ValuesLayerIndex {
  const byId = new Map<string, SuppliedValue>();
  const candidatesById = new Map<string, SuppliedValue[]>();
  const entries: ValuesLayerEntry[] = [];
  const problems: ValuesLayerProblem[] = [];

  let documentOrdinal = 0;
  for (const document of documents ?? []) {
    problems.push(...(document.problems ?? []).map((problem) => ({ problem, documentOrdinal })));
    for (const [id, raw] of document.values) {
      const location = document.sourceMap?.best([id]) ?? startOfFile(document.file);
      const supplied = {
        source: 'values',
        raw,
        location,
        origin: document.file,
        valuesDocumentOrdinal: documentOrdinal,
      } as const;
      byId.set(id, supplied);
      const candidates = candidatesById.get(id);
      if (candidates === undefined) {
        candidatesById.set(id, [supplied]);
      } else {
        candidates.push(supplied);
      }
      entries.push({ id, origin: document.file, location, documentOrdinal });
    }
    documentOrdinal += 1;
  }

  return { byId, candidatesById, entries, problems };
}

/** The value of the highest layer that supplied one, which is the value that wins (§5). */
function highestLayer(
  id: string,
  spec: InputSpec,
  options: ResolveInputsOptions,
  values: ReadonlyMap<string, SuppliedValue>,
): SuppliedValue | undefined {
  const answer = answerLayer(id, options);
  if (answer !== undefined) {
    return answer;
  }

  const override = overrideLayer(id, options);
  if (override !== undefined) {
    return override;
  }

  const fromEnvironment = environmentLayer(id, options);
  if (fromEnvironment !== undefined) {
    return fromEnvironment;
  }

  const fromValues = values.get(id);
  if (fromValues !== undefined) {
    return fromValues;
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

function answerLayer(id: string, options: ResolveInputsOptions): SuppliedValue | undefined {
  if (!options.answers?.has(id)) {
    return undefined;
  }
  return {
    source: 'answer',
    raw: options.answers.get(id),
    location: undefined,
    origin: SOURCE_NAMES.answer,
  };
}

function overrideLayer(id: string, options: ResolveInputsOptions): SuppliedValue | undefined {
  if (!options.overrides?.has(id)) {
    return undefined;
  }
  return {
    source: 'set',
    raw: options.overrides.get(id),
    location: undefined,
    origin: `--set ${id}=…`,
  };
}

function environmentLayer(id: string, options: ResolveInputsOptions): SuppliedValue | undefined {
  const variable = environmentName(id);
  const raw = options.context.environmentValue(variable);
  return raw === undefined
    ? undefined
    : {
        source: 'environment',
        raw,
        location: undefined,
        origin: `the environment variable ${variable}`,
      };
}

type CoercionOutcome =
  | { readonly ok: true; readonly value: InputValue }
  | {
      readonly ok: false;
      readonly message: string;
      readonly candidate: InputRejection['candidate'];
    };

function coerce(
  supplied: SuppliedValue,
  spec: InputSpec,
  id: string,
  context: RuntimeContext,
  inputIndex: InputReferenceIndex,
  secrets: SecretRegistry,
): CoercionOutcome {
  const handler = inputTypes.get(spec.type);
  let raw = supplied.raw;

  // A default is a template: it is rendered before it is read, and it may name only what is
  // known before the other inputs are (§6.1). A reference that resolves to nothing is a
  // resolution error and stays one — it is not a value a user got wrong (§7, invariant 9).
  if (supplied.source === 'default' && typeof raw === 'string' && isTemplated(spec)) {
    raw = renderDefault(raw, id, context, inputIndex);
  }

  const result =
    typeof raw === 'string' ? handler.fromString(raw, spec) : handler.fromNative(raw, spec);

  // The type names the value and says what is wrong with it; resolution adds which input it
  // belongs to and where the value came from, which is what a reader needs to go and fix it.
  if (result.ok) {
    return result;
  }

  const reason =
    result.diagnosticParts === undefined
      ? escapeDiagnosticText(secrets.mask(result.message))
      : formatDiagnostic(result.diagnosticParts, (part) => secrets.mask(part));
  return {
    ok: false,
    message: escapeDiagnosticText(secrets.mask(`${id} (from ${supplied.origin}): ${reason}`)),
    candidate: rejectedCandidate(raw, handler.secret),
  };
}

/** Retains only values that are safe for a frontend to prefill after validation failed. */
function rejectedCandidate(raw: unknown, secret: boolean): InputRejection['candidate'] {
  if (secret) {
    return undefined;
  }
  if (typeof raw === 'string' || typeof raw === 'boolean') {
    return raw;
  }
  return nativeStringArraySnapshot(raw);
}

/** Only the free-text types carry templates; a select default is one of its option values. */
function isTemplated(spec: InputSpec): boolean {
  return spec.type === 'text' || spec.type === 'file' || spec.type === 'directory';
}

function renderDefault(
  text: string,
  id: string,
  context: RuntimeContext,
  inputIndex: InputReferenceIndex,
): string {
  const where = `inputs.${id}.default`;
  return renderTemplate(text, (reference) => {
    // No inputs are in scope: a default is rendered before the other inputs are known, which
    // `validate` already refused to let an author rely on.
    const resolved = resolveReference(reference.segments, inputIndex, 0);
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
  inputIndex: InputReferenceIndex,
  visibleInputCount: number,
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
      lookup(reference, inputIndex, visibleInputCount, states, context),
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
  inputIndex: InputReferenceIndex,
  visibleInputCount: number,
  states: ReadonlyMap<string, InputState>,
  context: RuntimeContext,
): ConditionValue {
  const resolved = resolveReference(reference.segments, inputIndex, visibleInputCount);
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
  inputIndex: InputReferenceIndex,
  values: readonly ValuesLayerEntry[],
  issues: RuneIssue[],
  secrets: SecretRegistry,
): void {
  const candidateWidth = suggestionCandidateWidth(inputIndex.orderedIds);
  let remainingSuggestionWork = UNKNOWN_KEY_SUGGESTION_WORK_BUDGET;

  const report = (
    key: string,
    origin: string,
    location: Location | undefined,
    documentOrdinal?: number,
  ): void => {
    if (inputIndex.ordinals.has(key)) {
      return;
    }
    const work = suggestionWork(key, candidateWidth);
    const suggestion =
      work <= remainingSuggestionWork ? suggest(key, inputIndex.orderedIds) : undefined;
    if (work <= remainingSuggestionWork) {
      remainingSuggestionWork -= work;
    }
    const parts = [
      quotedDiagnostic(key),
      ' is not an input of this manifest',
      ...(suggestion === undefined ? [] : [' — did you mean ', quotedDiagnostic(suggestion), '?']),
      ' (set from ',
      origin,
      ')',
    ];
    const issue: RuneIssue = {
      code: 'RUNE-203',
      message: formatDiagnostic(parts, (part) => secrets.mask(part)),
      location,
    };
    issues.push(
      documentOrdinal === undefined ? issue : withValuesDocumentOrdinal(issue, documentOrdinal),
    );
  };

  for (const key of options.overrides?.keys() ?? []) {
    report(key, SOURCE_NAMES.set, undefined);
  }
  for (const entry of values) {
    report(entry.id, entry.origin, entry.location, entry.documentOrdinal);
  }
  for (const key of options.answers?.keys() ?? []) {
    report(key, 'the answer', undefined);
  }
}

/**
 * Conservative cost of one `suggest()` call: its possible matrix rows times all candidate
 * columns. Widths use the same lowercased strings as `suggest`, since lowercasing can expand
 * a Unicode string. Every operation saturates at the budget cap to avoid numeric overflow.
 */
function suggestionWork(key: string, candidateWidth: number): number {
  return saturatingProduct(suggestionStringWidth(key), candidateWidth);
}

function suggestionCandidateWidth(ids: readonly string[]): number {
  return ids.reduce((width, id) => saturatingAdd(width, suggestionStringWidth(id)), 0);
}

function suggestionStringWidth(value: string): number {
  return Math.min(value.toLowerCase().length + 1, SUGGESTION_WORK_CAP);
}

function saturatingAdd(left: number, right: number): number {
  return left >= SUGGESTION_WORK_CAP - right ? SUGGESTION_WORK_CAP : left + right;
}

function saturatingProduct(left: number, right: number): number {
  if (left === 0 || right === 0) {
    return 0;
  }
  return left > Math.floor(SUGGESTION_WORK_CAP / right) ? SUGGESTION_WORK_CAP : left * right;
}

/**
 * Reads a values file (§5, layer 2): one flat mapping of input id to value. Values are
 * written in their own type — a YAML boolean, a list of strings — or as strings; anything
 * else is refused here, where the file and the line are still known.
 */
export function parseValuesFile(path: string, file: string = path): ValuesDocument {
  let document: ReturnType<typeof loadYamlFile>;
  try {
    document = loadYamlFile(file, path);
  } catch (cause) {
    if (cause instanceof ManifestError) {
      return {
        file,
        values: new Map(),
        problems: valuesFileLoadProblems(cause, file),
      };
    }
    throw cause;
  }
  const values = new Map<string, unknown>();
  const issues: DeferredValuesProblem[] = [];

  const raw = document.value;
  if (document.isEmpty) {
    return { file: document.file, values, sourceMap: document.sourceMap };
  }

  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    return {
      file: document.file,
      values,
      sourceMap: document.sourceMap,
      problems: [
        {
          code: 'RUNE-202',
          message: `${file} must contain a mapping of input ids to values`,
          location: document.sourceMap.best([]) ?? startOfFile(document.file),
        },
      ],
    };
  }

  for (const [key, value] of Object.entries(raw)) {
    const location = document.sourceMap.best([key]) ?? startOfFile(document.file);
    const problem = shapeProblem(value);
    if (problem === undefined) {
      values.set(key, value);
    } else {
      issues.push({
        kind: 'shape',
        rawKey: key,
        reason: problem,
        location,
      });
    }
  }

  return {
    file: document.file,
    values,
    sourceMap: document.sourceMap,
    ...(issues.length > 0 ? { problems: issues } : {}),
  };
}

/** Values files are runtime input, even though they share the manifest YAML loader. */
function valuesFileLoadProblems(error: ManifestError, file: string): readonly RuneIssue[] {
  const fallbackLocation = error.location ?? startOfFile(file);
  return error.issues.map((issue) => ({
    code: 'RUNE-202' as const,
    message: valuesFileLoaderMessage(issue.message, file),
    location: issue.location ?? fallbackLocation,
  }));
}

/**
 * Removes document content from YAML loader diagnostics before they cross the values-file
 * boundary. At this point no input type is known, so a tag or alias name may itself be a
 * secret value. File-system categories and key-only structural errors are safe and useful;
 * parser diagnostics are reduced to stable categories instead of quoting their tokens.
 */
function valuesFileLoaderMessage(message: string, file: string): string {
  if (message === `${file} is not a file`) {
    return message;
  }
  if (message.startsWith(`${file} is larger than the `) && message.endsWith(' MiB limit')) {
    return message;
  }
  if (message === `${file} is not valid UTF-8`) {
    return message;
  }
  if (message.startsWith(`${file} cannot be read:`)) {
    return `${file} cannot be read`;
  }
  if (message.startsWith('duplicate key "')) {
    return 'a mapping key is defined more than once';
  }
  if (
    message === 'a mapping key must be a plain scalar' ||
    message === 'a mapping key must not be empty' ||
    message === '__proto__ is not allowed as a key'
  ) {
    return message;
  }
  if (/\btag(?:s)?\b/iu.test(message)) {
    return 'YAML tags are not allowed in values files';
  }
  if (message.startsWith('Unresolved alias')) {
    return 'YAML alias refers to an anchor that has not been defined yet';
  }
  if (message === 'Excessive alias count indicates a resource exhaustion attack') {
    return 'YAML alias expansion exceeds the safety limit';
  }
  if (/\b(?:alias(?:es)?|anchor(?:s)?)\b/iu.test(message)) {
    return 'invalid YAML alias or anchor syntax';
  }
  return 'invalid YAML syntax';
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
