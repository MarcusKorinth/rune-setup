/**
 * The RUNE error taxonomy (docs/architecture.md §7) and the single owner of the
 * error → exit-code map (§10). Every failure RUNE reports carries a stable `RUNE-xxx`
 * code, a message, and — where it comes from a file — a source location.
 */

import { formatLocation, type Location } from './manifest/source.js';
import {
  escapeDiagnosticText,
  finalizeRenderedDiagnosticRecords,
  formatDiagnostic,
  formatDiagnosticRecordList,
  formatDiagnosticRecords,
  projectDiagnosticRecordList,
  type DiagnosticMasker,
  type DiagnosticPart,
} from './diagnostics.js';

const INTERNAL_ERROR_SUFFIX =
  ' — this is a bug in RUNE, please report it with the manifest that triggered it';
const PROJECTED_INTERNAL_ERROR: unique symbol = Symbol('RUNE.projectedInternalError');

export type { Location };

/**
 * Stable error codes. They are machine contract: they appear in messages, in the result
 * file and (later) across the GUI bridge, so a code never changes meaning.
 */
export type RuneCode =
  | 'RUNE-001' // CLI misuse
  | 'RUNE-002' // unsupported host platform
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
  | 'RUNE-401' // step exit code or unclassified execution failure
  | 'RUNE-402' // step timeout
  | 'RUNE-403' // command not found
  | 'RUNE-404' // invalid working directory
  | 'RUNE-405' // shell-required command refused
  | 'RUNE-406' // operational log-file I/O
  | 'RUNE-407' // operational result-file I/O
  | 'RUNE-500' // internal error
  | 'RUNE-601'; // cancelled

/** One reported problem. Errors that collect many problems expose them as issues. */
export interface RuneIssue {
  readonly code: RuneCode;
  readonly message: string;
  readonly location: Location | undefined;
}

/** Values-file order is internal diagnostic metadata, not part of the public issue shape. */
const valuesDocumentOrdinals = new WeakMap<RuneIssue, number>();
interface RawIssuePresentation {
  readonly parts: readonly DiagnosticPart[];
  readonly location: Location | undefined;
}
/** Authentic record fields retained when public projected fields must fail closed. */
const rawIssuePresentations = new WeakMap<RuneIssue, RawIssuePresentation>();

/** Retains a values document's invocation order while its issue is being collected. */
export function withValuesDocumentOrdinal(issue: RuneIssue, ordinal: number): RuneIssue {
  valuesDocumentOrdinals.set(issue, ordinal);
  return issue;
}

/** Retains raw quoted/plain message parts until the issue reaches its complete sink record. */
export function withIssueDiagnosticParts(
  issue: RuneIssue,
  parts: readonly DiagnosticPart[],
): RuneIssue {
  rawIssuePresentations.set(issue, { parts, location: issue.location });
  return issue;
}

export interface RuneErrorOptions {
  readonly location?: Location;
  /** All collected problems; defaults to the single problem this error describes. */
  readonly issues?: readonly RuneIssue[];
  readonly cause?: unknown;
}

/** Renders issues one per line, each prefixed with `file:line:col` when it has a location. */
export function formatIssues(issues: readonly RuneIssue[]): string {
  return formatDiagnosticRecords(issues.map(publicIssueRecord));
}

/** Formats a RuneError without discarding a sink-safe projection of its full composition. */
export function formatRuneError(error: RuneError): string {
  return formatIssues(error.issues);
}

/**
 * Puts a batch of problems into the order an author reads them — values-file invocation order
 * first, then position in a document, each distinct problem once. Every layer that collects
 * problems orders them through here, so a shape batch and a semantics batch make the same
 * promise instead of two different ones.
 */
