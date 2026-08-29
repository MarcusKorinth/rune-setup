/**
 * Secret handling (docs/architecture.md §10, invariant 6).
 *
 * Two mechanisms that do different jobs. The wrapper keeps a secret from being printed by
 * accident inside the process: it renders as `***` through every path that stringifies a
 * value, and the real text comes out only where it must — at spawn, inside the runner. The
 * registry catches what the wrapper cannot: a script that echoes the password it was given.
 */

import { isAbsolute, resolve as resolvePath } from 'node:path';

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
  #resolve: () => string;

  constructor(value: string) {
    this.#resolve = () => value;
  }

  /**
   * Joins public text and opaque secret pieces without exposing the resulting text. The
   * pieces are snapshotted now and resolved only if the runner eventually reveals the value.
   */
  static compose(parts: readonly (string | SecretString)[]): SecretString {
    const snapshot = Object.freeze([...parts]);
    return SecretString.#lazy(() =>
      snapshot.map((part) => (part instanceof SecretString ? part.#resolve() : part)).join(''),
    );
  }

  /** Lazily anchors a path while keeping both relative and absolute values opaque. */
  resolvePathFrom(basePath: string): SecretString {
    const baseSnapshot = basePath;
    return SecretString.#lazy(() => {
      const value = this.#resolve();
      return isAbsolute(value) ? value : resolvePath(baseSnapshot, value);
    });
  }

  /** Tests an opaque value without returning its text to the caller. */
  matches(pattern: RegExp): boolean {
    return new RegExp(pattern.source, pattern.flags).test(this.#resolve());
  }

  /** Compares an opaque condition value without returning either secret as text. */
  equals(other: unknown): boolean {
    if (other instanceof SecretString) {
      return this.#resolve() === other.#resolve();
    }
    return typeof other === 'string' && this.#resolve() === other;
  }

  /** Tests membership when an opaque value is the left operand of `in`. */
  isIncludedIn(values: readonly string[]): boolean {
    return values.includes(this.#resolve());
  }

  /** Registers the secret for sink masking without handing its text back to resolution. */
  registerForMasking(registry: SecretRegistry): boolean {
    return registry.register(this.#resolve());
  }

  static #lazy(resolve: () => string): SecretString {
    const secret = new SecretString('');
    secret.#resolve = resolve;
    return secret;
  }

  /** The secret itself. Called at spawn, inside the runner, and nowhere else. */
  reveal(): string {
    return this.#resolve();
  }

  get length(): number {
    return this.#resolve().length;
  }

  toString(): string {
    return MASK;
  }

  toJSON(): string {
    return MASK;
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
    // Every sink RUNE masks is line-oriented — a child's output is read line by line, and so
    // is the log — so a secret spanning several lines would never match anything a sink sees.
    // Each line is registered as well, which is what actually protects a key or certificate.
    const parts = value.includes('\n') ? [value, ...value.split(/\r?\n/)] : [value];
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
    return registered;
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
