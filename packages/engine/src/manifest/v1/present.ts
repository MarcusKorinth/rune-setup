/**
 * Turns schema violations into the messages RUNE actually prints (docs/architecture.md §4.3):
 * `installer.yaml:41:7: steps[2].run.windows.args must be a list of strings`.
 *
 * Error presentation is owned by RUNE, not by the validation library: every problem is
 * located in the source, unknown keys get a "did you mean …?" suggestion, and keys that are
 * reserved for a later schema version say so instead of looking like a typo (invariant 12).
 */

import { orderIssues, type RuneIssue } from '../../errors.js';
import {
  formatPath,
  startOfFile,
  type Location,
  type PathSegment,
  type SourceMap,
} from '../source.js';
import { INPUT_ID, KNOWN_KEYS } from './schema.js';

/**
 * The structural part of a validation issue this module relies on. Depending on a shape
 * rather than on the library's own types keeps the presenter stable across its releases.
 */
interface IssueLike {
  readonly code: string;
  readonly path: readonly PropertyKey[];
  readonly message: string;
  // Optional members are declared with an explicit `| undefined` so that issues from a
  // library that models them that way stay assignable under exactOptionalPropertyTypes.
  readonly keys?: readonly string[] | undefined;
  readonly expected?: string | undefined;
  readonly values?: readonly unknown[] | undefined;
  readonly errors?: readonly (readonly IssueLike[])[] | undefined;
  readonly minimum?: number | bigint | undefined;
  readonly maximum?: number | bigint | undefined;
  readonly inclusive?: boolean | undefined;
  readonly origin?: string | undefined;
  readonly format?: string | undefined;
  readonly pattern?: string | undefined;
  /** Set when a discriminated union found no matching branch. */
  readonly options?: readonly unknown[] | undefined;
  readonly discriminator?: string | undefined;
  /** Set when a mapping key itself failed validation; carries the key's own problems. */
  readonly issues?: readonly IssueLike[] | undefined;
}

/** Origins whose bound is a size; everything else is bounded by value, not by length. */
function isSized(origin: string | undefined): boolean {
  return origin === undefined || ['string', 'array', 'set', 'map', 'file'].includes(origin);
}

