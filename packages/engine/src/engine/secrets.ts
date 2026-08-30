/**
 * Secret handling (docs/architecture.md §10, invariant 6).
 *
 * Two mechanisms that do different jobs. The wrapper keeps a secret from being printed by
 * accident inside the process: it renders as `***` through every path that stringifies a
 * value, and the real text comes out only where it must — at spawn, inside the runner. The
 * registry catches what the wrapper cannot: a script that echoes the password it was given.
 */

/** What a secret looks like everywhere except at the one place that needs it. */
export const MASK = '***';

// Ordinary replacement collisions settle in a handful of passes. Keeping a small fixed
// budget leaves ample room for those chains while bounding pathological full-text rescans.
const MAX_MASKING_PASSES = 16;

/**
 * Below this length a secret is not registered for masking: masking "1" would black out
 * every digit in every log line, which hides far more than it protects (§10).
 */
export const MIN_MASKABLE_LENGTH = 4;

/** Authentic wrapper contents, owned only by this module and never exposed through lookup. */
const SECRET_VALUES = new WeakMap<object, unknown>();

/** Returns whether `value` contains enough Unicode code points to mask safely. */
function hasMinimumMaskableLength(value: string): boolean {
  let length = 0;
  for (const _codePoint of value) {
    length += 1;
    if (length >= MIN_MASKABLE_LENGTH) {
      return true;
    }
  }
  return false;
}

/**
 * A string that does not show itself. `toString`, template interpolation, `JSON.stringify`
 * and `util.inspect` all render the mask, so a secret cannot reach a log through an ordinary
 * mistake — only through `reveal()`, which is easy to find and to review.
 */
export class SecretString {
  constructor(value: string) {
    SECRET_VALUES.set(this, value);
  }

  /** The secret itself. Called at spawn, inside the runner, and nowhere else. */
  reveal(): string {
    const value = privateSecretValue(this);
    if (value === undefined) {
      throw new TypeError('SecretString has no authentic string value');
    }
    return value;
  }

  get length(): number {
    const value = privateSecretValue(this);
    if (value === undefined) {
      throw new TypeError('SecretString has no authentic string value');
    }
    return value.length;
  }

  toString(): string {
    return MASK;
  }

  toJSON(): typeof MASK {
    return MASK;
  }

  [Symbol.for('nodejs.util.inspect.custom')](): string {
    return MASK;
  }
}

/** Reads a genuine wrapper's private string without dynamic method dispatch. */
function privateSecretValue(value: unknown): string | undefined {
  if ((typeof value !== 'object' || value === null) && typeof value !== 'function') {
    return undefined;
  }
  const text = SECRET_VALUES.get(value);
  return typeof text === 'string' ? text : undefined;
}

/**
 * Copies a genuine secret into a fresh base wrapper.
 *
 * `SecretString` is public and may be subclassed or modified by an in-process client. The
 * module-private store makes the constructed wrapper identity the authority, while the fresh
 * wrapper prevents later calls from observing overrides or own properties on the input. A
 * proxy, forged prototype, or non-string value stored through plain JavaScript is rejected.
 */
export function normalizeSecretString(value: unknown): SecretString | undefined {
  const text = privateSecretValue(value);
  return text === undefined ? undefined : new SecretString(text);
}

export function isSecretString(value: unknown): value is SecretString {
  return privateSecretValue(value) !== undefined;
}

/**
 * Compares values when at least one is an authentic secret, without returning either text.
 * Undefined means neither operand is an authentic wrapper and ordinary evaluation applies.
 */
export function secretValuesEqual(left: unknown, right: unknown): boolean | undefined {
  const leftSecret = privateSecretValue(left);
  const rightSecret = privateSecretValue(right);
  if (leftSecret === undefined && rightSecret === undefined) {
    return undefined;
  }
  if (leftSecret === undefined) {
    return typeof left === 'string' && left === rightSecret;
  }
  if (rightSecret === undefined) {
    return typeof right === 'string' && leftSecret === right;
  }
  return leftSecret === rightSecret;
}

/** Tests an authentic secret needle against a plain string list without exposing the needle. */
export function secretValueIn(needle: unknown, haystack: readonly string[]): boolean | undefined {
  const secret = privateSecretValue(needle);
  return secret === undefined ? undefined : haystack.includes(secret);
}

interface SecretMatchStream {
  readonly secret: string;
  start: number;
  end: number;
  searchFrom: number;
  pendingStart: number | undefined;
}

function compareMatches(left: SecretMatchStream, right: SecretMatchStream): number {
  return left.start - right.start || left.end - right.end;
}

function pushMatch(heap: SecretMatchStream[], match: SecretMatchStream): void {
  heap.push(match);
  let index = heap.length - 1;

  while (index > 0) {
    const parent = Math.floor((index - 1) / 2);
    if (compareMatches(heap[parent]!, match) <= 0) {
      break;
    }
    heap[index] = heap[parent]!;
    index = parent;
  }

  heap[index] = match;
}

function popMatch(heap: SecretMatchStream[]): SecretMatchStream {
  const first = heap[0]!;
  const last = heap.pop()!;
  if (heap.length === 0) {
    return first;
  }

  let index = 0;
  while (true) {
    const left = index * 2 + 1;
    if (left >= heap.length) {
      break;
    }

    const right = left + 1;
    const child =
      right < heap.length && compareMatches(heap[right]!, heap[left]!) < 0 ? right : left;
    if (compareMatches(last, heap[child]!) <= 0) {
      break;
    }

    heap[index] = heap[child]!;
    index = child;
  }

  heap[index] = last;
  return first;
}

