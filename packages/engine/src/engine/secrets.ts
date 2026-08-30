/**
 * Secret handling (docs/architecture.md §10, invariant 6).
 *
 * Two mechanisms that do different jobs. The wrapper keeps a secret from being printed by
 * accident inside the process: it renders as `***` through every path that stringifies a
 * value, and the real text comes out only where it must — at spawn, inside the runner. The
 * registry catches what the wrapper cannot: a script that echoes the password it was given.
 */

import { InputError } from '../errors.js';
import type { Platform } from './context.js';
import { resolveTargetPathFrom } from './paths.js';

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

/** Internal mask-only capability captured with a resolved input set or execution plan. */
export interface SecretMasker {
  mask(text: string): string;
}

/**
 * Maximum UTF-16 code units across the unique maskable parts in one registry snapshot.
 * This bounds the matcher to at most this many non-root trie nodes.
 */
export const MAX_SECRET_REGISTRY_CODE_UNITS = 262_144;

const CAPACITY_ERROR_MESSAGE =
  'the total size of secret input values exceeds the masking safety limit';

const SECRET_STRING = Symbol('SecretString');

/** Publicly nameable only as an opaque, safely stringifiable value. */
export interface SecretString {
  readonly [SECRET_STRING]: true;
  toString(): string;
  toJSON(): typeof MASK;
}

