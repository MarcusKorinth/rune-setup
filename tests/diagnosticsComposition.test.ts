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
 * assertion can see the site until someone supplies exactly the value that exposes it. It is a
 * cross-package suite because the class crosses packages: R12-SEC-1 and R13-SEC-2 both lived in
 * `packages/cli/src`, which composes lines before handing them to the session projector.
 *
 * It catches, wherever in a file the line sits and however the line is written: any
 * `JSON.stringify(` — in a template substitution, in a `+` concatenation, hoisted into a local,
 * or passed straight to a helper — and any call to one of the four named escapers
 * (`escapeDiagnosticText`, `quoteDiagnosticText`, `escapeTerminalText`, `safeJson`) outside its
 * own definition, and a member name inside an import statement — but only there, so an escaper
 * passed as a bare argument on its own line is still caught. It cannot catch: an escape spread
 * over several lines; a value escaped behind a
 * *newly written* helper, since only the four names above are known; manual `"${value}"` quoting
 * inside a template (interpolate.ts and the manifest presenter quote machine identities that way
 * on dozens of lines, which would make the list noise rather than documentation); and a value
 * split, joined, trimmed, case-folded, normalized, truncated or otherwise encoded before its mask
 * (R16-SEC-3's shape — no textual signature distinguishes those from ordinary parsing).
 */

import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

/** Both packages that compose a human line: the engine masks, and the CLI renders. */
const SOURCE_ROOTS: readonly { readonly label: string; readonly directory: string }[] = [
  {
    label: 'cli',
    directory: fileURLToPath(new URL('../packages/cli/src', import.meta.url)),
  },
  {
    label: 'engine',
    directory: fileURLToPath(new URL('../packages/engine/src', import.meta.url)),
  },
];

/** A value JSON-escaped for a message — R12-SEC-1's and R16-SEC-2's shape, however spelled. */
const JSON_STRINGIFY = /JSON\.stringify\(/u;

/**
 * The named escapers, which belong after masking and inside the sink that owns them. Matched by
 * name, not by call syntax: `.map(escapeTerminalText)` escapes exactly as `escapeTerminalText(x)`
 * does.
 */
const PRESENTATION_ESCAPER =
  /\b(?:escapeDiagnosticText|quoteDiagnosticText|escapeTerminalText|safeJson)\b/u;

/** An escaper's own definition line, which is the escaper rather than a use of one. */
const ESCAPER_DEFINITION = /^(?:export )?function \w+\(/u;

/** The start of an import statement: naming an escaper there is not using it. */
const IMPORT_START = /^import\b/u;

/** What closes a multi-line import, so its members are skipped and no following line is. */
const IMPORT_END = /\bfrom\b|^\}/u;

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
    file: 'cli/cli.ts',
    code: 'outputError: (text, write) => write(escapeTerminalText(withoutFinalLf(text))),',
    why: "commander's own usage text, composed before any session or registry exists",
  },
  {
    file: 'cli/cli.ts',
    code: "return withoutFinalLf(text).split('\\n').map(escapeTerminalText).join('\\n');",
    why: "commander's own usage text, composed before any session or registry exists",
  },
  {
    file: 'cli/guiCache.ts',
    code: 'writeFileSync(sealFile, JSON.stringify({ format: 1, runeVersion: engineVersion, digest }), {',
    why: 'installation metadata contains only the built-in engine version and a runtime-tree digest, no run inputs',
  },
  {
    file: 'cli/guiCache.ts',
    code: "tree.update(JSON.stringify([relative, 'directory', executable]) + '\\n');",
    why: 'frames downloaded runtime metadata for hashing; this text is never rendered or stored',
  },
  {
    file: 'cli/guiCache.ts',
    code: "JSON.stringify([relative, 'file', size, executable, file.digest('hex')]) + '\\n',",
    why: 'frames downloaded runtime metadata for hashing; this text is never rendered or stored',
  },
  {
    file: 'cli/io.ts',
    code: 'escaped += JSON.stringify(character).slice(1, -1);',
    why: 'inside escapeTerminalText: it spells one control character, never a supplied value',
  },
  {
    file: 'cli/io.ts',
    code: 'io.stdout(escapeTerminalText(text));',
    why: 'the pre-session stdout sink; a session line goes through formatSessionTerminalLine',
  },
  {
    file: 'cli/io.ts',
    code: 'io.stderr(escapeTerminalText(text));',
    why: 'the pre-session stderr sink; a session line goes through formatSessionTerminalLine',
  },
  {
    file: 'cli/render.ts',
    code: 'value: safeJson(input.value),',
    why: 'the plan projected this field with projectStructuredString, so the mask ran first',
  },
  {
    file: 'cli/render.ts',
    code: "strings.chrome('rune.plan.argv', { value: safeJson(step.command.argv) }),",
    why: 'the plan projected this field with projectStructuredString, so the mask ran first',
  },
  {
    file: 'cli/render.ts',
    code: "strings.chrome('rune.plan.cwd', { value: safeJson(step.command.cwd) }),",
    why: 'the plan projected this field with projectStructuredString, so the mask ran first',
  },
  {
    file: 'cli/render.ts',
    code: "strings.chrome('rune.plan.env', { value: safeJson(step.command.env) }),",
    why: 'the plan projected this field with projectStructuredString, so the mask ran first',
  },
  {
    file: 'cli/render.ts',
    code: 'value: safeJson(step.command.timeoutSeconds),',
    why: 'a manifest-authored number, which no registry holds — the registry stages text only',
  },
  {
    file: 'cli/render.ts',
    code: 'value: safeJson(step.command.successExitCodes),',
    why: 'manifest-authored numbers, which no registry holds — the registry stages text only',
  },
  {
    file: 'cli/render.ts',
    code: "return JSON.stringify(value) ?? 'none';",
    why: 'inside safeJson, whose every call site above is listed; the log path uses quotedLogPath',
  },
  {
    file: 'cli/schemaCmd.ts',
    code: 'const text = JSON.stringify(schema, null, 2);',
    why: 'the generated JSON Schema document, which carries no value from any run',
  },
  {
    file: 'engine/diagnostics.ts',
    code: 'return JSON.stringify(value).replace(JSON_UNESCAPED_CONTROL_CODE_POINT, unicodeEscape);',
    why: 'inside quoteDiagnosticText: the presentation quoter the renderer calls after masking',
  },
  {
    file: 'engine/diagnostics.ts',
    code: "fragment.kind === 'quoted' ? quoteDiagnosticText(text) : escapeDiagnosticText(text);",
    why: 'the renderer itself: it escapes what the masker already returned (§10)',
  },
  {
    file: 'engine/diagnostics.ts',
    code: 'hasMaskMatch(aggregate, masker) || hasMaskMatch(JSON.stringify(aggregate).slice(1, -1), masker)',
    why: 'asks the masker whether the escaped spelling still matches; its result is a boolean',
  },
  {
    file: 'engine/diagnostics.ts',
    code: 'return codePoint <= 0x1f ? JSON.stringify(value).slice(1, -1) : unicodeEscape(value);',
    why: 'inside escapeDiagnosticText: it spells one control character, never a supplied value',
  },
  {
    file: 'engine/engine/secrets.ts',
    code: 'const jsonContent = JSON.stringify(masked).slice(1, -1);',
    why: 'projectStructuredString escapes what its mask returned, then fails closed on a match',
  },
  {
    file: 'engine/errors.ts',
    code: 'return JSON.stringify(parts);',
    why: 'an internal identity key for deduplicating issues; it reaches no sink',
  },
  {
    file: 'engine/errors.ts',
    code: '`${escapeDiagnosticText(formatLocation(projectedLocation))}: ${publicMessage}` === canonical',
    why: 'compares an already projected location against the canonical rendering; prints nothing',
  },
  {
    file: 'engine/i18n/strings.ts',
    code: 'return secrets.mask(escapeDiagnosticText(secrets.mask(line)));',
    why: 'the terminal projector, whose contract is raw mask then escape then live mask (§10)',
  },
  {
    file: 'engine/inputs/builtin.ts',
    code: "return JSON.stringify(value) ?? 'unknown';",
    why: 'names a number or boolean; registerCandidate stages text only, so no registry holds one',
  },
  {
    file: 'engine/logs/logFile.ts',
    code: 'stream.write(`${mask(escapeDiagnosticText(mask(record)))}\\n`, (cause) => {',
    why: 'the log sink, masking before the escape and once more after it (§10)',
  },
  {
    file: 'engine/manifest/source.ts',
    code: 'out += `[${JSON.stringify(segment)}]`;',
    why: 'a document key of the manifest — machine identity §10 keeps exact, never a supplied value',
  },
  {
    file: 'engine/manifest/source.ts',
    code: 'return JSON.stringify(path.map(String));',
    why: 'a canonical map key for document paths; it reaches no sink',
  },
  {
    file: 'engine/manifest/v1/present.ts',
    code: "return `${where} is required (one of: ${values.map((value) => JSON.stringify(value)).join(', ')})`;",
    why: "the zod schema's own literal alternatives, which no run supplies",
  },
  {
    file: 'engine/manifest/v1/present.ts',
    code: 'return `${where} must be ${JSON.stringify(values[0])}`;',
    why: "the zod schema's own literal alternatives, which no run supplies",
  },
  {
    file: 'engine/manifest/v1/present.ts',
    code: "return `${where} must be one of: ${values.map((value) => JSON.stringify(value)).join(', ')}`;",
    why: "the zod schema's own literal alternatives, which no run supplies",
  },
  {
    file: 'engine/manifest/v1/rules.ts',
    code: 'const cacheKey = JSON.stringify([reference.text, visibleInputCount, owner]);',
    why: 'a resolver cache key over manifest text; it reaches no sink',
  },
  {
    file: 'engine/results/writer.ts',
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
  let insideImport = false;
  text.split(/\r?\n/u).forEach((code, index) => {
    const trimmed = code.trim();
    // The member-name skip belongs to import blocks alone. Outside one, a line that is just
    // `escapeTerminalText,` is an argument to a call and escapes for real.
    if (insideImport || IMPORT_START.test(trimmed)) {
      insideImport = !IMPORT_END.test(trimmed);
      return;
    }
    if (trimmed.startsWith('*') || trimmed.startsWith('//') || ESCAPER_DEFINITION.test(trimmed)) {
      return;
    }
    if (JSON_STRINGIFY.test(trimmed) || PRESENTATION_ESCAPER.test(trimmed)) {
      sites.push({ file, line: index + 1, code: trimmed });
    }
  });
  return sites;
}

function collectSites(): readonly Site[] {
  return SOURCE_ROOTS.flatMap(({ label, directory }) =>
    sourceFiles(directory).flatMap((path) =>
      escapingSites(
        `${label}/${relative(directory, path).replaceAll('\\', '/')}`,
        readFileSync(path, 'utf8'),
      ),
    ),
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

  it('flags every spelling of the compositions that caused the defect', () => {
    const offending = [
      'throw new UsageError(`invalid locale ${JSON.stringify(raw)} from ${source}`);',
      'const shown = JSON.stringify(raw);',
      "throw new UsageError('invalid locale ' + JSON.stringify(raw) + ' from ' + source);",
      "return fail(JSON.stringify(value), ' is not one of the option values');",
      "return JSON.stringify(value) ?? 'unknown';",
      'return escapeDiagnosticText(`${id} rejected ${value}`);',
      'logFile: safeJson(plan.executionOptions.logFile),',
    ].join('\n');

    expect(escapingSites('scratch.ts', offending)).toHaveLength(7);
  });

  it('accepts the compositions that replaced them', () => {
    const composed = [
      "const parts = ['invalid locale ', quotedDiagnostic(raw), ` from ${source}`];",
      'return formatDiagnostic(parts, secrets);',
      'logFile: quotedLogPath(spelled.logFile),',
    ].join('\n');

    expect(escapingSites('scratch.ts', composed)).toEqual([]);
  });

  it('catches an escaper passed as a bare argument on its own line', () => {
    // This reads identically to one member of a multi-line import, and it escapes every
    // element before any mask can see it, so the skip must not reach it.
    const spread = `import { escapeTerminalText } from './io.js';
const rendered = lines.map(
  escapeTerminalText,
);`;

    expect(escapingSites('scratch.ts', spread).map((site) => site.code)).toEqual([
      'escapeTerminalText,',
    ]);
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

  it('reads both packages, so a CLI-side escape cannot hide from it', () => {
    const labels = new Set(collectSites().map((site) => site.file.split('/')[0]));

    expect([...labels].sort()).toEqual(['cli', 'engine']);
  });
});
