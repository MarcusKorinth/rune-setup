/**
 * The RUNE error taxonomy (docs/architecture.md §7) and the single owner of the
 * error → exit-code map (§10). Every failure RUNE reports carries a stable `RUNE-xxx`
 * code, a message, and — where it comes from a file — a source location.
 */

import { formatLocation, type Location } from './manifest/source.js';

export type { Location };

/**
 * Stable error codes. They are machine contract: they appear in messages, in the result
 * file and (later) across the GUI bridge, so a code never changes meaning.
 */
export type RuneCode =
  | 'RUNE-001' // CLI misuse
  | 'RUNE-101' // manifest syntax
  | 'RUNE-102' // schemaVersion missing or unsupported
  | 'RUNE-103' // manifest schema
  | 'RUNE-104' // manifest semantics
  | 'RUNE-201' // required input missing
  | 'RUNE-202' // invalid input value
  | 'RUNE-203' // unknown input
  | 'RUNE-301' // undefined variable
  | 'RUNE-302' // interpolation syntax
  | 'RUNE-311' // condition syntax
  | 'RUNE-312' // condition type error
  | 'RUNE-401' // step exit code
  | 'RUNE-402' // step timeout
  | 'RUNE-403' // command not found
  | 'RUNE-404' // invalid working directory
  | 'RUNE-405' // shell-required command refused
  | 'RUNE-500' // internal error
  | 'RUNE-601'; // cancelled

/** One reported problem. Errors that collect many problems expose them as issues. */
export interface RuneIssue {
  readonly code: RuneCode;
  readonly message: string;
  readonly location: Location | undefined;
}

export interface RuneErrorOptions {
  readonly location?: Location;
  /** All collected problems; defaults to the single problem this error describes. */
  readonly issues?: readonly RuneIssue[];
  readonly cause?: unknown;
}

/** Renders issues one per line, each prefixed with `file:line:col` when it has a location. */
export function formatIssues(issues: readonly RuneIssue[]): string {
  return issues
    .map((issue) =>
      issue.location ? `${formatLocation(issue.location)}: ${issue.message}` : issue.message,
    )
    .join('\n');
}

/**
 * Puts a batch of problems into the order an author reads them — by position in the document,
 * each distinct problem once. Every layer that collects problems orders them through here, so
 * a shape batch and a semantics batch make the same promise instead of two different ones.
 */
export function orderIssues(issues: readonly RuneIssue[]): RuneIssue[] {
  const seen = new Set<string>();
  const unique: RuneIssue[] = [];
  for (const issue of issues) {
    const where = issue.location;
    // The file belongs in the identity: once values files and locale overlays share this
    // path, the same sentence about the same line of two documents is two problems.
    const id = `${where?.file ?? ''}:${where?.line ?? 0}:${where?.column ?? 0}:${issue.message}`;
    if (!seen.has(id)) {
      seen.add(id);
      unique.push(issue);
    }
  }
  return unique.sort(
    (a, b) =>
      (a.location?.line ?? 0) - (b.location?.line ?? 0) ||
      (a.location?.column ?? 0) - (b.location?.column ?? 0) ||
      // Code-unit order, not locale order: the golden files must read the same on every
      // machine, whatever locale it runs in and whether its Node carries the full ICU data.
      compareCodeUnits(a.message, b.message),
  );
}

