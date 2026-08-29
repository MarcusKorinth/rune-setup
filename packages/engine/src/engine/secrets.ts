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
 * A string that does not show itself. The public shape exposes only safe stringification;
 * every operation over the hidden text is a narrowly named package-internal helper.
 */
const SECRET_STRING = Symbol('SecretString');

export interface SecretString {
  readonly [SECRET_STRING]: true;
  toString(): string;
  toJSON(): string;
}

class OpaqueSecretString implements SecretString {
  readonly [SECRET_STRING] = true;

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

const secretResolvers = new WeakMap<SecretString, () => string>();

function secretFromResolver(resolve: () => string): SecretString {
  const secret = Object.freeze(new OpaqueSecretString());
  secretResolvers.set(secret, resolve);
  return secret;
}

function resolveSecret(secret: SecretString): string {
  const resolve = secretResolvers.get(secret);
  if (resolve === undefined) {
    throw new TypeError('the value is not an engine secret');
  }
  return resolve();
}

/** Creates an opaque secret at the resolution boundary. Not part of the package API. */
export function createSecretString(value: string): SecretString {
  return secretFromResolver(() => value);
}

/** Joins public and opaque pieces without exposing the result. */
export function composeSecretString(parts: readonly (string | SecretString)[]): SecretString {
  const snapshot = Object.freeze([...parts]);
  return secretFromResolver(() =>
    snapshot.map((part) => (isSecretString(part) ? resolveSecret(part) : part)).join(''),
  );
}

/** Lazily anchors a path while keeping the value opaque. */
export function resolveSecretPathFrom(secret: SecretString, basePath: string): SecretString {
  const baseSnapshot = basePath;
  return secretFromResolver(() => {
    const value = resolveSecret(secret);
    return isAbsolute(value) ? value : resolvePath(baseSnapshot, value);
  });
}

/** Tests an opaque value without returning its text. */
export function secretMatches(secret: SecretString, pattern: RegExp): boolean {
  return new RegExp(pattern.source, pattern.flags).test(resolveSecret(secret));
}

/** Compares an opaque condition value without returning either secret as text. */
export function secretEquals(secret: SecretString, other: unknown): boolean {
  if (isSecretString(other)) {
    return resolveSecret(secret) === resolveSecret(other);
  }
  return typeof other === 'string' && resolveSecret(secret) === other;
}

/** Tests membership when an opaque value is the left operand of `in`. */
export function secretIsIncludedIn(secret: SecretString, values: readonly string[]): boolean {
  return values.includes(resolveSecret(secret));
}

/** Returns only the length needed by required-input validation. */
export function secretLength(secret: SecretString): number {
  return resolveSecret(secret).length;
}

/** Registers a secret without handing its text back to resolution. */
export function registerSecretForMasking(secret: SecretString, registry: SecretRegistry): boolean {
  return registry.register(resolveSecret(secret));
}

/** Plaintext capability used only by the spawn runner at the child-process boundary. */
export function revealSecretString(secret: SecretString): string {
  return resolveSecret(secret);
}

export function isSecretString(value: unknown): value is SecretString {
  return typeof value === 'object' && value !== null && secretResolvers.has(value as SecretString);
}

/**
 * The secrets a run knows about, and the one function that removes them from text.
 *
 * Every secret is registered at resolution — before any step can launch — so that output a
 * child process produces can be masked as it is read, not after it has been written.
 */
export class SecretRegistry {
  readonly #values = new Set<string>();
  #patterns: readonly string[] = [];

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
      this.#patterns = [...this.#values];
    }
    return registered;
  }

  get size(): number {
    return this.#values.size;
  }

  /** Replaces every registered secret in `text` with the mask. */
  mask(text: string): string {
    // One slot per input position bounds temporary storage by the text length, even when
    // many self-overlapping patterns all match at nearly every position.
    const matchEnds = new Uint32Array(text.length);
    let hasMatches = false;

    // Match every pattern against the original text. Advancing one character at a time
    // deliberately retains self-overlapping occurrences such as "aaaa" in "aaaaa".
    for (const secret of this.#patterns) {
      let start = text.indexOf(secret);
      while (start !== -1) {
        const end = start + secret.length;
        if (end > (matchEnds[start] ?? 0)) {
          matchEnds[start] = end;
        }
        hasMatches = true;
        start = text.indexOf(secret, start + 1);
      }
    }

    if (!hasMatches) {
      return text;
    }

    const parts: string[] = [];
    let cursor = 0;
    let rangeStart = -1;
    let rangeEnd = 0;

    for (let start = 0; start < matchEnds.length; start += 1) {
      const end = matchEnds[start] ?? 0;
      if (end === 0) {
        continue;
      }

      if (rangeStart === -1) {
        rangeStart = start;
        rangeEnd = end;
      } else if (start < rangeEnd) {
        rangeEnd = Math.max(rangeEnd, end);
      } else {
        // Adjacent occurrences are intentionally separate masks.
        parts.push(text.slice(cursor, rangeStart), MASK);
        cursor = rangeEnd;
        rangeStart = start;
        rangeEnd = end;
      }
    }

    parts.push(text.slice(cursor, rangeStart), MASK);
    cursor = rangeEnd;
    parts.push(text.slice(cursor));
    return parts.join('');
  }
}