/** Advances one secret's stream to its next self-overlap-compressed match. */
function advanceMatch(text: string, match: SecretMatchStream): boolean {
  const start = match.pendingStart ?? text.indexOf(match.secret, match.searchFrom);
  if (start === -1) {
    return false;
  }

  match.pendingStart = undefined;
  let end = start + match.secret.length;
  let searchFrom = start + 1;

  while (true) {
    const next = text.indexOf(match.secret, searchFrom);
    if (next === -1) {
      match.searchFrom = text.length + 1;
      break;
    }
    if (next >= end) {
      match.pendingStart = next;
      match.searchFrom = next + 1;
      break;
    }

    end = Math.max(end, next + match.secret.length);
    searchFrom = next + 1;
  }

  match.start = start;
  match.end = end;
  return true;
}

/** Replaces every range containing a secret found in this version of `text`. */
function maskOnce(text: string, orderedSecrets: readonly string[]): string {
  // The heap owns one reusable stream per registered secret, rather than one object per
  // occurrence. Its size is therefore independent of how often secrets appear in the text.
  const matchHeap: SecretMatchStream[] = [];
  for (const secret of orderedSecrets) {
    const match: SecretMatchStream = {
      secret,
      start: 0,
      end: 0,
      searchFrom: 0,
      pendingStart: undefined,
    };
    if (advanceMatch(text, match)) {
      pushMatch(matchHeap, match);
    }
  }

  if (matchHeap.length === 0) {
    return text;
  }

  let out = '';
  let cursor = 0;
  const first = popMatch(matchHeap);
  let matchStart = first.start;
  let matchEnd = first.end;
  if (advanceMatch(text, first)) {
    pushMatch(matchHeap, first);
  }

  while (matchHeap.length > 0) {
    const match = popMatch(matchHeap);
    const start = match.start;
    const end = match.end;
    if (advanceMatch(text, match)) {
      pushMatch(matchHeap, match);
    }

    if (start < matchEnd) {
      matchEnd = Math.max(matchEnd, end);
    } else {
      out += text.slice(cursor, matchStart) + MASK;
      cursor = matchEnd;
      matchStart = start;
      matchEnd = end;
    }
  }

  return out + text.slice(cursor, matchStart) + MASK + text.slice(matchEnd);
}

/**
 * The secrets a run knows about, and the one function that removes them from text.
 *
 * Every secret is registered at resolution — before any step can launch — so that output a
 * child process produces can be masked as it is read, not after it has been written.
 */
export class SecretRegistry {
  readonly #values = new Set<string>();
  /** Registered secrets in deterministic longest-first order. */
  #ordered: readonly string[] = [];
  #orderedDirty = false;

  /**
   * Registers every maskable part of a secret. Returns false when any content line is too
   * short to mask safely, which the caller reports — silently not masking something would
   * be the worse half of the choice.
   */
  register(value: string): boolean {
    // Every sink RUNE masks is line-oriented — a child's output is read line by line, and so
    // is the log — so a secret spanning several lines would never match anything a sink sees.
    // Each line is registered as well, which is what actually protects a key or certificate.
    const lines = value.split(/\r\n|\r|\n/);
    const parts = lines.length > 1 ? [value, ...lines] : lines;

    for (const part of parts) {
      // Length alone is not enough: four spaces would pass, and masking them would black out
      // the indentation of every line a child process prints.
      if (hasMinimumMaskableLength(part.trim())) {
        const size = this.#values.size;
        this.#values.add(part);
        if (this.#values.size !== size) {
          this.#orderedDirty = true;
        }
      }
    }

    const contentLines = lines.filter((line) => line.trim() !== '');
    return (
      contentLines.length > 0 && contentLines.every((line) => hasMinimumMaskableLength(line.trim()))
    );
  }

  /**
   * Registers a plain string or authentic wrapper without exposing its text to the caller.
   * Returns undefined for every other value, including proxies and forged prototypes.
   */
  registerCandidate(value: unknown): boolean | undefined {
    const text = typeof value === 'string' ? value : privateSecretValue(value);
    return text === undefined ? undefined : this.register(text);
  }

  get size(): number {
    return this.#values.size;
  }

  /** Returns an independent registry containing the secrets known by both registries. */
  combinedWith(source: SecretRegistry): SecretRegistry {
    const combined = new SecretRegistry();
    for (const value of this.#values) {
      combined.#values.add(value);
    }
    for (const value of source.#values) {
      combined.#values.add(value);
    }
    combined.#orderedDirty = combined.#values.size > 0;
    return combined;
  }

  /** Replaces this registry with the completed secret set of one successful resolution. */
  replaceWith(source: SecretRegistry): void {
    const values = new Set(source.#values);
    const ordered = [...source.#ordered];
    const orderedDirty = source.#orderedDirty;

    this.#values.clear();
    for (const value of values) {
      this.#values.add(value);
    }
    this.#ordered = ordered;
    this.#orderedDirty = orderedDirty;
  }

  /** Replaces every registered secret in `text` with the mask. */
  mask(text: string): string {
    if (this.#orderedDirty) {
      this.#ordered = [...this.#values].sort((a, b) => b.length - a.length);
      this.#orderedDirty = false;
    }

    let masked = text;
    for (let pass = 0; pass < MAX_MASKING_PASSES; pass += 1) {
      const next = maskOnce(masked, this.#ordered);
      if (next === masked) {
        return masked;
      }

      masked = next;
    }

    // Returning an intermediate value could expose part of a collision chain. MASK itself
    // is shorter than every registrable secret, so masking the whole input is safely stable;
    // the extra masking is limited to this pathological budget-exhaustion path.
    return MASK;
  }
}
