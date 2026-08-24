/**
 * Hardened YAML loading (docs/architecture.md §4.3). Manifests, values files and locale
 * overlays all go through here: core schema only — plain YAML, no custom tags, no code
 * execution — duplicate keys rejected, UTF-8 required, size capped, and every document path
 * recorded in a {@link SourceMap} so errors can point at `file:line:col`.
 */

import { readFileSync, statSync } from 'node:fs';

import { isMap, isScalar, isSeq, LineCounter, parseDocument, type Node } from 'yaml';

import { ManifestError } from '../errors.js';
import { SourceMapBuilder, type Location, type PathSegment, type SourceMap } from './source.js';

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

/** Parses YAML text that is already in memory. */
export function loadYamlText(text: string, file: string): LoadedDocument {
  const lineCounter = new LineCounter();
  const document = parseDocument(text, {
    lineCounter,
    schema: 'core',
    customTags: [],
    uniqueKeys: true,
    merge: false,
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

  let value: unknown;
  try {
    value = document.toJS({ maxAliasCount: MAX_ALIAS_COUNT });
  } catch (cause) {
    throw new ManifestError('RUNE-101', messageOf(cause), { cause });
  }

  const builder = new SourceMapBuilder();
  const unsafeKeys: Location[] = [];
  const contents: unknown = document.contents;
  if (contents !== null && contents !== undefined) {
    walk(contents as Node, [], builder, file, lineCounter, undefined, unsafeKeys);
  }

  // A `__proto__` key cannot survive the conversion to plain data — it would set an object's
  // prototype instead of becoming a property, so the entry would silently disappear. Nothing
  // in a RUNE document may vanish without a word (invariant 12).
  if (unsafeKeys.length > 0) {
    throw ManifestError.fromIssues(
      'RUNE-101',
      unsafeKeys.map((location) => ({
        code: 'RUNE-101' as const,
        message: '__proto__ is not allowed as a key',
        location,
      })),
    );
  }

  return { file, value, sourceMap: builder.build() };
}

/** Reads and parses a YAML file. */
export function loadYamlFile(file: string, path: string = file): LoadedDocument {
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

  return loadYamlText(decodeUtf8(bytes, file), file);
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

function messageOf(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
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

/** Records the position of every mapping key, mapping value and sequence item. */
function walk(
  node: Node,
  path: readonly PathSegment[],
  builder: SourceMapBuilder,
  file: string,
  lineCounter: LineCounter,
  keyLocation: Location | undefined,
  unsafeKeys: Location[],
): void {
  const valueLocation = positionOf(node.range?.[0], file, lineCounter);
  if (valueLocation) {
    builder.add(path, valueLocation, keyLocation);
  }

  if (isMap(node)) {
    for (const pair of node.items) {
      const key: unknown = pair.key;
      if (!isScalar(key) || key.value === null || key.value === undefined) {
        continue;
      }
      const name = String(key.value);
      const childPath = [...path, name];
      const childKeyLocation = positionOf(key.range?.[0], file, lineCounter);
      if (name === '__proto__' && childKeyLocation) {
        unsafeKeys.push(childKeyLocation);
      }
      const child: unknown = pair.value;
      if (child === null || child === undefined) {
        // `key:` with no value — record the key so messages can still point at it.
        if (childKeyLocation) {
          builder.add(childPath, childKeyLocation, childKeyLocation);
        }
        continue;
      }
      walk(child as Node, childPath, builder, file, lineCounter, childKeyLocation, unsafeKeys);
    }
    return;
  }

  if (isSeq(node)) {
    node.items.forEach((item: unknown, index: number) => {
      if (item !== null && item !== undefined) {
        walk(item as Node, [...path, index], builder, file, lineCounter, undefined, unsafeKeys);
      }
    });
  }
}