export function orderIssues(issues: readonly RuneIssue[]): RuneIssue[] {
  const seen = new Set<string>();
  const unique: RuneIssue[] = [];
  for (const issue of issues) {
    const raw = issuePresentation(issue);
    const where = raw.location;
    // The file belongs in the identity: once values files and locale overlays share this
    // path, the same sentence about the same line of two documents is two problems.
    const id = `${where?.file ?? ''}:${where?.line ?? 0}:${where?.column ?? 0}:${partsIdentity(raw.parts)}`;
    if (!seen.has(id)) {
      seen.add(id);
      unique.push(issue);
    }
  }
  return unique.sort((a, b) => {
    const aValuesDocumentOrdinal = valuesDocumentOrdinals.get(a);
    const bValuesDocumentOrdinal = valuesDocumentOrdinals.get(b);
    return (
      (aValuesDocumentOrdinal !== undefined && bValuesDocumentOrdinal !== undefined
        ? aValuesDocumentOrdinal - bValuesDocumentOrdinal
        : 0) ||
      (issuePresentation(a).location?.line ?? 0) - (issuePresentation(b).location?.line ?? 0) ||
      (issuePresentation(a).location?.column ?? 0) - (issuePresentation(b).location?.column ?? 0) ||
      // Code-unit order, not locale order: the golden files must read the same on every
      // machine, whatever locale it runs in and whether its Node carries the full ICU data.
      compareCodeUnits(
        formatDiagnostic(issuePresentation(a).parts),
        formatDiagnostic(issuePresentation(b).parts),
      )
    );
  });
}

function partsIdentity(parts: readonly DiagnosticPart[]): string {
  return JSON.stringify(parts);
}

