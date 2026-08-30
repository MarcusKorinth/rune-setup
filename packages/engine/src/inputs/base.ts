/**
 * What an input type is (docs/architecture.md §13).
 *
 * The registry is the authority on type behaviour: it decides what a value means, what an
 * unset input is worth, and how a value reaches a command line. Frontends may re-ask, never
 * accept — every value that affects execution passes through here (invariant 7).
 */

import type { SecretString } from '../engine/secrets.js';
import type { DiagnosticPart } from '../diagnostics.js';
import type { InputSpec, InputType } from '../manifest/v1/schema.js';

/** A resolved input value. A `secret` carries its text inside a {@link SecretString}. */
export type InputValue = string | boolean | readonly string[] | SecretString;

export type Coercion =
  | { readonly ok: true; readonly value: InputValue }
  | {
      readonly ok: false;
      readonly message: string;
      /** Raw fragments retained so the resolver can mask before presenting them. */
      readonly diagnosticParts?: readonly DiagnosticPart[];
    };

export interface InputTypeHandler {
  readonly name: InputType;
  /** Whether values of this type are wrapped and masked (§10). */
  readonly secret: boolean;

  /** What an unset optional input, or a disabled one, is worth (§4.2, §5). */
  readonly empty: (spec: InputSpec) => InputValue;

  /**
   * Whether a value counts as no answer at all, which is what makes a required input still
   * missing. A boolean is never absent — `false` is an answer — while an empty string and an
   * empty selection are exactly what an environment variable that was never set expands to.
   */
  readonly isAbsent: (value: InputValue) => boolean;

  /** A value written as text: `--set`, `RUNE_INPUT_*`, or a string in a values file. */
  readonly fromString: (text: string, spec: InputSpec) => Coercion;

  /**
   * A value written in its own type in a values file — a YAML boolean, a YAML list. Anything
   * else is refused here rather than stringified, so a mistake stays visible (§5).
   */
  readonly fromNative: (value: unknown, spec: InputSpec) => Coercion;

  /**
   * The text a value contributes to a command (§6.1): a boolean as `true`/`false`, a
   * multiselect comma-joined, everything else as itself.
   */
  readonly render: (value: InputValue) => string;

  /** The value a condition compares (§6.2); secrets remain authentic opaque wrappers. */
  readonly compare: (value: InputValue) => boolean | string | readonly string[] | SecretString;
}

/** The accepted spellings of a boolean, as documented in §5. */
export const TRUE_WORDS = ['true', '1', 'yes'] as const;
export const FALSE_WORDS = ['false', '0', 'no'] as const;
