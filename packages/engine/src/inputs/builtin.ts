/**
 * The seven input types of the MVP (docs/architecture.md §4.2, §5).
 *
 * Every rule an author or a pipeline can run into lives here: which words mean true, that a
 * select is matched against option *values* and never against labels, that a multiselect
 * comma-splits but accepts a JSON array when a value contains a comma, and that a `text`
 * value is matched against its `pattern`.
 */

import { createSecretString, isSecretString, MASK, secretLength } from '../engine/secrets.js';
import { formatDiagnostic, quotedDiagnostic, type DiagnosticPart } from '../diagnostics.js';
import { compileInputPattern } from '../manifest/v1/rules.js';
import { optionValue, type InputSpec } from '../manifest/v1/schema.js';
import {
  FALSE_WORDS,
  TRUE_WORDS,
  type Coercion,
  type InputTypeHandler,
  type InputValue,
} from './base.js';
import { nativeStringArraySnapshot } from './snapshot.js';

/** The cap on a value that is matched against a pattern (§4.2). */
export const MAX_PATTERN_INPUT_BYTES = 4096;

function ok(value: InputValue): Coercion {
  return { ok: true, value };
}

function fail(...diagnosticParts: readonly DiagnosticPart[]): Coercion {
  const failure = {
    ok: false,
    message: formatDiagnostic(diagnosticParts),
  } as const;
  Object.defineProperty(failure, 'diagnosticParts', {
    value: Object.freeze([...diagnosticParts]),
  });
  return failure;
}

/** Names a value that is not text, for a message that says what was written. */
function describe(value: unknown): DiagnosticPart {
  switch (typeof value) {
    case 'string':
      return quotedDiagnostic(value);
    case 'number':
    case 'boolean':
      return JSON.stringify(value) ?? 'unknown';
    case 'undefined':
      return 'undefined';
    case 'bigint':
      return 'bigint';
    case 'symbol':
      return 'symbol';
    case 'function':
      return 'function';
    case 'object':
      if (value === null) {
        return 'null';
      }
      try {
        return Array.isArray(value) ? 'array' : 'object';
      } catch {
        return 'object';
      }
  }
}

function optionValues(spec: InputSpec): readonly string[] {
  return 'options' in spec ? spec.options.map(optionValue) : [];
}

function listOptions(spec: InputSpec): readonly DiagnosticPart[] {
  return listOptionValues(optionValues(spec));
}

function listOptionValues(values: readonly string[]): readonly DiagnosticPart[] {
  return values.flatMap((value, index) => [
    ...(index === 0 ? [] : [', ']),
    quotedDiagnostic(value),
  ]);
}

/** Free text, optionally constrained by a pattern the manifest author wrote. */
function checkPattern(text: string, spec: InputSpec): Coercion {
  if (!('pattern' in spec) || spec.pattern === undefined) {
    return ok(text);
  }

  // The cap is applied before the regular expression runs: a pattern is authored code, and a
  // long value is what turns an unlucky one into a hang (§4.2). The value is not echoed —
  // there would be kilobytes of it.
  if (Buffer.byteLength(text, 'utf8') > MAX_PATTERN_INPUT_BYTES) {
    return fail(
      `the value is longer than the ${MAX_PATTERN_INPUT_BYTES} bytes a checked value may have`,
    );
  }

  const pattern = compileInputPattern(spec.pattern);
  if (!new RegExp(`^(?:${pattern.source})$`, pattern.flags).test(text)) {
    const hint =
      'patternHint' in spec && spec.patternHint !== undefined ? spec.patternHint : undefined;
    return hint === undefined
      ? fail(quotedDiagnostic(text), ' does not match ', spec.pattern)
      : fail(quotedDiagnostic(text), ': ', hint);
  }
  return ok(text);
}

const text: InputTypeHandler = {
  name: 'text',
  secret: false,
  empty: () => '',
  isAbsent: (value) => value === '',
  fromString: (value, spec) => checkPattern(value, spec),
  fromNative: (value, spec) =>
    typeof value === 'string' ? checkPattern(value, spec) : fail(describe(value), ' is not text'),
  render: (value) => String(value),
  compare: (value) => String(value),
};

const secret: InputTypeHandler = {
  name: 'secret',
  secret: true,
  empty: () => createSecretString(''),
  isAbsent: (value) => (isSecretString(value) ? secretLength(value) === 0 : value === ''),
  fromString: (value) => ok(createSecretString(value)),
  // Never echoes what it rejects: the reason a value is wrong is public, the value is not.
  // A frontend may hand back an already opaque immutable wrapper when it re-resolves. Retain it:
  // its private value is fixed, and public consumers continue to observe only the mask.
  fromNative: (value) => {
    if (typeof value === 'string') {
      return ok(createSecretString(value));
    }
    return isSecretString(value) ? ok(value) : fail('the value is not text');
  },
  // Renders the mask, never the secret. A secret reaches a command as the wrapper itself,
  // and the runner unwraps it at spawn — this is a rendering function, and rendering a
  // secret into text is exactly what invariant 6 forbids everywhere but there.
  render: () => MASK,
  compare: (value) => (isSecretString(value) ? value : createSecretString('')),
};

