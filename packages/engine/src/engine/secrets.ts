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
  /** Longest first: masking the longer secret first keeps a shorter one inside it from
   * splitting the replacement into pieces that no longer match. */
  #ordered: readonly string[] = [];

  /**
   * Registers a secret. Returns false when the value is too short to mask safely, which the
   * caller reports — silently not masking something would be the worse half of the choice.
   */
  register(value: string): boolean {
    if (value.length < MIN_MASKABLE_LENGTH) {
      return false;
    }
    this.#values.add(value);
    this.#ordered = [...this.#values].sort((a, b) => b.length - a.length);
    return true;
  }

  get size(): number {
    return this.#values.size;
  }

  /** Replaces every registered secret in `text` with the mask. */
  mask(text: string): string {
    let out = text;
    for (const secret of this.#ordered) {
      out = out.split(secret).join(MASK);
    }
    return out;
  }
}