/** `/^[a-z]+$/` as written in a message: without the delimiters a reader does not need. */
function patternSource(pattern: string): string {
  return pattern.replace(/^\//, '').replace(/\/[a-z]*$/, '');
}

export interface PresentContext {
  readonly file: string;
  readonly sourceMap: SourceMap;
  /** The document as loaded, used to tell "missing" from "wrong type" and to pick branches. */
  readonly raw: unknown;
}

/** Keys accepted only by a later schema version — rejected today, but not as typos. */
const RESERVED_KEYS: Readonly<Record<string, readonly string[]>> = {
  root: ['license', 'assets', 'locales', 'plugins', 'uninstall', 'update', 'repair', 'packaging'],
  execution: ['elevation', 'retries', 'parallel', 'rollback', 'restart', 'continueOnError'],
  step: [
    'dependsOn',
    'needs',
    'retries',
    'elevation',
    'rollback',
    'outputs',
    'parallel',
    'onFailure',
    'continueOnError',
  ],
  // `darwin` alongside `macos`: it is what Node calls the platform, so authors write both.
  platformRun: ['macos', 'darwin'],
  run: ['macos', 'darwin'],
  // A `run:` that already names a command reads as the command form, so the same two names
  // have to be reserved here too: an author reaching for macOS is told that it is coming, not
  // that they mistyped one of `command`'s keys.
  command: ['macos', 'darwin'],
  input: ['validate', 'group', 'page', 'hidden'],
};

/**
 * Keys that will never be accepted, with the reason. A `Map` rather than an object literal:
 * the repository's static-safety lint rule rejects any property literally named `shell`,
 * and this table is data *about* that key, not a place that could ever set it.
 */
const FORBIDDEN_KEYS = new Map<string, string>([
  [
    'shell',
    'RUNE executes argv arrays only and never through a shell — pass the interpreter as `command` with its arguments in `args`',
  ],
]);

type MappingKind =
  | 'root'
  | 'product'
  | 'execution'
  | 'gui'
  | 'input'
  | 'step'
  | 'command'
  | 'platformRun'
  /** A `run:` mapping that named neither a command nor a platform — it could be either. */
  | 'run'
  | 'option'
  | 'unknown';

/** Converts a batch of validation issues into located, human messages. */
export function presentIssues(issues: readonly IssueLike[], ctx: PresentContext): RuneIssue[] {
  const presented: RuneIssue[] = [];
  for (const issue of flatten(issues, ctx)) {
    presented.push(...present(issue, ctx));
  }
  return orderIssues(presented);
}

/**
 * Union failures carry one issue list per branch. Reporting all of them would bury the real
 * problem, so a single branch is chosen: the one that came closest to matching.
 */
function flatten(issues: readonly IssueLike[], ctx: PresentContext): IssueLike[] {
  const out: IssueLike[] = [];
  for (const issue of issues) {
    // A discriminated union that matched no branch reports the discriminator itself; the
    // useful message names the accepted values, so it is turned into a plain value problem.
    if (issue.code === 'invalid_union' && issue.options && (issue.errors?.length ?? 0) === 0) {
      out.push({ ...issue, code: 'invalid_value', values: issue.options });
      continue;
    }

    if (issue.code !== 'invalid_union' || !issue.errors || issue.errors.length === 0) {
      out.push(issue);
      continue;
    }

    // Branch issues are reported relative to the union, so they only make sense once the
    // union's own path is put back in front of them.
    const branches = issue.errors.map((branch) =>
      branch.map((inner) => ({ ...inner, path: [...issue.path, ...inner.path] })),
    );

    const combined = combineTypeAlternatives(issue, branches);
    if (combined) {
      out.push(combined);
      continue;
    }

    // A branch whose only complaint is "this is not my type" never looked inside the value,
    // so it cannot describe what is actually wrong with it. Drop those as long as another
    // branch did look inside; if none did, every branch really rejected the type and the
    // full list is the right input again.
    const inspected = branches.filter((branch) => !rejectsOutright(branch, issue.path));
    const candidates = inspected.length > 0 ? inspected : branches;

    let best = candidates[0] ?? [];
    for (const branch of candidates) {
      if (isBetterMatch(branch, best, issue.path.length)) {
        best = branch;
      }
    }
    out.push(...flatten(best, ctx));
  }
  return out;
}

/**
 * How badly a branch mismatched. Counting reported *problems* rather than issue objects
 * matters because one "unrecognized keys" issue can carry many keys — the branch that
 * rejects three keys at once is a worse match than the one that rejects two things.
 */
function weigh(issues: readonly IssueLike[]): number {
  return issues.reduce(
    (total, issue) =>
      total + (issue.code === 'unrecognized_keys' && issue.keys ? issue.keys.length : 1),
    0,
  );
}

/**
 * What a branch holds against the value *itself*: that it is not of this branch's type, or
 * that it carries keys this branch does not know. Problems reported deeper inside the value
 * do not count — a branch that got past the shape and only objects to the contents is the
 * form the author meant, however much detail it then reports.
 */
function shapeWeight(issues: readonly IssueLike[], depth: number): number {
  let total = 0;
  for (const issue of issues) {
    if (issue.path.length !== depth) {
      continue;
    }
    if (issue.code === 'unrecognized_keys' && issue.keys) {
      total += issue.keys.length;
    } else if (issue.code === 'invalid_type') {
      total += 1;
    }
  }
  return total;
}

/** True when a branch rejected the value as a whole rather than objecting to its contents. */
function rejectsOutright(issues: readonly IssueLike[], unionPath: readonly PropertyKey[]): boolean {
  const only = issues.length === 1 ? issues[0] : undefined;
  return only !== undefined && only.code === 'invalid_type' && samePath(only.path, unionPath);
}

/** Prefers the branch that recognized the value's shape, then the one with fewer problems. */
function isBetterMatch(
  candidate: readonly IssueLike[],
  incumbent: readonly IssueLike[],
  depth: number,
): boolean {
  const candidateShape = shapeWeight(candidate, depth);
  const incumbentShape = shapeWeight(incumbent, depth);
  return candidateShape === incumbentShape
    ? weigh(candidate) < weigh(incumbent)
    : candidateShape < incumbentShape;
}

/**
 * When every branch rejects the same value for being the wrong type, the useful message
 * names the alternatives once ("must be a string or a mapping") instead of arbitrarily
 * picking one branch's complaint.
 */
function combineTypeAlternatives(
  issue: IssueLike,
  branches: readonly (readonly IssueLike[])[],
): IssueLike | undefined {
  const expected: string[] = [];
  for (const branch of branches) {
    const only = branch.length === 1 ? branch[0] : undefined;
    if (!only || only.code !== 'invalid_type' || only.expected === undefined) {
      return undefined;
    }
    if (samePath(only.path, issue.path) && !expected.includes(only.expected)) {
      expected.push(only.expected);
    } else if (!samePath(only.path, issue.path)) {
      return undefined;
    }
  }
  if (expected.length < 2) {
    return undefined;
  }
  return { code: 'invalid_type_union', path: issue.path, message: '', values: expected };
}

function samePath(a: readonly PropertyKey[], b: readonly PropertyKey[]): boolean {
  return a.length === b.length && a.every((segment, index) => segment === b[index]);
}

function present(issue: IssueLike, ctx: PresentContext): RuneIssue[] {
  const path = normalizePath(issue.path);

  if (issue.code === 'unrecognized_keys' && issue.keys) {
    return issue.keys.map((key) => ({
      code: 'RUNE-103' as const,
      message: describeUnknownKey(path, key, ctx),
      location: locate([...path, key], ctx),
    }));
  }

  return [
    { code: 'RUNE-103', message: describeIssue(issue, path, ctx), location: locate(path, ctx) },
  ];
}

function describeIssue(
  issue: IssueLike,
  path: readonly PathSegment[],
  ctx: PresentContext,
): string {
  const where = formatPath(path);

  switch (issue.code) {
    case 'invalid_type': {
      if (valueAt(ctx.raw, path) === undefined) {
        return `${where} is required`;
      }
      return `${where} must be ${describeExpected(issue.expected)}`;
    }
    case 'invalid_type_union': {
      const alternatives = (issue.values ?? []).map((value) => describeExpected(String(value)));
      return `${where} must be ${joinWithOr(alternatives)}`;
    }
    case 'invalid_value': {
      const values = issue.values ?? [];
      if (valueAt(ctx.raw, path) === undefined) {
        return `${where} is required (one of: ${values.map((value) => JSON.stringify(value)).join(', ')})`;
      }
      if (values.length === 1) {
        return `${where} must be ${JSON.stringify(values[0])}`;
      }
      return `${where} must be one of: ${values.map((value) => JSON.stringify(value)).join(', ')}`;
    }
    case 'too_small': {
      if (!isSized(issue.origin)) {
        return `${where} must be ${issue.inclusive ? 'at least' : 'greater than'} ${String(issue.minimum)}`;
      }
      if (issue.minimum !== undefined && Number(issue.minimum) <= 1) {
        return `${where} must not be empty`;
      }
      return `${where} must have at least ${String(issue.minimum)} entries`;
    }
    case 'too_big': {
      if (!isSized(issue.origin)) {
        return `${where} must be ${issue.inclusive ? 'at most' : 'less than'} ${String(issue.maximum)}`;
      }
      return `${where} must have at most ${String(issue.maximum)} entries`;
    }
    case 'invalid_format': {
      if (issue.format === 'regex' && issue.pattern !== undefined) {
        const value = valueAt(ctx.raw, path);
        const quoted = typeof value === 'string' ? ` "${value}"` : '';
        return `${where}${quoted} must match ${patternSource(issue.pattern)}`;
      }
      return `${where} is not a valid ${issue.format ?? 'value'}`;
    }
    case 'invalid_key': {
      const inner = issue.issues?.[0];
      if (path[0] === 'inputs' && path.length === 2) {
        const id = String(path[1]);
        return `input id "${id}" must match ${INPUT_ID.source} — it is used as \${${id}} in commands and conditions`;
      }
      return inner?.pattern === undefined
        ? `${where} is not an allowed key`
        : `${where} must match ${patternSource(inner.pattern)}`;
    }
    default:
      return `${where}: ${issue.message}`;
  }
}

function describeExpected(expected: string | undefined): string {
  switch (expected) {
    case 'string':
      return 'a string';
    case 'number':
      return 'a number';
    case 'int':
      return 'an integer';
    case 'boolean':
      return 'a boolean';
    case 'array':
      return 'a list';
    case 'object':
    case 'record':
      return 'a mapping';
    case 'null':
      return 'null';
    case undefined:
      return 'a different type';
    default:
      return `a ${expected}`;
  }
}

function joinWithOr(parts: readonly string[]): string {
  if (parts.length <= 1) {
    return parts[0] ?? 'a different type';
  }
  return `${parts.slice(0, -1).join(', ')} or ${parts[parts.length - 1] ?? ''}`;
}

function describeUnknownKey(
  path: readonly PathSegment[],
  key: string,
  ctx: PresentContext,
): string {
  const where = formatPath([...path, key]);
  const kind = kindOf(path, ctx.raw);

  const forbidden = kind === 'command' || kind === 'run' ? FORBIDDEN_KEYS.get(key) : undefined;
  if (forbidden) {
    return `${where} is not allowed: ${forbidden}`;
  }

  const secretKey = kind === 'input' ? describeSecretKey(path, key, ctx) : undefined;
  if (secretKey) {
    return `${where} ${secretKey}`;
  }

  if ((RESERVED_KEYS[kind] ?? []).includes(key)) {
    return `${where} is reserved; accepted in a later schemaVersion`;
  }

  const suggestion = suggest(key, knownKeys(kind, path, ctx.raw));
  return suggestion === undefined
    ? `unknown key ${where}`
    : `unknown key ${where} — did you mean "${suggestion}"?`;
}

/**
 * `secret` inputs deliberately lack `default` and `pattern` (docs/architecture.md §4.2).
 * Saying why beats reporting them as unknown keys, which reads like a typo.
 */
function describeSecretKey(
  path: readonly PathSegment[],
  key: string,
  ctx: PresentContext,
): string | undefined {
  const input = valueAt(ctx.raw, path);
  if (!isRecord(input) || input['type'] !== 'secret') {
    return undefined;
  }
  if (key === 'default') {
    return 'is not allowed: a secret must not be written into the manifest — supply it through --set, RUNE_INPUT_*, or a values file';
  }
  if (key === 'pattern' || key === 'patternHint') {
    return 'is not allowed: pattern validation is not available on secret inputs, because the mismatch message would describe the secret';
  }
  return undefined;
}

/** Which mapping of the schema a document path points at. */
function kindOf(path: readonly PathSegment[], raw: unknown): MappingKind {
  const first = path[0];
  const third = path[2];
  const fourth = path[3];

  if (path.length === 0) return 'root';
  if (path.length === 1) {
    if (first === 'product') return 'product';
    if (first === 'execution') return 'execution';
    if (first === 'gui') return 'gui';
    return 'unknown';
  }
  if (first === 'inputs' && path.length === 2) return 'input';
  if (first === 'inputs' && path.length === 4 && third === 'options') return 'option';
  if (first === 'steps' && path.length === 2) return 'step';
  if (first === 'steps' && path.length === 3 && third === 'run') {
    const run = valueAt(raw, path);
    if (!isRecord(run)) {
      return 'run';
    }
    if ('command' in run) {
      return 'command';
    }
    // Neither form is recognizable — a misspelled `command` is as likely as a misspelled
    // platform, so both key sets are offered as candidates.
    return 'windows' in run || 'linux' in run ? 'platformRun' : 'run';
  }
  if (
    first === 'steps' &&
    path.length === 4 &&
    third === 'run' &&
    (fourth === 'windows' || fourth === 'linux')
  ) {
    return 'command';
  }
  return 'unknown';
}

function knownKeys(
  kind: MappingKind,
  path: readonly PathSegment[],
  raw: unknown,
): readonly string[] {
  switch (kind) {
    case 'root':
      return KNOWN_KEYS.root;
    case 'product':
      return KNOWN_KEYS.product;
    case 'execution':
      return KNOWN_KEYS.execution;
    case 'gui':
      return KNOWN_KEYS.gui;
    case 'step':
      return KNOWN_KEYS.step;
    case 'command':
      return KNOWN_KEYS.command;
    case 'platformRun':
      return KNOWN_KEYS.platformRun;
    case 'run':
      return [...KNOWN_KEYS.command, ...KNOWN_KEYS.platformRun];
    case 'option':
      return KNOWN_KEYS.option;
    case 'input': {
      const input = valueAt(raw, path);
      const type = isRecord(input) ? input['type'] : undefined;
      const keys = KNOWN_KEYS.input as Readonly<Record<string, readonly string[]>>;
      return (typeof type === 'string' ? keys[type] : undefined) ?? KNOWN_KEYS.input.text;
    }
    default:
      return [];
  }
}

/** Closest known key within a small edit distance — the classic "did you mean …?" nudge. */
function suggest(key: string, candidates: readonly string[]): string | undefined {
  let best: string | undefined;
  let bestDistance = Number.POSITIVE_INFINITY;
  const limit = key.length <= 4 ? 1 : 2;

  for (const candidate of candidates) {
    // Never suggest the key the author already wrote — it is a known key *somewhere else*,
    // and "did you mean windows?" about `windows:` reads like a broken tool.
    if (candidate.toLowerCase() === key.toLowerCase()) {
      return undefined;
    }
    const distance = editDistance(key.toLowerCase(), candidate.toLowerCase());
    if (distance < bestDistance) {
      bestDistance = distance;
      best = candidate;
    }
  }

  return bestDistance <= limit ? best : undefined;
}

function editDistance(a: string, b: string): number {
  let previous = Array.from({ length: b.length + 1 }, (_unused, index) => index);
  for (let i = 1; i <= a.length; i++) {
    const current = [i, ...Array.from<number>({ length: b.length }).fill(0)];
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      current[j] = Math.min(
        (current[j - 1] ?? 0) + 1,
        (previous[j] ?? 0) + 1,
        (previous[j - 1] ?? 0) + cost,
      );
    }
    previous = current;
  }
  return previous[b.length] ?? Math.max(a.length, b.length);
}

function normalizePath(path: readonly PropertyKey[]): PathSegment[] {
  return path.map((segment) => (typeof segment === 'number' ? segment : String(segment)));
}

function locate(path: readonly PathSegment[], ctx: PresentContext): Location | undefined {
  return ctx.sourceMap.best(path) ?? startOfFile(ctx.file);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Reads the value a document path points at, or `undefined` if it is not there. */
export function valueAt(raw: unknown, path: readonly PathSegment[]): unknown {
  let current: unknown = raw;
  for (const segment of path) {
    if (Array.isArray(current) && typeof segment === 'number') {
      current = current[segment];
    } else if (isRecord(current) && Object.hasOwn(current, String(segment))) {
      // Own properties only: an inherited member such as `toString` is not document content,
      // and treating it as one would turn "this key is missing" into a wrong-type complaint.
      current = current[String(segment)];
    } else {
      return undefined;
    }
  }
  return current;
}