const boolean: InputTypeHandler = {
  name: 'boolean',
  secret: false,
  empty: () => false,
  // `false` is an answer, not the absence of one: a checkbox left unticked on purpose must
  // satisfy a required input.
  isAbsent: () => false,
  fromString: (value) => {
    const written = value.trim().toLowerCase();
    if ((TRUE_WORDS as readonly string[]).includes(written)) {
      return ok(true);
    }
    if ((FALSE_WORDS as readonly string[]).includes(written)) {
      return ok(false);
    }
    return fail(
      quotedDiagnostic(value),
      ` is not one of ${[...TRUE_WORDS, ...FALSE_WORDS].join(', ')}`,
    );
  },
  fromNative: (value) =>
    typeof value === 'boolean' ? ok(value) : fail(describe(value), ' is not true or false'),
  render: (value) => (value === true ? 'true' : 'false'),
  compare: (value) => value === true,
};

/** Reads one select option value written as text. */
function selectFromString(value: string, spec: InputSpec): Coercion {
  return optionValues(spec).includes(value)
    ? ok(value)
    : fail(
        quotedDiagnostic(value),
        ' is not one of the option values (',
        ...listOptions(spec),
        ')',
      );
}

const select: InputTypeHandler = {
  name: 'select',
  secret: false,
  empty: () => '',
  isAbsent: (value) => value === '',
  fromString: selectFromString,
  fromNative: (value, spec) =>
    typeof value === 'string'
      ? selectFromString(value, spec)
      : fail(describe(value), ' is not text'),
  render: (value) => String(value),
  compare: (value) => String(value),
};

/**
 * Reads a multiselect written as text. Comma-separated is the everyday form; a value that
 * contains a comma is written as a JSON array, which is why a leading `[` switches forms
 * rather than being taken literally (§5).
 */
function multiselectFromString(value: string, spec: InputSpec): Coercion {
  let entries: string[];

  if (value.trimStart().startsWith('[')) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(value);
    } catch {
      return fail(
        'starts with "[" and is therefore read as a JSON array, but it is not valid JSON',
      );
    }
    if (!Array.isArray(parsed) || parsed.some((entry) => typeof entry !== 'string')) {
      return fail('is a JSON array, so every entry must be a string');
    }
    entries = parsed as string[];
  } else {
    entries = value.split(',').map((entry) => entry.trim());
  }

  return membership(entries, spec, value);
}

/**
 * The one sentence a value outside the options gets, wherever it was written.
 *
 * `supplied` is the single text the entries were parsed out of, when there was one. The
 * diagnostic then names that text instead of the entries: splitting and trimming are
 * spellings RUNE derived, and a registry holds what its supplier wrote, so naming the pieces
 * would print a declared secret piece by piece past masks that cannot match any of them
 * (§10). A native array arrives already in pieces, and each of those its caller did write.
 */
function membership(entries: readonly string[], spec: InputSpec, supplied?: string): Coercion {
  const values = optionValues(spec);
  const known = new Set(values);
  const unknown = entries.filter((entry) => !known.has(entry));
  if (unknown.length === 0) {
    return ok(Object.freeze([...entries]));
  }
  const options: readonly DiagnosticPart[] = [' (', ...listOptionValues(values), ')'];
  if (supplied === undefined) {
    return fail(
      ...listOptionValues(unknown),
      unknown.length === 1 ? ' is not one of the option values' : ' are not option values',
      ...options,
    );
  }
  return fail(
    quotedDiagnostic(supplied),
    entries.length === 1
      ? ' is not one of the option values'
      : ' contains values that are not option values',
    ...options,
  );
}

const multiselect: InputTypeHandler = {
  name: 'multiselect',
  secret: false,
  empty: () => Object.freeze([]),
  isAbsent: (value) => Array.isArray(value) && value.length === 0,
  fromString: multiselectFromString,
  fromNative: (value, spec) => {
    if (typeof value === 'string') {
      return multiselectFromString(value, spec);
    }
    const entries = nativeStringArraySnapshot(value);
    if (entries === undefined) {
      return fail(describe(value), ' is not a list of option values');
    }
    return membership(entries, spec);
  },
  render: (value) => (Array.isArray(value) ? value.join(',') : String(value)),
  compare: (value) => (Array.isArray(value) ? (value as readonly string[]) : []),
};

/**
 * A path. Whether it exists is the manifest author's business — a step checks it, or creates
 * it. Frontends may hint, never enforce (§5).
 */
function pathType(name: 'file' | 'directory'): InputTypeHandler {
  return {
    name,
    secret: false,
    empty: () => '',
    isAbsent: (value) => value === '',
    fromString: (value) => ok(value),
    fromNative: (value) =>
      typeof value === 'string' ? ok(value) : fail(describe(value), ' is not a path'),
    render: (value) => String(value),
    compare: (value) => String(value),
  };
}

/** The handlers of the seven MVP types, in the order the manifest schema lists them. */
export const BUILT_IN_INPUT_TYPES: readonly InputTypeHandler[] = [
  text,
  secret,
  boolean,
  select,
  multiselect,
  pathType('file'),
  pathType('directory'),
];
