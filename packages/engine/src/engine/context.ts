/**
 * What `${...}` can refer to (docs/architecture.md §6.1).
 *
 * This module owns the *names*: which are built in, which belong to a namespace, and which
 * are reserved for a later schema version. The values behind them are produced during input
 * resolution and planning; a name that is not listed here resolves to nothing, anywhere.
 */

import { suggest } from '../suggest.js';
import type { InputType } from '../manifest/v1/schema.js';

/** Built-in variables that stand alone: `${home}`, `${platform}`. */
export const BUILT_IN_VARIABLES = ['home', 'temp', 'platform', 'manifestDir'] as const;
export type BuiltInVariable = (typeof BUILT_IN_VARIABLES)[number];

/** Fields of `${product.*}`. */
export const PRODUCT_FIELDS = ['name', 'version'] as const;
export type ProductField = (typeof PRODUCT_FIELDS)[number];

/** The process environment, read-only and freely readable (§6.1, §4.3). */
export const ENVIRONMENT_NAMESPACE = 'env';
export const PRODUCT_NAMESPACE = 'product';

/** Namespaces v1 rejects on purpose, so a later version can define them (§13). */
export const RESERVED_NAMESPACES: Readonly<Record<string, string>> = {
  steps: 'step outputs',
  rune: 'engine variables',
};

/**
 * Every name `${...}` already means something. An input may not take one as its id: the
 * reference would be ambiguous, and the built-in would win silently.
 */
export const BUILT_IN_NAMES: readonly string[] = [
  ...BUILT_IN_VARIABLES,
  PRODUCT_NAMESPACE,
  ENVIRONMENT_NAMESPACE,
  ...Object.keys(RESERVED_NAMESPACES),
];

/** What a `${...}` reference points at, once it is known to point at something. */
export type Reference =
  | { readonly kind: 'input'; readonly id: string }
  | { readonly kind: 'builtin'; readonly name: BuiltInVariable }
  | { readonly kind: 'product'; readonly field: ProductField }
  | { readonly kind: 'environment'; readonly name: string };

export type ReferenceResolution =
  | { readonly ok: true; readonly reference: Reference }
  | { readonly ok: false; readonly message: string };

/**
 * Resolves the dotted path of a `${...}` reference against the declared inputs and the
 * built-ins. The message of a failure is the whole error a reader gets, so it says what the
 * name would have to be instead of only that it is wrong.
 */
export function resolveReference(
  segments: readonly string[],
  inputIds: Iterable<string>,
): ReferenceResolution {
  const [head, ...rest] = segments;
  if (head === undefined) {
    return { ok: false, message: 'an empty reference points at nothing' };
  }

  const reserved = RESERVED_NAMESPACES[head];
  if (reserved !== undefined) {
    return {
      ok: false,
      message: `\${${segments.join('.')}} is reserved for ${reserved} and is not available in schemaVersion 1`,
    };
  }

  if (head === ENVIRONMENT_NAMESPACE) {
    const [name, ...extra] = rest;
    if (name === undefined) {
      return { ok: false, message: '${env} needs the name of a variable: ${env.PATH}' };
    }
    if (extra.length > 0) {
      return {
        ok: false,
        message: `\${${segments.join('.')}} has one segment too many — an environment variable is \${env.NAME}`,
      };
    }
    return { ok: true, reference: { kind: 'environment', name } };
  }

  if (head === PRODUCT_NAMESPACE) {
    const [field, ...extra] = rest;
    if (field === undefined || extra.length > 0 || !isProductField(field)) {
      return {
        ok: false,
        message: `\${${segments.join('.')}} is not a product field — ${PRODUCT_FIELDS.map((known) => `\${product.${known}}`).join(' and ')} exist`,
      };
    }
    return { ok: true, reference: { kind: 'product', field } };
  }

  if (isBuiltInVariable(head)) {
    if (rest.length > 0) {
      return {
        ok: false,
        message: `\${${head}} is a value, not a namespace — \${${segments.join('.')}} points at nothing`,
      };
    }
    return { ok: true, reference: { kind: 'builtin', name: head } };
  }

  const ids = [...inputIds];
  if (ids.includes(head)) {
    if (rest.length > 0) {
      return {
        ok: false,
        message: `\${${head}} is an input value, not a namespace — \${${segments.join('.')}} points at nothing`,
      };
    }
    return { ok: true, reference: { kind: 'input', id: head } };
  }

  const suggestion = suggest(head, [...ids, ...BUILT_IN_VARIABLES, PRODUCT_NAMESPACE]);
  return {
    ok: false,
    message: `\${${segments.join('.')}} is neither a declared input nor a built-in variable${
      suggestion === undefined ? '' : ` — did you mean \${${suggestion}}?`
    }`,
  };
}

/** The type a reference carries into a condition (docs/architecture.md §6.2). */
export type ValueType = 'boolean' | 'string' | 'integer' | 'stringList';

/** The value type of an input, which is what makes conditions checkable without values. */
export function typeOfInput(type: InputType): ValueType {
  switch (type) {
    case 'boolean':
      return 'boolean';
    case 'multiselect':
      return 'stringList';
    default:
      return 'string';
  }
}

/** The value type of a resolved reference. Everything but an input is a plain string. */
export function typeOfReference(
  reference: Reference,
  typeOfInputId: (id: string) => InputType | undefined,
): ValueType | undefined {
  if (reference.kind !== 'input') {
    return 'string';
  }
  const type = typeOfInputId(reference.id);
  return type === undefined ? undefined : typeOfInput(type);
}

function isBuiltInVariable(name: string): name is BuiltInVariable {
  return (BUILT_IN_VARIABLES as readonly string[]).includes(name);
}

function isProductField(name: string): name is ProductField {
  return (PRODUCT_FIELDS as readonly string[]).includes(name);
}