function compareCodeUnits(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** The message of something that was thrown, whatever it was. */
export function messageOf(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

/** Base class of every error RUNE raises on purpose. */
export class RuneError extends Error {
  readonly code: RuneCode;
  readonly location: Location | undefined;
  readonly issues: readonly RuneIssue[];

  constructor(code: RuneCode, message: string, options: RuneErrorOptions = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = new.target.name;
    this.code = code;
    this.location = options.location;
    this.issues = options.issues ?? [{ code, message, location: options.location }];
  }
}

export type UsageCode = 'RUNE-001';
export type ManifestCode = 'RUNE-101' | 'RUNE-102' | 'RUNE-103' | 'RUNE-104';
export type InputCode = 'RUNE-201' | 'RUNE-202' | 'RUNE-203';
export type ResolutionCode = 'RUNE-301' | 'RUNE-302';
export type ConditionCode = 'RUNE-311' | 'RUNE-312';
export type ExecutionCode = 'RUNE-401' | 'RUNE-402' | 'RUNE-403' | 'RUNE-404' | 'RUNE-405';

/** The command line was used wrongly (exit 2). */
export class UsageError extends RuneError {
  constructor(message: string, options?: RuneErrorOptions) {
    super('RUNE-001', message, options);
  }
}

/** The manifest could not be read, parsed, or validated (exit 3). */
export class ManifestError extends RuneError {
  constructor(code: ManifestCode, message: string, options?: RuneErrorOptions) {
    super(code, message, options);
  }

  /** Builds one error from a batch of collected problems (validation never stops at the first). */
  static fromIssues(code: ManifestCode, issues: readonly RuneIssue[]): ManifestError {
    return aggregate(issues, (message, options) => new ManifestError(code, message, options));
  }
}

/** An input value is missing or invalid (exit 4). */
export class InputError extends RuneError {
  constructor(code: InputCode, message: string, options?: RuneErrorOptions) {
    super(code, message, options);
  }

  /** One error for every problem a batch of values had; resolution collects, never stops. */
  static fromIssues(code: InputCode, issues: readonly RuneIssue[]): InputError {
    return aggregate(issues, (message, options) => new InputError(code, message, options));
  }
}

/**
 * Turns collected problems into one error. The first problem's position becomes the error's
 * position, so a caller that reads only `location` still points somewhere useful.
 */
function aggregate<T extends RuneError>(
  issues: readonly RuneIssue[],
  make: (message: string, options: RuneErrorOptions) => T,
): T {
  const first = issues[0];
  if (first === undefined) {
    throw new InternalError('an error was built from an empty list of problems');
  }
  return make(formatIssues(issues), {
    issues,
    ...(first.location ? { location: first.location } : {}),
  });
}

/** A `${...}` reference could not be resolved (exit 5). */
export class ResolutionError extends RuneError {
  constructor(code: ResolutionCode, message: string, options?: RuneErrorOptions) {
    super(code, message, options);
  }
}

/** A `when:` condition is malformed or ill-typed (exit 5). */
export class ConditionError extends RuneError {
  constructor(code: ConditionCode, message: string, options?: RuneErrorOptions) {
    super(code, message, options);
  }
}

/** A step failed, timed out, or could not be started (exit 1). */
export class ExecutionError extends RuneError {
  constructor(code: ExecutionCode, message: string, options?: RuneErrorOptions) {
    super(code, message, options);
  }
}

/** The run was cancelled by the user or the system (exit 6). */
export class CancelledError extends RuneError {
  constructor(message = 'the run was cancelled', options?: RuneErrorOptions) {
    super('RUNE-601', message, options);
  }
}

/** A bug in RUNE (exit 70). */
export class InternalError extends RuneError {
  constructor(message: string, options?: RuneErrorOptions) {
    super(
      'RUNE-500',
      `${message} — this is a bug in RUNE, please report it with the manifest that triggered it`,
      options,
    );
  }
}

/** Exit codes are fixed and identical on every platform (docs/architecture.md §10). */
const EXIT_CODES: Readonly<Record<RuneCode, number>> = {
  'RUNE-001': 2,
  'RUNE-101': 3,
  'RUNE-102': 3,
  'RUNE-103': 3,
  'RUNE-104': 3,
  'RUNE-201': 4,
  'RUNE-202': 4,
  'RUNE-203': 4,
  'RUNE-301': 5,
  'RUNE-302': 5,
  'RUNE-311': 5,
  'RUNE-312': 5,
  'RUNE-401': 1,
  'RUNE-402': 1,
  'RUNE-403': 1,
  'RUNE-404': 1,
  'RUNE-405': 1,
  'RUNE-500': 70,
  'RUNE-601': 6,
};

/** Internal error: anything that is not a `RuneError` escaped, which is always a bug. */
export const INTERNAL_EXIT_CODE = 70;

/**
 * Maps an error to the process exit code. This is the only place that decides exit codes;
 * the CLI and the GUI shell both call it, so `--gui` cannot drift from a headless run.
 */
export function exitCodeFor(error: unknown): number {
  return error instanceof RuneError ? EXIT_CODES[error.code] : INTERNAL_EXIT_CODE;
}
