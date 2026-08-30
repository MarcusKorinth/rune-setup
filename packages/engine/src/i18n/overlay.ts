/**
 * Locale overlay files (docs/architecture.md §6.3).
 *
 * An overlay is a flat mapping of key path → string, loaded with the same hardened YAML
 * loader as the manifest. Keys are validated against what actually exists: the manifest's
 * localizable paths plus the built-in chrome catalogue — an unknown key is a located
 * validation error, never a silent no-op.
 */

import { ManifestError, type RuneIssue } from '../errors.js';
import { loadYamlFile, loadYamlText, type LoadedDocument } from '../manifest/loader.js';
import { startOfFile } from '../manifest/source.js';
import { optionValue, type ManifestV1 } from '../manifest/v1/schema.js';
import { CHROME_CATALOG } from './catalog.js';

export interface LocaleOverlay {
  /** The tag the file serves, taken from its name (`locales/de.yaml` → `de`). */
  readonly locale: string;
  readonly file: string;
  readonly entries: Readonly<Record<string, string>>;
}

/** Reads and validates one overlay file against the manifest it accompanies. */
export function loadOverlay(path: string, locale: string, manifest: ManifestV1): LocaleOverlay {
  return fromDocument(loadYamlFile(path), locale, manifest);
}

/** Same as {@link loadOverlay} for text already in memory — the test seam. */
export function loadOverlayText(
  text: string,
  file: string,
  locale: string,
  manifest: ManifestV1,
): LocaleOverlay {
  return fromDocument(loadYamlText(text, file), locale, manifest);
}

function fromDocument(
  document: LoadedDocument,
  locale: string,
  manifest: ManifestV1,
): LocaleOverlay {
  const { file, value, isEmpty, sourceMap } = document;
  const rootLocation = sourceMap.location([]);
  if (isEmpty) {
    return Object.freeze({ locale, file, entries: Object.freeze({}) });
  }
  if (value === null || value === undefined || typeof value !== 'object' || Array.isArray(value)) {
    throw new ManifestError('RUNE-104', 'a locale overlay must be a mapping of key to text', {
      location: rootLocation ?? startOfFile(file),
    });
  }

  const known = localizableKeys(manifest);
  const issues: RuneIssue[] = [];
  const entries = new Map<string, string>();

  for (const [key, text] of Object.entries(value)) {
    const location = sourceMap.best([key]) ?? startOfFile(file);
    if (!known.has(key) && !Object.hasOwn(CHROME_CATALOG, key)) {
      issues.push({
        code: 'RUNE-104',
        message: keyProblem(key),
        location,
      });
      continue;
    }
    if (typeof text !== 'string') {
      issues.push({ code: 'RUNE-104', message: `${key} must be a string`, location });
      continue;
    }
    entries.set(key, text);
  }

  if (issues.length > 0) {
    throw ManifestError.fromIssues('RUNE-104', issues);
  }
  return Object.freeze({
    locale,
    file,
    entries: Object.freeze(Object.fromEntries(entries)),
  });
}

function keyProblem(key: string): string {
  if (key.startsWith('rune.')) {
    return `${key} is not in RUNE's chrome catalogue`;
  }
  return `${key} does not name a localizable text of this manifest`;
}

/**
 * The localizable paths of one manifest, exhaustively (§6.3). Titles and option labels are
 * localizable for every declared id — they always display, defaulting from the id or value —
 * while descriptions, pattern hints, and the window title exist only where the manifest
 * wrote text to fall back to.
 */
export function localizableKeys(manifest: ManifestV1): ReadonlySet<string> {
  const keys = new Set<string>();
  if (manifest.product.description !== undefined) {
    keys.add('product.description');
  }
  if (manifest.gui?.windowTitle !== undefined) {
    keys.add('gui.windowTitle');
  }
  for (const [id, spec] of Object.entries(manifest.inputs)) {
    keys.add(`inputs.${id}.title`);
    if (spec.description !== undefined) {
      keys.add(`inputs.${id}.description`);
    }
    if (spec.type === 'text' && spec.patternHint !== undefined) {
      keys.add(`inputs.${id}.patternHint`);
    }
    if (spec.type === 'select' || spec.type === 'multiselect') {
      for (const option of spec.options) {
        keys.add(`inputs.${id}.options.${optionValue(option)}.label`);
      }
    }
  }
  for (const step of manifest.steps) {
    keys.add(`steps.${step.id}.title`);
  }
  return keys;
}
