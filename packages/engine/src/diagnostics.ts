/** Safe, single-line presentation of text that may be controlled at runtime. */

const JSON_UNESCAPED_CONTROL_CODE_POINT = /[\u007f-\u009f\u2028\u2029]/gu;

/** One raw diagnostic fragment; quoted fragments are rendered as JSON string literals. */
export type DiagnosticPart = string | { readonly quoted: string };

/** Marks an untrusted value or identifier for JSON-style quoting at presentation time. */
export function quotedDiagnostic(value: string): DiagnosticPart {
  return { quoted: value };
}

/**
 * Visibly escapes control characters while preserving ordinary unquoted wording exactly.
 */
export function escapeDiagnosticText(value: string): string {
  let escaped = '';
  for (const character of value) {
    escaped += isDiagnosticControl(character.codePointAt(0)!)
      ? visibleEscape(character)
      : character;
  }
  return escaped;
}

/** JSON-quotes text, including code points JSON permits but terminals treat as controls. */
export function quoteDiagnosticText(value: string): string {
  return JSON.stringify(value).replace(JSON_UNESCAPED_CONTROL_CODE_POINT, unicodeEscape);
}

/**
 * Renders raw fragments only after an optional masker has seen each original fragment.
 */
export function formatDiagnostic(
  parts: readonly DiagnosticPart[],
  mask: (value: string) => string = (value) => value,
): string {
  return parts
    .map((part) =>
      typeof part === 'string'
        ? escapeDiagnosticText(mask(part))
        : quoteDiagnosticText(mask(part.quoted)),
    )
    .join('');
}

function visibleEscape(value: string): string {
  const codePoint = value.codePointAt(0)!;
  return codePoint <= 0x1f ? JSON.stringify(value).slice(1, -1) : unicodeEscape(value);
}

function isDiagnosticControl(codePoint: number): boolean {
  return (
    codePoint <= 0x1f ||
    (codePoint >= 0x7f && codePoint <= 0x9f) ||
    codePoint === 0x2028 ||
    codePoint === 0x2029
  );
}

function unicodeEscape(value: string): string {
  return `\\u${value.codePointAt(0)!.toString(16).padStart(4, '0')}`;
}
