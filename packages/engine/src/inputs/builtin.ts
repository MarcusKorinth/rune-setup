/**
 * The seven input types of the MVP (docs/architecture.md §4.2, §5).
 *
 * Every rule an author or a pipeline can run into lives here: which words mean true, that a
 * select is matched against option *values* and never against labels, that a multiselect
 * comma-splits but accepts a JSON array when a value contains a comma, and that a `text`
 * value is matched against its `pattern`.
 */

import { SecretString } from '../engine/secrets.js';
import { compileInputPattern } from '../manifest/v1/rules.js';
import { optionValue, type InputSpec } from '../manifest/v1/schema.js';
import { FALSE_WORDS, TRUE_WORDS, type Coercion, type InputTypeHandler } from './base.js';

/** The cap on a value that is matched against a pattern (§4.2). */
export const MAX_PATTERN_INPUT_BYTES = 4096;

function ok(value: Parameters<typeof String>[0] | boolean | readonly string[]): Coercion {
  return { ok: true, value: value as never };
}

function fail(message: string): Coercion {
  return { ok: false, message };
}

/** Names a value that is not text, for a message that says what was written. */
function describe(value: unknown): string {
  return JSON.stringify(value) ?? String(value);
}

function optionValues(spec: InputSpec): readonly string[] {
  return 'options' in spec ? spec.options.map(optionValue) : [];
}

function listOptions(spec: InputSpec): string {
  return optionValues(spec)
    .map((value) => `"${value}"`)
    .join(', ');
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
    return fail(
      hint === undefined ? `"${text}" does not match ${spec.pattern}` : `"${text}": ${hint}`,
    );
  }
  return ok(text);
}

const text: InputTypeHandler = {
  name: 'text',
  secret: false,
  empty: () => '',
  fromString: (value, spec) => checkPattern(value, spec),
  fromNative: (value, spec) =>
    typeof value === 'string' ? checkPattern(value, spec) : fail(`${describe(value)} is not text`),
  render: (value) => String(value),
  compare: (value) => String(value),
};

const secret: InputTypeHandler = {
  name: 'secret',
  secret: true,
  empty: () => new SecretString(''),
  fromString: (value) => ok(new SecretString(value) as never),
  // Never echoes what it rejects: the reason a value is wrong is public, the value is not.
  fromNative: (value) =>
    typeof value === 'string'
      ? ok(new SecretString(value) as never)
      : fail('the value is not text'),
  render: (value) => (value instanceof SecretString ? value.reveal() : String(value)),
  compare: (value) => (value instanceof SecretString ? value.reveal() : String(value)),
};

const boolean: InputTypeHandler = {
  name: 'boolean',
  secret: false,
  empty: () => false,
  fromString: (value) => {
    const written = value.trim().toLowerCase();
    if ((TRUE_WORDS as readonly string[]).includes(written)) {
      return ok(true);
    }
    if ((FALSE_WORDS as readonly string[]).includes(written)) {
      return ok(false);
    }
    return fail(`"${value}" is not one of ${[...TRUE_WORDS, ...FALSE_WORDS].join(', ')}`);
  },
  fromNative: (value) =>
    typeof value === 'boolean' ? ok(value) : fail(`${describe(value)} is not true or false`),
  render: (value) => (value === true ? 'true' : 'false'),
  compare: (value) => value === true,
};

const select: InputTypeHandler = {
  name: 'select',
  secret: false,
  empty: () => '',
  fromString: (value, spec) =>
    optionValues(spec).includes(value)
      ? ok(value)
      : fail(`"${value}" is not one of the option values (${listOptions(spec)})`),
  fromNative: (value, spec) =>
    typeof value === 'string'
      ? select.fromString(value, spec)
      : fail(`${describe(value)} is not text`),
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
    } catch (cause) {
      return fail(
        `starts with "[" and is therefore read as a JSON array, but it is not valid JSON: ${cause instanceof Error ? cause.message : String(cause)}`,
      );
    }
    if (!Array.isArray(parsed) || parsed.some((entry) => typeof entry !== 'string')) {
      return fail('is a JSON array, so every entry must be a string');
    }
    entries = parsed as string[];
  } else {
    entries = value === '' ? [] : value.split(',').map((entry) => entry.trim());
  }

  return membership(entries, spec);
}

/** The one sentence a value outside the options gets, wherever it was written. */
function membership(entries: readonly string[], spec: InputSpec): Coercion {
  const known = optionValues(spec);
  const unknown = entries.filter((entry) => !known.includes(entry));
  if (unknown.length === 0) {
    return ok(entries);
  }
  const named = unknown.map((entry) => `"${entry}"`).join(', ');
  return fail(
    `${named} ${unknown.length === 1 ? 'is not one of the option values' : 'are not option values'} (${listOptions(spec)})`,
  );
}

const multiselect: InputTypeHandler = {
  name: 'multiselect',
  secret: false,
  empty: () => [],
  fromString: multiselectFromString,
  fromNative: (value, spec) => {
    if (typeof value === 'string') {
      return multiselectFromString(value, spec);
    }
    if (!Array.isArray(value) || value.some((entry) => typeof entry !== 'string')) {
      return fail(`${describe(value)} is not a list of option values`);
    }
    return membership(value as string[], spec);
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
    fromString: (value) => ok(value),
    fromNative: (value) =>
      typeof value === 'string' ? ok(value) : fail(`${describe(value)} is not a path`),
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
