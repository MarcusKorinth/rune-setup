/**
 * `${...}` interpolation (docs/architecture.md §6.1).
 *
 * A template is scanned once into literals and references; a rendered value is never scanned
 * again. That single pass is what closes injection through input values: a value that happens
 * to contain `${...}` stays the characters the user typed (invariant 3).
 */

import { ResolutionError } from '../errors.js';

/** A `${...}` occurrence: what it names, and where it stands in the template. */
export interface TemplateReference {
  /** The dotted path inside the braces: `${env.JAVA_HOME}` → `['env', 'JAVA_HOME']`. */
  readonly segments: readonly string[];
  /** The reference as written, for messages. */
  readonly text: string;
  /** Offset of the `$` in the template. */
  readonly offset: number;
}

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

    const close = text.indexOf('}', index);
    if (close === -1) {
      return {
        ok: false,
        message:
          'unterminated ${ — a reference needs a closing brace, and a literal $ followed by a brace is written $${',
        offset: index,
      };
    }

    const inside = text.slice(index + 2, close);
    const written = text.slice(index, close + 1);
    const segments = inside.split('.');

    if (inside === '') {
      return { ok: false, message: '${} names nothing', offset: index };
    }
    const invalid = segments.find((segment) => !NAME.test(segment));
    if (invalid !== undefined) {
      return {
        ok: false,
        message:
          invalid === ''
            ? `${written} has an empty segment`
            : `${written} is not a name: "${invalid}" must match ${NAME.source.slice(1, -1)}`,
        offset: index,
      };
    }

    flush();
    parts.push({ kind: 'reference', reference: { segments, text: written, offset: index } });
    index = close + 1;
  }

  flush();
  return { ok: true, parts };
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
