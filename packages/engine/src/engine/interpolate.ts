/**
 * `${...}` interpolation (docs/architecture.md §6.1).
 *
 * A template is scanned once into literals and references; a rendered value is never scanned
 * again. That single pass is what closes injection through input values: a value that happens
 * to contain `${...}` stays the characters the user typed (invariant 3).
 */

import { ResolutionError } from '../errors.js';

/** A `${...}` occurrence: what it names, and where it stands in the text that holds it. */
export interface TemplateReference {
  /** The dotted path inside the braces: `${env.JAVA_HOME}` → `['env', 'JAVA_HOME']`. */
  readonly segments: readonly string[];
  /** The reference as written, for messages. */
  readonly text: string;
  /** Offset of the `$` in the text. */
  readonly offset: number;
}

/** What {@link scanReference} found at an offset: a reference, or why there is none. */
export type ReferenceScan =
  | { readonly ok: true; readonly reference: TemplateReference; readonly next: number }
  | {
      readonly ok: false;
      /**
       * `unterminated` is the one failure a template can say more about: a template has an
       * escape for a literal `${`, and a condition has none.
       */
      readonly reason: 'unterminated' | 'malformed';
      readonly message: string;
      readonly offset: number;
    };

export type TemplatePart =
  | { readonly kind: 'literal'; readonly text: string }
  | { readonly kind: 'reference'; readonly reference: TemplateReference };

export type TemplateScan =
  | { readonly ok: true; readonly parts: readonly TemplatePart[] }
  | { readonly ok: false; readonly message: string; readonly offset: number };

const NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * Splits a template into literals and references.
 *
 * `$${` renders a literal `${`; a lone `$` is a literal `$`; an unterminated `${` is an error
 * rather than literal text, because it is always a typo and never an intention.
 */
export function scanTemplate(text: string): TemplateScan {
  const parts: TemplatePart[] = [];
  let literal = '';
  let index = 0;

  const flush = (): void => {
    if (literal !== '') {
      parts.push({ kind: 'literal', text: literal });
      literal = '';
    }
  };

  while (index < text.length) {
    const char = text[index];

    if (char !== '$') {
      literal += char;
      index += 1;
      continue;
    }

    if (text.startsWith('$${', index)) {
      literal += '${';
      index += 3;
      continue;
    }

    if (!text.startsWith('${', index)) {
      literal += '$';
      index += 1;
      continue;
    }

    const scan = scanReference(text, index);
    if (!scan.ok) {
      return {
        ok: false,
        // The escape belongs to templates, so only a template offers it.
        message:
          scan.reason === 'unterminated'
            ? 'unterminated ${ — a reference needs a closing brace, and a literal $ followed by a brace is written $${'
            : scan.message,
        offset: scan.offset,
      };
    }

    flush();
    parts.push({ kind: 'reference', reference: scan.reference });
    index = scan.next;
  }

  flush();
  return { ok: true, parts };
}

/**
 * Reads the `${...}` that starts at `start`, which must be a `${`.
 *
 * The single reader of the reference grammar of §6.1. A `when:` holds the same references a
 * template does, so both scanners come here: one grammar, and one explanation of every way it
 * can be written wrong — an author who mistypes `${a-b}` reads the same sentence whether it
 * stood in an argument or in a condition.
 */
export function scanReference(text: string, start: number): ReferenceScan {
  const close = text.indexOf('}', start);
  if (close === -1) {
    return {
      ok: false,
      reason: 'unterminated',
      message: 'unterminated ${ — a reference needs a closing brace',
      offset: start,
    };
  }

  const written = text.slice(start, close + 1);
  const inside = text.slice(start + 2, close);
  if (inside === '') {
    return { ok: false, reason: 'malformed', message: '${} names nothing', offset: start };
  }

  const segments = inside.split('.');
  const invalid = segments.find((segment) => !NAME.test(segment));
  if (invalid !== undefined) {
    return {
      ok: false,
      reason: 'malformed',
      message:
        invalid === ''
          ? `${written} has an empty segment`
          : `${written} is not a name: "${invalid}" must match ${NAME.source.slice(1, -1)}`,
      offset: start,
    };
  }

  return { ok: true, reference: { segments, text: written, offset: start }, next: close + 1 };
}

/** Every reference in a template, in order. A malformed template has none. */
export function referencesOf(text: string): readonly TemplateReference[] {
  const scan = scanTemplate(text);
  return scan.ok
    ? scan.parts.flatMap((part) => (part.kind === 'reference' ? [part.reference] : []))
    : [];
}

/** True when a template is a single reference and nothing else: `"${installDirectory}"`. */
export function isSoleReference(text: string): boolean {
  const scan = scanTemplate(text);
  return scan.ok && scan.parts.length === 1 && scan.parts[0]?.kind === 'reference';
}

/**
 * Renders a template. `resolve` supplies the text of each reference; it may throw to report
 * a reference it cannot resolve. The result is returned as-is — never scanned again.
 */
export function renderTemplate(
  text: string,
  resolve: (reference: TemplateReference) => string,
): string {
  const scan = scanTemplate(text);
  if (!scan.ok) {
    throw new ResolutionError('RUNE-302', scan.message);
  }

  let out = '';
  for (const part of scan.parts) {
    out += part.kind === 'literal' ? part.text : resolve(part.reference);
  }
  return out;
}
