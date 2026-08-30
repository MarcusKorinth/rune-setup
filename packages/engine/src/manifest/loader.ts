/**
 * Hardened YAML loading (docs/architecture.md §4.3). Manifests, values files and locale
 * overlays all go through here: core schema only — plain YAML, no custom tags, no code
 * execution — duplicate keys rejected, UTF-8 required, size capped, and every document path
 * recorded in a {@link SourceMap} so errors can point at `file:line:col`.
 */

import { createHash } from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';

import { isMap, isNode, isScalar, isSeq, LineCounter, parseDocument, type Node } from 'yaml';

import { ManifestError, messageOf, type RuneIssue } from '../errors.js';
import {
  formatLocation,
  SourceMapBuilder,
  startOfFile,
  type Location,
  type PathSegment,
  type SourceMap,
} from './source.js';

/** Refuse absurd inputs long before the parser sees them. */
export const MAX_DOCUMENT_BYTES = 5 * 1024 * 1024;

/**
 * Cap on alias expansion. YAML aliases can blow a small document up exponentially
 * ("billion laughs"); the `yaml` package guards this and RUNE states the bound explicitly.
 */
const MAX_ALIAS_COUNT = 100;

export interface LoadedDocument {
  /** The file name as the caller supplied it — messages echo it verbatim. */
  readonly file: string;
  /** The document as plain JavaScript data. `null` for an empty document. */
  readonly value: unknown;
  readonly sourceMap: SourceMap;
}

export interface LoadedFileWithMetadata extends LoadedDocument {
  /** SHA-256 of the exact file bytes that produced `value`. */
  readonly sha256: string;
}

/** Parses YAML text that is already in memory. */
export function loadYamlText(text: string, file: string): LoadedDocument {
  const lineCounter = new LineCounter();
  const document = parseDocument(text, {
    lineCounter,
    schema: 'core',
    customTags: [],
    // The parser's own duplicate-key check scans every key of a mapping for every new key,
    // which is quadratic: a one-megabyte flat mapping takes tens of seconds and the size cap
    // would not bound it. Duplicates are detected in the walk below instead, in one pass.
    uniqueKeys: false,
    merge: false,
    // Without this, explicitly tagged YAML 1.1 types (`!!binary`, `!!timestamp`, `!!merge`,
    // `!!omap`, `!!pairs`, `!!set`) still resolve — to a Buffer, a Date, a merged mapping —
    // even under the core schema. Leaving them unresolved turns them into warnings, which
    // this loader treats as errors: RUNE reads plain YAML and nothing else.
    resolveKnownTags: false,
    version: '1.2',
  });

  // Warnings are errors here: with the core schema the only thing they report is a tag RUNE
  // does not implement, and silently reading such a value as a plain string would hide it.
  const problems = [...document.errors, ...document.warnings];
  if (problems.length > 0) {
    throw ManifestError.fromIssues(
      'RUNE-101',
      problems.map((error) => ({
        code: 'RUNE-101' as const,
        message: error.message.replace(/\s+at line \d+, column \d+:?[\s\S]*$/, ''),
        location: positionOf(error.pos[0], file, lineCounter),
      })),
    );
  }

  // The keys are checked before the document is converted: a key RUNE refuses must not be
  // turned into data first — that is where the parser would stringify it, silently, and warn
  // about it on a channel RUNE does not own.
  const builder = new SourceMapBuilder();
  const keyProblems: RuneIssue[] = [];
  const contents: unknown = document.contents;
  if (contents !== null && contents !== undefined) {
    walk(contents as Node, [], builder, file, lineCounter, undefined, keyProblems);
  }

  if (keyProblems.length > 0) {
    throw ManifestError.fromIssues('RUNE-101', keyProblems);
  }

  let value: unknown;
  try {
    value = document.toJS({ maxAliasCount: MAX_ALIAS_COUNT });
  } catch (cause) {
    // Mostly the alias-expansion cap. The location names the file; the message must not name
    // it a second time, or every renderer prints the document twice.
    throw new ManifestError('RUNE-101', messageOf(cause), { cause, location: startOfFile(file) });
  }

  return { file, value, sourceMap: builder.build() };
}

/** Reads and parses a YAML file. */
export function loadYamlFile(file: string, path: string = file): LoadedDocument {
  return loadYamlFileSnapshot(file, path).document;
}

/** Reads once and adds byte identity for manifest sessions. Package-internal, not root API. */
export function loadYamlFileWithMetadata(
  file: string,
  path: string = file,
): LoadedFileWithMetadata {
  const snapshot = loadYamlFileSnapshot(file, path);
  return {
    ...snapshot.document,
    sha256: createHash('sha256').update(snapshot.bytes).digest('hex'),
  };
}

