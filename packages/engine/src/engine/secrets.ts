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

export function isSecretString(value: unknown): value is SecretString {
  return value instanceof SecretString;
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
    let registered = false;

    for (const part of parts) {
      // Length alone is not enough: four spaces would pass, and masking them would black out
      // the indentation of every line a child process prints.
      if (part.trim().length >= MIN_MASKABLE_LENGTH) {
        this.#values.add(part);
        registered = true;
      }
    }

    if (registered) {
      this.#ordered = [...this.#values].sort((a, b) => b.length - a.length);
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

  /** Replaces every registered secret in `text` with the mask. */
  mask(text: string): string {
    const matches: Array<{ start: number; end: number }> = [];

    for (const secret of this.#ordered) {
      let searchFrom = 0;
      while (searchFrom <= text.length - secret.length) {
        const start = text.indexOf(secret, searchFrom);
        if (start === -1) {
          break;
        }

        matches.push({ start, end: start + secret.length });
        // Advancing one code unit finds overlapping occurrences of the same secret too.
        searchFrom = start + 1;
      }
    }

    if (matches.length === 0) {
      return text;
    }

    matches.sort((left, right) => left.start - right.start || left.end - right.end);

    let out = '';
    let cursor = 0;
    let matchStart = matches[0]!.start;
    let matchEnd = matches[0]!.end;

    for (let index = 1; index < matches.length; index += 1) {
      const match = matches[index]!;
      if (match.start < matchEnd) {
        matchEnd = Math.max(matchEnd, match.end);
        continue;
      }

      out += text.slice(cursor, matchStart) + MASK;
      cursor = matchEnd;
      matchStart = match.start;
      matchEnd = match.end;
    }

    return out + text.slice(cursor, matchStart) + MASK + text.slice(matchEnd);
  }
}
