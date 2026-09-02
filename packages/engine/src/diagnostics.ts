/** Safe, single-line presentation of text that may be controlled at runtime. */

const JSON_UNESCAPED_CONTROL_CODE_POINT = /[\u007f-\u009f\u2028\u2029]/gu;

/** One raw diagnostic fragment; quoted fragments are rendered as JSON string literals. */
export type DiagnosticPart = string | { readonly quoted: string };

/** Internal mask capability that preserves fragment provenance across whole-record matches. */
export interface DiagnosticMasker {
  mask(text: string): string;
  maskFragments(fragments: readonly string[]): readonly {
    readonly text: string;
    readonly sourceIndices: readonly number[];
    readonly replacement: boolean;
  }[];
  safeFallbackMarker(): string;
}

const IDENTITY_MASKER: DiagnosticMasker = {
  mask: (text) => text,
  maskFragments: (fragments) =>
    fragments.map((text, sourceIndex) => ({
      text,
      sourceIndices: [sourceIndex],
      replacement: false,
    })),
  safeFallbackMarker: () => String.fromCodePoint(0x10000),
};

interface RenderFragment {
  readonly text: string;
  readonly kind: 'plain' | 'quoted' | 'quote' | 'separator';
  readonly recordIndex: number;
  readonly quoteOwner?: number;
}

export interface DiagnosticRecordProjection {
  readonly records: readonly string[];
  readonly failClosed: boolean;
}

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

/** Renders one safe diagnostic after masking its complete raw logical composition. */
export function formatDiagnostic(
  parts: readonly DiagnosticPart[],
  masker: DiagnosticMasker = IDENTITY_MASKER,
): string {
  return formatDiagnosticRecordList([parts], masker)[0]!;
}

/** Renders issue-like records with physical formatter-owned LF separators. */
export function formatDiagnosticRecords(
  records: readonly (readonly DiagnosticPart[])[],
  masker: DiagnosticMasker = IDENTITY_MASKER,
): string {
  return formatDiagnosticRecordList(records, masker).join('\n');
}

/** Internal record projection; formatter-owned separators are never part of rendered records. */
export function formatDiagnosticRecordList(
  records: readonly (readonly DiagnosticPart[])[],
  masker: DiagnosticMasker = IDENTITY_MASKER,
): readonly string[] {
  return projectDiagnosticRecordList(records, masker).records;
}

/** Internal record projection with explicit metadata for stack topology decisions. */
export function projectDiagnosticRecordList(
  records: readonly (readonly DiagnosticPart[])[],
  masker: DiagnosticMasker = IDENTITY_MASKER,
): DiagnosticRecordProjection {
  const fragments: RenderFragment[] = [];
  for (const [recordIndex, record] of records.entries()) {
    if (recordIndex > 0) {
      fragments.push({
        text: '\n',
        kind: 'separator',
        recordIndex: recordIndex - 1,
      });
    }
    for (const part of record) {
      if (typeof part === 'string') {
        fragments.push({
          text: part,
          kind: 'plain',
          recordIndex,
        });
      } else {
        const contentIndex = fragments.length + 1;
        fragments.push(
          { text: '"', kind: 'quote', quoteOwner: contentIndex, recordIndex },
          { text: part.quoted, kind: 'quoted', recordIndex },
          { text: '"', kind: 'quote', quoteOwner: contentIndex, recordIndex },
        );
      }
    }
  }

  const projected = fragments.map((): string[] => []);
  for (const run of masker.maskFragments(fragments.map((fragment) => fragment.text))) {
    if (run.replacement) {
      const targets = new Set<number>();
      for (const sourceIndex of run.sourceIndices) {
        const source = fragments[sourceIndex];
        if (source === undefined || source.kind === 'separator') {
          continue;
        }
        targets.add(source.quoteOwner ?? sourceIndex);
      }
      const target = [...targets].sort((left, right) => left - right)[0];
      if (target !== undefined) {
        projected[target]!.push(run.text);
      }
      continue;
    }
    const sourceIndex = run.sourceIndices[0]!;
    const source = fragments[sourceIndex];
    if (source?.kind === 'plain' || source?.kind === 'quoted') {
      projected[sourceIndex]!.push(run.text);
    }
  }

  const rendered = records.map(() => '');
  for (const [index, fragment] of fragments.entries()) {
    if (fragment.kind === 'separator' || fragment.kind === 'quote') {
      continue;
    }
    const text = projected[index]!.join('');
    rendered[fragment.recordIndex] +=
      fragment.kind === 'quoted' ? quoteDiagnosticText(text) : escapeDiagnosticText(text);
  }
  const finalized = finalizeRenderedDiagnosticRecords(rendered, masker);
  if (finalized.records.length !== records.length) {
    throw new Error('diagnostic projection changed record cardinality');
  }
  return finalized;
}

/** Validates already-rendered records without changing their structural quotes or separators. */
export function finalizeRenderedDiagnosticRecords(
  records: readonly string[],
  masker: DiagnosticMasker,
): DiagnosticRecordProjection {
  if (!hasRenderedRecordMatch(records, masker)) return { records, failClosed: false };

  for (const marker of ['***', '']) {
    const fallback = records.map((_, index) => (index === 0 ? marker : ''));
    if (!hasRenderedRecordMatch(fallback, masker)) {
      return { records: fallback, failClosed: true };
    }
  }

  const repeatedMarker = records.map(() => '***');
  if (!hasRenderedRecordMatch(repeatedMarker, masker)) {
    return { records: repeatedMarker, failClosed: true };
  }

  const marker = masker.safeFallbackMarker();
  const fallback = records.map(() => marker);
  if (!hasRenderedRecordMatch(fallback, masker)) {
    return { records: fallback, failClosed: true };
  }
  throw new Error('diagnostic masking could not produce a stable fallback');
}

function hasRenderedRecordMatch(records: readonly string[], masker: DiagnosticMasker): boolean {
  const aggregate = records.join('\n');
  return (
    hasMaskMatch(aggregate, masker) || hasMaskMatch(JSON.stringify(aggregate).slice(1, -1), masker)
  );
}

function hasMaskMatch(text: string, masker: DiagnosticMasker): boolean {
  return masker.maskFragments([text]).some((run) => run.replacement);
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