class OpaqueSecretString implements SecretString {
  readonly [SECRET_STRING] = true;

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

/** Authentic wrapper resolvers, owned only by this module and never exposed through lookup. */
const SECRET_VALUES = new WeakMap<object, () => string>();

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

function secretFromResolver(resolve: () => string): SecretString {
  const secret = Object.freeze(new OpaqueSecretString());
  SECRET_VALUES.set(secret, resolve);
  return secret;
}

/** Reads a genuine wrapper's private string without dynamic method dispatch. */
function privateSecretValue(value: unknown): string | undefined {
  if ((typeof value !== 'object' || value === null) && typeof value !== 'function') {
    return undefined;
  }
  const resolve = SECRET_VALUES.get(value);
  if (resolve === undefined) {
    return undefined;
  }
  const text = resolve();
  return typeof text === 'string' ? text : undefined;
}

function resolveSecret(secret: SecretString): string {
  const text = privateSecretValue(secret);
  if (text === undefined) {
    throw new TypeError('the value is not an engine secret');
  }
  return text;
}

/** Creates an opaque secret at the resolution boundary. */
export function createSecretString(value: string): SecretString {
  return secretFromResolver(() => value);
}

/** Joins public and opaque pieces without exposing the resulting text. */
export function composeSecretString(parts: readonly (string | SecretString)[]): SecretString {
  const snapshot = Object.freeze([...parts]);
  return secretFromResolver(() =>
    snapshot.map((part) => (isSecretString(part) ? resolveSecret(part) : part)).join(''),
  );
}

/** Lazily anchors a path while keeping the value opaque. */
export function resolveSecretPathFrom(
  secret: SecretString,
  basePath: string,
  platform: Platform,
): SecretString {
  const baseSnapshot = basePath;
  return secretFromResolver(() =>
    resolveTargetPathFrom(resolveSecret(secret), baseSnapshot, platform),
  );
}

/** Tests an opaque value without returning its text. */
export function secretMatches(secret: SecretString, pattern: RegExp): boolean {
  return new RegExp(pattern.source, pattern.flags).test(resolveSecret(secret));
}

/** Returns only the length needed by required-input validation. */
export function secretLength(secret: SecretString): number {
  return resolveSecret(secret).length;
}

/** Registers an opaque secret without handing its text back to resolution. */
export function registerSecretForMasking(secret: SecretString, registry: SecretRegistry): boolean {
  return registry.register(resolveSecret(secret));
}

/** Plaintext capability used only by the spawn runner at the child-process boundary. */
export function revealSecretString(secret: SecretString): string {
  return resolveSecret(secret);
}

export function isSecretString(value: unknown): value is SecretString {
  return (
    ((typeof value === 'object' && value !== null) || typeof value === 'function') &&
    SECRET_VALUES.has(value)
  );
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

interface MatcherNode {
  readonly transitions: Map<number, number>;
  failure: number;
  longestMatchLength: number;
}

/**
 * An immutable Aho-Corasick matcher for one registry snapshot.
 *
 * JavaScript string offsets are UTF-16 code-unit offsets, as are `String.indexOf` offsets.
 * Building and scanning by `charCodeAt` therefore preserves the old matching semantics for
 * astral characters and unpaired surrogates. Only the longest match ending at a state is
 * needed: every shorter match with the same end is contained in that interval.
 */
class SecretMatcher {
  readonly #nodes: readonly MatcherNode[];
  readonly #maximumPatternLength: number;

  constructor(patterns: readonly string[]) {
    const nodes: MatcherNode[] = [createMatcherNode()];
    let maximumPatternLength = 0;

    for (const pattern of patterns) {
      let state = 0;
      maximumPatternLength = Math.max(maximumPatternLength, pattern.length);

      for (let index = 0; index < pattern.length; index += 1) {
        const codeUnit = pattern.charCodeAt(index);
        const transition = nodes[state]!.transitions.get(codeUnit);
        if (transition !== undefined) {
          state = transition;
          continue;
        }

        const parentState = state;
        state = nodes.length;
        nodes.push(createMatcherNode());
        nodes[parentState]!.transitions.set(codeUnit, state);
      }

      nodes[state]!.longestMatchLength = Math.max(nodes[state]!.longestMatchLength, pattern.length);
    }

    const queue: number[] = [];
    for (const state of nodes[0]!.transitions.values()) {
      queue.push(state);
    }

    for (let head = 0; head < queue.length; head += 1) {
      const state = queue[head]!;
      const node = nodes[state]!;

      for (const [codeUnit, childState] of node.transitions) {
        let failureState = node.failure;
        let failureTransition = nodes[failureState]!.transitions.get(codeUnit);
        while (failureTransition === undefined && failureState !== 0) {
          failureState = nodes[failureState]!.failure;
          failureTransition = nodes[failureState]!.transitions.get(codeUnit);
        }

        const child = nodes[childState]!;
        child.failure = failureTransition ?? 0;
        child.longestMatchLength = Math.max(
          child.longestMatchLength,
          nodes[child.failure]!.longestMatchLength,
        );
        queue.push(childState);
      }
    }

    this.#nodes = nodes;
    this.#maximumPatternLength = maximumPatternLength;
  }

  /** Replaces every range containing a secret found in this version of `text`. */
  maskOnce(text: string): string {
    if (this.#maximumPatternLength === 0 || text.length === 0) {
      return text;
    }

    // Matches arrive in end-position order. Pending connected components are a numeric
    // stack, not an object per occurrence. A component is emitted only after the maximum
    // pattern length proves that no later match can overlap it; adjacent matches remain
    // separate because the overlap comparison is strict.
    const pendingStarts: number[] = [];
    const pendingEnds: number[] = [];
    let pendingHead = 0;
    let state = 0;
    let out = '';
    let cursor = 0;

    const flushThrough = (safeStart: number): void => {
      while (pendingHead < pendingEnds.length && pendingEnds[pendingHead]! <= safeStart) {
        out += text.slice(cursor, pendingStarts[pendingHead]!) + MASK;
        cursor = pendingEnds[pendingHead]!;
        pendingHead += 1;
      }

      if (pendingHead === pendingEnds.length) {
        pendingStarts.length = 0;
        pendingEnds.length = 0;
        pendingHead = 0;
      } else if (pendingHead >= 1_024 && pendingHead * 2 >= pendingEnds.length) {
        pendingStarts.copyWithin(0, pendingHead);
        pendingEnds.copyWithin(0, pendingHead);
        pendingStarts.length -= pendingHead;
        pendingEnds.length -= pendingHead;
        pendingHead = 0;
      }
    };

    for (let index = 0; index < text.length; index += 1) {
      const codeUnit = text.charCodeAt(index);
      let transition = this.#nodes[state]!.transitions.get(codeUnit);
      while (transition === undefined && state !== 0) {
        state = this.#nodes[state]!.failure;
        transition = this.#nodes[state]!.transitions.get(codeUnit);
      }
      state = transition ?? 0;

      const end = index + 1;
      const matchLength = this.#nodes[state]!.longestMatchLength;
      if (matchLength > 0) {
        let start = end - matchLength;
        let mergedEnd = end;

        while (pendingEnds.length > pendingHead && pendingEnds[pendingEnds.length - 1]! > start) {
          start = Math.min(start, pendingStarts.pop()!);
          mergedEnd = Math.max(mergedEnd, pendingEnds.pop()!);
        }

        pendingStarts.push(start);
        pendingEnds.push(mergedEnd);
      }

      flushThrough(end + 1 - this.#maximumPatternLength);
    }

    flushThrough(Number.POSITIVE_INFINITY);
    return cursor === 0 ? text : out + text.slice(cursor);
  }
}

function createMatcherNode(): MatcherNode {
  return { transitions: new Map(), failure: 0, longestMatchLength: 0 };
}

/** Shared only by registries whose independent value sets describe the same snapshot. */
interface MatcherCache {
  matcher?: SecretMatcher;
}

/**
 * The secrets a run knows about, and the one function that removes them from text.
 *
 * Every secret is registered at resolution — before any step can launch — so that output a
 * child process produces can be masked as it is read, not after it has been written.
 */
export class SecretRegistry {
  readonly #values = new Set<string>();
  #registeredCodeUnits = 0;
  #matcherCache: MatcherCache = {};

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
    const additions = new Set<string>();
    let addedCodeUnits = 0;

    for (const part of parts) {
      // Length alone is not enough: four spaces would pass, and masking them would black out
      // the indentation of every line a child process prints.
      if (
        hasMinimumMaskableLength(part.trim()) &&
        !this.#values.has(part) &&
        !additions.has(part)
      ) {
        if (
          part.length >
          MAX_SECRET_REGISTRY_CODE_UNITS - this.#registeredCodeUnits - addedCodeUnits
        ) {
          throw capacityError();
        }
        additions.add(part);
        addedCodeUnits += part.length;
      }
    }

    if (additions.size > 0) {
      this.#matcherCache = {};
      for (const part of additions) {
        this.#values.add(part);
      }
      this.#registeredCodeUnits += addedCodeUnits;
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
    const additions: string[] = [];
    let addedCodeUnits = 0;
    for (const value of source.#values) {
      if (this.#values.has(value)) {
        continue;
      }
      if (
        value.length >
        MAX_SECRET_REGISTRY_CODE_UNITS - this.#registeredCodeUnits - addedCodeUnits
      ) {
        throw capacityError();
      }
      additions.push(value);
      addedCodeUnits += value.length;
    }

    const combined = new SecretRegistry();
    for (const value of this.#values) {
      combined.#values.add(value);
    }
    for (const value of additions) {
      combined.#values.add(value);
    }
    combined.#registeredCodeUnits = this.#registeredCodeUnits + addedCodeUnits;
    if (combined.#values.size === this.#values.size) {
      combined.#matcherCache = this.#matcherCache;
    } else if (combined.#values.size === source.#values.size) {
      combined.#matcherCache = source.#matcherCache;
    }
    return combined;
  }

  /** Replaces this registry with the completed secret set of one successful resolution. */
  replaceWith(source: SecretRegistry): void {
    if (setsEqual(this.#values, source.#values)) {
      this.#matcherCache = source.#matcherCache;
      return;
    }

    const values = new Set(source.#values);

    this.#values.clear();
    for (const value of values) {
      this.#values.add(value);
    }
    this.#registeredCodeUnits = source.#registeredCodeUnits;
    this.#matcherCache = source.#matcherCache;
  }

  /** Captures the current secret set as an immutable mask-only capability. */
  snapshot(): SecretMasker {
    const matcher = this.#matcher();
    return Object.freeze({
      mask: (text: string): string =>
        matcher === undefined ? text : maskWithMatcher(text, matcher),
    });
  }

  /** Replaces every registered secret in `text` with the mask. */
  mask(text: string): string {
    const matcher = this.#matcher();
    return matcher === undefined ? text : maskWithMatcher(text, matcher);
  }

  #matcher(): SecretMatcher | undefined {
    if (this.#values.size === 0) {
      return undefined;
    }

    // Stable ordering makes the cached snapshot deterministic even though matching behavior
    // itself is independent of registration order.
    return (this.#matcherCache.matcher ??= new SecretMatcher(
      [...this.#values].sort(
        (left, right) => right.length - left.length || (left < right ? -1 : left === right ? 0 : 1),
      ),
    ));
  }
}

/** Shared overlap-safe implementation for mutable registries and immutable snapshots. */
function maskWithMatcher(text: string, matcher: SecretMatcher): string {
  let masked = text;
  for (let pass = 0; pass < MAX_MASKING_PASSES; pass += 1) {
    const next = matcher.maskOnce(masked);
    if (next === masked) {
      return masked;
    }

    masked = next;
  }

  // Returning an intermediate value could expose part of a collision chain. MASK itself is
  // shorter than every registrable secret, so masking the whole input is safely stable; the
  // extra masking is limited to this pathological budget-exhaustion path.
  return MASK;
}

function capacityError(): InputError {
  return new InputError('RUNE-202', CAPACITY_ERROR_MESSAGE);
}

function setsEqual(left: ReadonlySet<string>, right: ReadonlySet<string>): boolean {
  if (left.size !== right.size) {
    return false;
  }
  for (const value of left) {
    if (!right.has(value)) {
      return false;
    }
  }
  return true;
}
