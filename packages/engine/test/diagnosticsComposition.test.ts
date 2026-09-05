/**
 * The escape-before-mask guard (docs/architecture.md §10, "Path spellings" and "Value
 * spellings").
 *
 * A diagnostic must hand its masker the bytes its supplier wrote. Whenever a message template
 * escapes, quotes, or otherwise re-spells a runtime value before composition, every mask that
 * follows meets a spelling no registry ever held, and a declared secret prints in the clear —
 * the defect found ten times in rounds 12 and 13 and twice more in round 16. Composing from
 * diagnostic parts instead (`quotedDiagnostic`, then quoting at presentation) keeps the raw
 * value reachable by the mask, so this suite fails a source line that escapes first.
 *
 * It reads sources as text on purpose: the defect is a composition habit, and no runtime
 * assertion can see the site until someone supplies exactly the value that exposes it.
 */

import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const SOURCE_ROOT = fileURLToPath(new URL('../src', import.meta.url));

/** A value JSON-escaped inside a message template — the shape of R12-SEC-1 and R16-SEC-2. */
const INTERPOLATED_JSON_STRINGIFY = /\$\{[^}]*JSON\.stringify\(/u;

/** The presentation-time escapers, which belong after masking and inside the renderer. */
const PRESENTATION_ESCAPER = /\b(?:escapeDiagnosticText|quoteDiagnosticText)\(/u;

interface Site {
  readonly file: string;
  readonly line: number;
  readonly code: string;
}

/**
 * Sites that escape on purpose, each with the reason it cannot disclose a declared secret.
 * A line that is not listed here fails the suite; changing a listed line fails it too, so the
 * reason is re-read rather than inherited.
 */
const ALLOWED: readonly { readonly file: string; readonly code: string; readonly why: string }[] = [
  {
    file: 'diagnostics.ts',
    code: "fragment.kind === 'quoted' ? quoteDiagnosticText(text) : escapeDiagnosticText(text);",
    why: 'the renderer itself: it escapes what the masker already returned (§10)',
  },
  {
    file: 'errors.ts',
    code: '`${escapeDiagnosticText(formatLocation(projectedLocation))}: ${publicMessage}` === canonical',
    why: 'compares an already projected location against the canonical rendering; prints nothing',
  },
  {
    file: 'i18n/strings.ts',
    code: 'return secrets.mask(escapeDiagnosticText(secrets.mask(line)));',
    why: 'the terminal projector, whose contract is raw mask then escape then live mask (§10)',
  },
  {
    file: 'logs/logFile.ts',
    code: 'stream.write(`${mask(escapeDiagnosticText(mask(record)))}\\n`, (cause) => {',
    why: 'the log sink, masking before the escape and once more after it (§10)',
  },
  {
    file: 'manifest/source.ts',
    code: 'out += `[${JSON.stringify(segment)}]`;',
    why: 'a document key of the manifest — machine identity §10 keeps exact, never a supplied value',
  },
  {
    file: 'manifest/v1/present.ts',
    code: "return `${where} is required (one of: ${values.map((value) => JSON.stringify(value)).join(', ')})`;",
    why: "the zod schema's own literal alternatives, which no run supplies",
  },
  {
    file: 'manifest/v1/present.ts',
    code: 'return `${where} must be ${JSON.stringify(values[0])}`;',
    why: "the zod schema's own literal alternatives, which no run supplies",
  },
  {
    file: 'manifest/v1/present.ts',
    code: "return `${where} must be one of: ${values.map((value) => JSON.stringify(value)).join(', ')}`;",
    why: "the zod schema's own literal alternatives, which no run supplies",
  },
  {
    file: 'results/writer.ts',
    code: 'return `${JSON.stringify(parsed.data, null, 2)}\\n`;',
    why: 'the result document, whose every dynamic field the engine projected field by field (§10)',
  },
];

function sourceFiles(directory: string): readonly string[] {
  const found: string[] = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      found.push(...sourceFiles(path));
    } else if (entry.name.endsWith('.ts')) {
      found.push(path);
    }
  }
  return found.sort();
}

/** Every line of one file that escapes a value where a masker has not run yet. */
function escapingSites(file: string, text: string): readonly Site[] {
  const sites: Site[] = [];
  text.split(/\r?\n/u).forEach((code, index) => {
    const trimmed = code.trim();
    if (trimmed.startsWith('*') || trimmed.startsWith('//')) {
      return;
    }
    const escapesInPlace =
      INTERPOLATED_JSON_STRINGIFY.test(trimmed) ||
      (PRESENTATION_ESCAPER.test(trimmed) && !trimmed.startsWith('export function'));
    if (escapesInPlace) {
      sites.push({ file, line: index + 1, code: trimmed });
    }
  });
  return sites;
}

function collectSites(): readonly Site[] {
  return sourceFiles(SOURCE_ROOT).flatMap((path) =>
    escapingSites(relative(SOURCE_ROOT, path).replaceAll('\\', '/'), readFileSync(path, 'utf8')),
  );
}

describe('diagnostic composition', () => {
  it('escapes a value only where a masker has already seen it', () => {
    const unexplained = collectSites().filter(
      (site) =>
        !ALLOWED.some((allowed) => allowed.file === site.file && allowed.code === site.code),
    );

    // A new entry belongs in ALLOWED only when the value cannot be a declared secret. The fix
    // is otherwise to carry the value as a raw diagnostic part — `quotedDiagnostic(value)` —
    // so the masker meets the supplier's bytes and the sink quotes what survives.
    expect(unexplained.map((site) => `${site.file}:${site.line}: ${site.code}`)).toEqual([]);
  });

  it('flags the composition that caused the defect and accepts the fix', () => {
    const offending = [
      'throw new UsageError(`invalid locale ${JSON.stringify(raw)} from ${source}`);',
      'return escapeDiagnosticText(`${id} rejected ${value}`);',
    ].join('\n');
    const composed = [
      "const parts = ['invalid locale ', quotedDiagnostic(raw), ` from ${source}`];",
      'return formatDiagnostic(parts, secrets);',
    ].join('\n');

    expect(escapingSites('scratch.ts', offending)).toHaveLength(2);
    expect(escapingSites('scratch.ts', composed)).toEqual([]);
  });

  it('keeps every allowed entry pinned to a line that still exists', () => {
    const sites = collectSites();

    expect(
      ALLOWED.filter(
        (allowed) =>
          !sites.some((site) => site.file === allowed.file && site.code === allowed.code),
      ),
    ).toEqual([]);
    expect(ALLOWED.every((allowed) => allowed.why.length > 0)).toBe(true);
  });
});