function loadYamlFileSnapshot(
  file: string,
  path: string,
): { readonly bytes: Buffer; readonly document: LoadedDocument } {
  let bytes: Buffer;
  try {
    const stats = statSync(path);
    if (!stats.isFile()) {
      throw new ManifestError('RUNE-101', `${file} is not a file`);
    }
    if (stats.size > MAX_DOCUMENT_BYTES) {
      throw new ManifestError(
        'RUNE-101',
        `${file} is larger than the ${Math.round(MAX_DOCUMENT_BYTES / 1024 / 1024)} MiB limit`,
      );
    }
    bytes = readFileSync(path);
  } catch (cause) {
    if (cause instanceof ManifestError) {
      throw cause;
    }
    throw new ManifestError('RUNE-101', `${file} cannot be read: ${messageOf(cause)}`, { cause });
  }

  return { bytes, document: loadYamlText(decodeUtf8(bytes, file), file) };
}

/**
 * Decodes strictly: Node's default decoding replaces invalid bytes with U+FFFD, which would
 * turn a mis-encoded manifest into a confusing schema error instead of an honest one.
 */
function decodeUtf8(bytes: Buffer, file: string): string {
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch (cause) {
    throw new ManifestError('RUNE-101', `${file} is not valid UTF-8`, { cause });
  }
  // A byte-order mark is legal in UTF-8 but not part of the document.
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

function positionOf(
  offset: number | undefined,
  file: string,
  lineCounter: LineCounter,
): Location | undefined {
  if (offset === undefined) {
    return undefined;
  }
  const { line, col } = lineCounter.linePos(offset);
  return { file, line, column: col };
}

/**
 * Records the position of every mapping key, mapping value and sequence item, and reports the
 * kinds of key that must never reach the data: duplicates (the second would silently replace
 * the first), keys that are not plain non-empty scalars (which the parser folds together into
 * one stringified entry) and `__proto__` (which would set an object's prototype instead of
 * becoming a property, so the entry would vanish). Nothing may disappear without a word.
 */
function walk(
  node: Node,
  path: readonly PathSegment[],
  builder: SourceMapBuilder,
  file: string,
  lineCounter: LineCounter,
  keyLocation: Location | undefined,
  keyProblems: RuneIssue[],
): void {
  const valueLocation = positionOf(node.range?.[0], file, lineCounter);
  if (valueLocation) {
    builder.add(path, valueLocation, keyLocation);
  }

  if (isMap(node)) {
    const seen = new Map<string, Location | undefined>();

    for (const pair of node.items) {
      const key: unknown = pair.key;
      const childKeyLocation = positionOf(
        isNode(key) ? key.range?.[0] : undefined,
        file,
        lineCounter,
      );

      // Only a plain, non-empty scalar survives as itself. A collection key is stringified by
      // the parser (`[ a, b ]`) and an empty or null key becomes the empty string, so two of
      // either collapse into one entry — the silent disappearance the duplicate check below
      // exists to prevent, and one this walk could not see.
      if (!isScalar(key)) {
        keyProblems.push({
          code: 'RUNE-101',
          message: 'a mapping key must be a plain scalar',
          location: childKeyLocation,
        });
        continue;
      }
      if (key.value === null || key.value === undefined) {
        keyProblems.push({
          code: 'RUNE-101',
          message: 'a mapping key must not be empty',
          location: childKeyLocation,
        });
        continue;
      }

      const name = String(key.value);
      const childPath = [...path, name];

      if (name === '__proto__') {
        keyProblems.push({
          code: 'RUNE-101',
          message: '__proto__ is not allowed as a key',
          location: childKeyLocation,
        });
        continue;
      }

      if (seen.has(name)) {
        const first = seen.get(name);
        keyProblems.push({
          code: 'RUNE-101',
          message: `duplicate key "${name}"${first ? ` — first defined at ${formatLocation(first)}` : ''}`,
          location: childKeyLocation,
        });
        continue;
      }
      seen.set(name, childKeyLocation);

      const child: unknown = pair.value;
      if (child === null || child === undefined) {
        // `key:` with no value — record the key so messages can still point at it.
        if (childKeyLocation) {
          builder.add(childPath, childKeyLocation, childKeyLocation);
        }
        continue;
      }
      walk(child as Node, childPath, builder, file, lineCounter, childKeyLocation, keyProblems);
    }
    return;
  }

  if (isSeq(node)) {
    node.items.forEach((item: unknown, index: number) => {
      if (item !== null && item !== undefined) {
        walk(item as Node, [...path, index], builder, file, lineCounter, undefined, keyProblems);
      }
    });
  }
}