function compareCodeUnits(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** The message of something that was thrown, whatever it was. */
export function messageOf(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

/** Fixed phrases for the errno codes an operational sink can meet; the code itself is appended. */
const FILESYSTEM_FAILURE_PHRASES: Readonly<Record<string, string>> = {
  EACCES: 'permission denied',
  EPERM: 'the operation is not permitted',
  EISDIR: 'the path is a directory',
  ENOTDIR: 'a path component is not a directory',
  ENOENT: 'the path does not exist',
  EEXIST: 'a path component already exists and is not a directory',
  ENOTEMPTY: 'the path is a non-empty directory',
  EBUSY: 'the path is in use',
  EROFS: 'the file system is read-only',
  ENOSPC: 'no space is left on the device',
  EMFILE: 'too many files are open',
  ENFILE: 'too many files are open',
  ENAMETOOLONG: 'the path is too long',
  EINVAL: 'the path is invalid',
};

/**
 * A fixed, value-free reason for a failed filesystem operation, derived only from the errno
 * code of what was thrown. Operational sink errors name the destination plus this reason
 * instead of the raw OS message, which embeds path fragments RUNE did not compose.
 */
export function filesystemFailureReason(cause: unknown): string {
  const code = errnoCodeOf(cause);
  if (code === undefined) {
    return 'the operation failed';
  }
  return `${FILESYSTEM_FAILURE_PHRASES[code] ?? 'the operation failed'} (${code})`;
}

/** The errno code of a thrown Node system error; anything not shaped like one is ignored. */
export function errnoCodeOf(cause: unknown): string | undefined {
  if (!(cause instanceof Error) || !('code' in cause) || typeof cause.code !== 'string') {
    return undefined;
  }
  return /^E[A-Z0-9]+$/u.test(cause.code) ? cause.code : undefined;
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
export type ExecutionCode =
  'RUNE-401' | 'RUNE-402' | 'RUNE-403' | 'RUNE-404' | 'RUNE-405' | 'RUNE-406' | 'RUNE-407';

/** The command line was used wrongly (exit 2). */
export class UsageError extends RuneError {
  constructor(message: string, options?: RuneErrorOptions) {
    super('RUNE-001', message, options);
  }
}

/** RUNE cannot run on this host platform (exit 2). */
export class PlatformError extends RuneError {
  constructor(message: string, options?: RuneErrorOptions) {
    super('RUNE-002', message, options);
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
    return aggregate(
      orderIssues(issues),
      (message, options) => new InputError(code, message, options),
    );
  }
}

/**
 * Turns collected problems into one error. The first located problem's position becomes the
 * error's position, so a caller that reads only `location` still points somewhere useful.
 */
function aggregate<T extends RuneError>(
  issues: readonly RuneIssue[],
  make: (message: string, options: RuneErrorOptions) => T,
): T {
  const first = issues[0];
  if (first === undefined) {
    throw new InternalError('an error was built from an empty list of problems');
  }
  const firstLocated = issues.find((issue) => issue.location !== undefined);
  return make(formatIssues(issues), {
    issues,
    ...(firstLocated?.location ? { location: firstLocated.location } : {}),
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

/** Execution failed at a step, policy boundary, or operational run sink (exit 1). */
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
  constructor(message: string, options?: RuneErrorOptions);
  constructor(
    message: string,
    options: RuneErrorOptions | undefined,
    projection: typeof PROJECTED_INTERNAL_ERROR,
  );
  constructor(
    message: string,
    options?: RuneErrorOptions,
    projection?: typeof PROJECTED_INTERNAL_ERROR,
  ) {
    super(
      'RUNE-500',
      projection === PROJECTED_INTERNAL_ERROR ? message : `${message}${INTERNAL_ERROR_SUFFIX}`,
      options,
    );
  }
}

/**
 * Rebuilds a RuneError for a sink boundary while retaining its taxonomy, issue locations,
 * and a sanitized cause chain. The returned error never retains the original error object:
 * its message or stack could contain the very bytes this projection removes.
 */
export function projectRuneError(error: RuneError, masker: DiagnosticMasker): RuneError {
  const issues = projectIssuesForSink(error.issues, masker);
  const aggregateMessage = error.message === formatIssues(error.issues);
  const defaultIssueMessage =
    error.issues.length === 1 && error.issues[0]?.message === error.message;
  const message = aggregateMessage
    ? formatIssues(issues)
    : defaultIssueMessage
      ? issues[0]!.message
      : formatDiagnostic([error.message], masker);
  const location = projectRuneErrorLocationForSink(error, issues, message, masker);
  const options: RuneErrorOptions = {
    issues,
    ...(location === undefined ? {} : { location }),
    ...(error.cause === undefined ? {} : { cause: projectCause(error.cause, masker) }),
  };
  let projected: RuneError;

  if (error instanceof UsageError) {
    projected = new UsageError(message, options);
  } else if (error instanceof PlatformError) {
    projected = new PlatformError(message, options);
  } else if (error instanceof ManifestError) {
    projected = new ManifestError(error.code as ManifestCode, message, options);
  } else if (error instanceof InputError) {
    projected = new InputError(error.code as InputCode, message, options);
  } else if (error instanceof ResolutionError) {
    projected = new ResolutionError(error.code as ResolutionCode, message, options);
  } else if (error instanceof ConditionError) {
    projected = new ConditionError(error.code as ConditionCode, message, options);
  } else if (error instanceof ExecutionError) {
    projected = new ExecutionError(error.code as ExecutionCode, message, options);
  } else if (error instanceof CancelledError) {
    projected = new CancelledError(message, options);
  } else if (error instanceof InternalError) {
    projected = new InternalError(message, options, PROJECTED_INTERNAL_ERROR);
  } else {
    projected = new RuneError(error.code, message, options);
  }
  const header = projectRuneErrorHeaderForSink(error, projected.message, masker);
  projected.name = header.name;
  if (error.stack !== undefined) {
    projected.stack = projectErrorStackForSink(
      error.stack,
      error.name,
      error.message,
      header.text,
      masker,
    );
  }
  return projected;
}

export function projectRuneErrorLocationForSink(
  error: RuneError,
  projectedIssues: readonly RuneIssue[],
  publicMessage: string,
  masker: DiagnosticMasker,
): Location | undefined {
  const location = error.location;
  const issueIndex =
    location === undefined
      ? -1
      : error.issues.findIndex((issue) => locationsEqual(issue.location, location));
  if (issueIndex < 0 && location !== undefined) {
    const projected = projectLocation(location, masker)!;
    return locatedErrorIsCanonical(location, projected, error, publicMessage, masker)
      ? projected
      : undefined;
  }
  const projectedIndex =
    issueIndex >= 0 && projectedIssues[issueIndex]?.location !== undefined
      ? issueIndex
      : projectedIssues.findIndex((issue) => issue.location !== undefined);
  const projected = projectedIssues[projectedIndex]?.location;
  const raw = error.issues[projectedIndex]?.location;
  return projected !== undefined && raw !== undefined
    ? locatedErrorIsCanonical(raw, projected, error, publicMessage, masker)
      ? projected
      : undefined
    : undefined;
}

function locatedErrorIsCanonical(
  rawLocation: Location,
  projectedLocation: Location,
  error: RuneError,
  publicMessage: string,
  masker: DiagnosticMasker,
): boolean {
  const records = errorMessageRecords(error);
  const canonical = formatDiagnosticRecords(
    [[formatLocation(rawLocation), ': ', ...(records[0] ?? [])], ...records.slice(1)],
    masker,
  );
  return (
    `${escapeDiagnosticText(formatLocation(projectedLocation))}: ${publicMessage}` === canonical
  );
}

function locationsEqual(left: Location | undefined, right: Location): boolean {
  return (
    left !== undefined &&
    left.file === right.file &&
    left.line === right.line &&
    left.column === right.column
  );
}

function projectLocation(
  location: Location | undefined,
  masker: DiagnosticMasker,
): Location | undefined {
  return location === undefined
    ? undefined
    : {
        file: masker.mask(location.file),
        line: location.line,
        column: location.column,
      };
}

function projectCause(cause: unknown, masker: DiagnosticMasker): unknown {
  if (cause instanceof RuneError) {
    return projectRuneError(cause, masker);
  }
  if (cause instanceof Error) {
    const safeMessage = formatDiagnostic([cause.message], masker);
    const header = projectPublicHeader(cause.name, cause.message, safeMessage, masker);
    const projected = new Error(
      header.message,
      cause.cause === undefined ? undefined : { cause: projectCause(cause.cause, masker) },
    );
    projected.name = header.name;
    if (cause.stack !== undefined) {
      projected.stack = projectErrorStackForSink(
        cause.stack,
        cause.name,
        cause.message,
        header.text,
        masker,
      );
    }
    return projected;
  }
  if (cause === null || typeof cause === 'boolean' || typeof cause === 'number') {
    return cause;
  }
  return formatDiagnostic([String(cause)], masker);
}

interface PublicErrorHeader {
  readonly name: string;
  readonly message: string;
  readonly text: string;
}

/** Keeps the public message when possible and drops the name if their composition is unsafe. */
export function projectPublicHeader(
  rawName: string,
  rawMessage: string,
  publicMessage: string,
  masker: DiagnosticMasker,
  canonical = formatDiagnostic(errorHeaderParts(rawName, rawMessage, [rawMessage]), masker),
): PublicErrorHeader {
  const name = formatDiagnostic([rawName], masker);
  const reconstructed = errorHeader(name, publicMessage);
  return reconstructed === canonical
    ? { name, message: publicMessage, text: reconstructed }
    : { name: '', message: publicMessage, text: publicMessage };
}

/** Projects the public header while retaining authentic issue parts until the complete sink. */
export function projectRuneErrorHeaderForSink(
  error: RuneError,
  publicMessage: string,
  masker: DiagnosticMasker,
): PublicErrorHeader {
  const records = errorMessageRecords(error);
  const canonical = formatDiagnosticRecords(
    errorHeaderRecords(error.name, error.message, records),
    masker,
  );
  return projectPublicHeader(error.name, error.message, publicMessage, masker, canonical);
}

function errorMessageRecords(error: RuneError): readonly (readonly DiagnosticPart[])[] {
  if (error.message === formatIssues(error.issues)) return issueRecords(error.issues);
  return [
    error.issues.length === 1 && error.issues[0]?.message === error.message
      ? issuePresentation(error.issues[0]).parts
      : [error.message],
  ];
}

function errorHeader(name: string, message: string): string {
  return name.length === 0 ? message : message.length === 0 ? name : `${name}: ${message}`;
}

function errorHeaderParts(
  name: string,
  message: string,
  messageParts: readonly DiagnosticPart[],
): readonly DiagnosticPart[] {
  return name.length === 0
    ? messageParts
    : message.length === 0
      ? [name]
      : [name, ': ', ...messageParts];
}

function errorHeaderRecords(
  name: string,
  message: string,
  records: readonly (readonly DiagnosticPart[])[],
): readonly (readonly DiagnosticPart[])[] {
  if (message.length === 0) return [[name]];
  if (name.length === 0) return records;
  return [[name, ': ', ...(records[0] ?? [])], ...records.slice(1)];
}

/** Masks an authentic stack header and escapes data while retaining formatter-owned frame LFs. */
export function projectErrorStackForSink(
  rawStack: string,
  rawName: string,
  rawMessage: string,
  safeHeader: string,
  masker: DiagnosticMasker,
): string {
  const rawHeader = errorHeader(rawName, rawMessage);
  if (!rawStack.startsWith(rawHeader)) {
    return formatDiagnosticRecords(
      rawStack.split('\n').map((record) => [record]),
      masker,
    );
  }
  const suffix = projectDiagnosticRecordList(
    rawStack
      .slice(rawHeader.length)
      .split('\n')
      .map((record) => [record]),
    masker,
  );
  const combined = [safeHeader + (suffix.records[0] ?? ''), ...suffix.records.slice(1)];
  const finalized = finalizeRenderedDiagnosticRecords(combined, masker);
  if (!suffix.failClosed && !finalized.failClosed) return combined.join('\n');

  const emptySuffix = [safeHeader, ...suffix.records.slice(1).map(() => '')];
  const emptyProjection = finalizeRenderedDiagnosticRecords(emptySuffix, masker);
  // If even header plus empty frame records collides, retain the already validated error
  // header and drop only optional stack-frame separators.
  return emptyProjection.failClosed ? safeHeader : emptyProjection.records.join('\n');
}

function issueRecords(issues: readonly RuneIssue[]): readonly (readonly DiagnosticPart[])[] {
  return issues.map(issueRecord);
}

function issueRecord(issue: RuneIssue): readonly DiagnosticPart[] {
  const raw = issuePresentation(issue);
  return raw.location === undefined
    ? raw.parts
    : [formatLocation(raw.location), ': ', ...raw.parts];
}

function issuePresentation(issue: RuneIssue): RawIssuePresentation {
  return (
    rawIssuePresentations.get(issue) ?? {
      parts: [issue.message],
      location: issue.location,
    }
  );
}

function publicIssueRecord(issue: RuneIssue): readonly DiagnosticPart[] {
  return issue.location === undefined
    ? [issue.message]
    : [formatLocation(issue.location), ': ', issue.message];
}

/** Projects issue fields and binds their canonical record-level sink presentation. */
export function projectIssuesForSink(
  issues: readonly RuneIssue[],
  masker: DiagnosticMasker,
): readonly RuneIssue[] {
  const diagnostics = formatDiagnosticRecordList(issueRecords(issues), masker);
  return issues.map((issue, index): RuneIssue => {
    const raw = issuePresentation(issue);
    let projected: RuneIssue = {
      code: issue.code,
      message: formatDiagnosticRecords([raw.parts], masker),
      location: projectLocation(raw.location, masker),
    };
    if (formatIssues([projected]) !== diagnostics[index]) {
      projected = {
        code: issue.code,
        message: diagnostics[index]!,
        location: undefined,
      };
    }
    const ordinal = valuesDocumentOrdinals.get(issue);
    if (ordinal !== undefined) valuesDocumentOrdinals.set(projected, ordinal);
    rawIssuePresentations.set(projected, raw);
    return projected;
  });
}

/** Exit codes are fixed and identical on every platform (docs/architecture.md §10). */
export const EXIT_CODE_BY_RUNE_CODE = {
  'RUNE-001': 2,
  'RUNE-002': 2,
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
  'RUNE-406': 1,
  'RUNE-407': 1,
  'RUNE-500': 70,
  'RUNE-601': 6,
} as const satisfies Readonly<Record<RuneCode, number>>;

/** Internal error: anything that is not a `RuneError` escaped, which is always a bug. */
export const INTERNAL_EXIT_CODE = EXIT_CODE_BY_RUNE_CODE['RUNE-500'];

/**
 * Maps an error to the process exit code. This is the only place that decides exit codes;
 * the CLI and the GUI shell both call it, so `--gui` cannot drift from a headless run.
 */
export function exitCodeFor(error: unknown): number {
  return error instanceof RuneError ? EXIT_CODE_BY_RUNE_CODE[error.code] : INTERNAL_EXIT_CODE;
}
