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

/**
 * Below this length a secret is not registered for masking: masking "1" would black out
 * every digit in every log line, which hides far more than it protects (§10).
 */
export const MIN_MASKABLE_LENGTH = 4;

/**
 * A string that does not show itself. `toString`, template interpolation, `JSON.stringify`
 * and `util.inspect` all render the mask, so a secret cannot reach a log through an ordinary
 * mistake — only through `reveal()`, which is easy to find and to review.
 */
export class SecretString {
  readonly #value: string;

  constructor(value: string) {
    this.#value = value;
  }

  /** The secret itself. Called at spawn, inside the runner, and nowhere else. */
  reveal(): string {
    return this.#value;
  }

  get length(): number {
    return this.#value.length;
  }

  toString(): string {
    return MASK;
  }

  toJSON(): null {
    return null;
  }

  [Symbol.for('nodejs.util.inspect.custom')](): string {
    return MASK;
  }
}

// Capture the base implementation before a programmatic client can replace or shadow it.
// Calling it directly performs the private-brand check without dispatching through the value.
const BASE_SECRET_REVEAL = SecretString.prototype.reveal;
const APPLY = Reflect.apply;

/** Reads a genuine wrapper's private string without dynamic method dispatch. */
function privateSecretValue(value: unknown): string | undefined {
  let text: unknown;
  try {
    text = APPLY(BASE_SECRET_REVEAL, value, []);
  } catch {
    return undefined;
  }
  return typeof text === 'string' ? text : undefined;
}

/**
 * Copies a genuine secret into a fresh base wrapper.
 *
 * `SecretString` is public and may be subclassed or modified by an in-process client. Reading
 * through the cached base implementation makes the private field the authority, while the
 * fresh wrapper prevents later calls from observing overrides or own properties on the input.
 * A proxy, forged prototype, or non-string value stored through plain JavaScript is rejected.
 */
export function normalizeSecretString(value: unknown): SecretString | undefined {
  const text = privateSecretValue(value);
  return text === undefined ? undefined : new SecretString(text);
}

export function isSecretString(value: unknown): value is SecretString {
  return privateSecretValue(value) !== undefined;
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
      if (part.trim().length >= MIN_MASKABLE_LENGTH) {
        const size = this.#values.size;
        this.#values.add(part);
        if (this.#values.size !== size) {
          this.#orderedDirty = true;
        }
      }
    }

    const contentLines = lines.filter((line) => line.trim() !== '');
    return (
      contentLines.length > 0 &&
      contentLines.every((line) => line.trim().length >= MIN_MASKABLE_LENGTH)
    );
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

    // The heap owns one reusable stream per registered secret, rather than one object per
    // occurrence. Its size is therefore independent of how often secrets appear in the text.
    const matchHeap: SecretMatchStream[] = [];
    for (const secret of this.#ordered) {
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
}
