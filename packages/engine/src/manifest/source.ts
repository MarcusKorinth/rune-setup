/**
 * Source positions for everything RUNE reads from disk (docs/architecture.md §4.3).
 *
 * Every message RUNE prints about a manifest, a values file or a locale overlay points at
 * `file:line:col`, so the parser records where each document path came from.
 */

/** A position in a source file. Lines and columns are 1-based, as editors count them. */
export interface Location {
  readonly file: string;
  readonly line: number;
  readonly column: number;
}

/** One step of a document path: a mapping key or a sequence index. */
export type PathSegment = string | number;

/** Renders a location the way every RUNE message does: `installer.yaml:41:7`. */
export function formatLocation(location: Location): string {
  return `${location.file}:${location.line}:${location.column}`;
}

/**
 * Renders a document path for humans: `steps[2].run.windows.args`, `inputs.installDirectory`.
 * Keys that are not plain identifiers are quoted (`inputs["odd key"]`).
 */
export function formatPath(path: readonly PathSegment[]): string {
  let out = '';
  for (const segment of path) {
    if (typeof segment === 'number') {
      out += `[${segment}]`;
    } else if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(segment)) {
      out += out === '' ? segment : `.${segment}`;
    } else {
      out += `[${JSON.stringify(segment)}]`;
    }
  }
  return out === '' ? '(root)' : out;
}

/**
 * Canonical map key for a path. JSON encoding keeps `inputs` → `a.b` distinct from
 * `inputs` → `a` → `b`, which a dotted join would silently merge.
 */
function canonical(path: readonly PathSegment[]): string {
  return JSON.stringify(path.map(String));
}

/** Where one document path was written: the key token and the value node. */
interface Entry {
  readonly key: Location | undefined;
  readonly value: Location;
}

/** Maps document paths to source positions. Built by the loader, read by error presenters. */
export class SourceMap {
  readonly #entries: ReadonlyMap<string, Entry>;

  constructor(entries: ReadonlyMap<string, Entry>) {
    this.#entries = entries;
  }

  /** Position of the value at `path`, if the document contains it. */
  location(path: readonly PathSegment[]): Location | undefined {
    return this.#entries.get(canonical(path))?.value;
  }

  /** Position of the mapping key that introduces `path`, if it has one. */
  keyLocation(path: readonly PathSegment[]): Location | undefined {
    return this.#entries.get(canonical(path))?.key;
  }

  /**
   * The most useful position for a message about `path`: its key (which is what a reader
   * looks for), else its value, else the closest ancestor that exists — so a message about
   * a *missing* key still points into the right block instead of at the top of the file.
   */
  best(path: readonly PathSegment[]): Location | undefined {
    for (let end = path.length; end >= 0; end--) {
      const entry = this.#entries.get(canonical(path.slice(0, end)));
      if (entry) {
        return entry.key ?? entry.value;
      }
    }
    return undefined;
  }
}

/** Collects entries while the loader walks a parsed document. */
export class SourceMapBuilder {
  readonly #entries = new Map<string, Entry>();

  add(path: readonly PathSegment[], value: Location, key?: Location): void {
    // First writer wins: a duplicate path can only come from a duplicate key, which the
    // loader rejects anyway, and pointing at the first occurrence is the better message.
    const id = canonical(path);
    if (!this.#entries.has(id)) {
      this.#entries.set(id, { key, value });
    }
  }

  build(): SourceMap {
    return new SourceMap(this.#entries);
  }
}
