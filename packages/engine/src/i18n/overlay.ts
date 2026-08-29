/**
 * Locale overlay files (docs/architecture.md §6.3).
 *
 * An overlay is a flat mapping of key path → string, loaded with the same hardened YAML
 * loader as the manifest. Keys are validated against what actually exists: the manifest's
 * localizable paths plus the built-in chrome catalogue — an unknown key is a located
 * validation error, never a silent no-op.
 */

import { ManifestError, orderIssues, type RuneIssue } from '../errors.js';
import { loadYamlFile, loadYamlText } from '../manifest/loader.js';
import { startOfFile, type SourceMap } from '../manifest/source.js';
import { optionValue, type ManifestV1 } from '../manifest/v1/schema.js';
import { CHROME_CATALOG, normalizeSummaryChoice, SUMMARY_ACTIONS } from './catalog.js';

export interface LocaleOverlay {
  /** The tag the file serves, taken from its name (`locales/de.yaml` → `de`). */
  readonly locale: string;
  readonly file: string;
  readonly entries: ReadonlyMap<string, string>;
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
  document: { readonly file: string; readonly value: unknown; readonly sourceMap: SourceMap },
  locale: string,
  manifest: ManifestV1,
): LocaleOverlay {
  const { file, value, sourceMap } = document;
  if (value === null || value === undefined) {
    return { locale, file, entries: new Map() };
  }
  if (typeof value !== 'object' || Array.isArray(value)) {
    throw new ManifestError('RUNE-104', 'a locale overlay must be a mapping of key to text', {
      location: startOfFile(file),
    });
  }

  const known = localizableKeys(manifest);
  const issues: RuneIssue[] = [];
  const entries = new Map<string, string>();

  for (const [key, text] of Object.entries(value)) {
    const location = sourceMap.best([key]) ?? startOfFile(file);
    if (!known.has(key) && !CHROME_CATALOG.has(key)) {
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

  issues.push(...summaryTokenIssues(entries, sourceMap, file));

  if (issues.length > 0) {
    throw ManifestError.fromIssues('RUNE-104', orderIssues(issues));
  }
  return { locale, file, entries };
}

function summaryTokenIssues(
  entries: ReadonlyMap<string, string>,
  sourceMap: SourceMap,
  file: string,
): RuneIssue[] {
  const proceed = {
    ...SUMMARY_ACTIONS.proceed,
    value: normalizeSummaryChoice(
      entries.get(SUMMARY_ACTIONS.proceed.tokenKey) ?? SUMMARY_ACTIONS.proceed.defaultToken,
    ),
    oppositeAlias: SUMMARY_ACTIONS.cancel.alias,
  };
  const cancel = {
    ...SUMMARY_ACTIONS.cancel,
    value: normalizeSummaryChoice(
      entries.get(SUMMARY_ACTIONS.cancel.tokenKey) ?? SUMMARY_ACTIONS.cancel.defaultToken,
    ),
    oppositeAlias: SUMMARY_ACTIONS.proceed.alias,
  };
  const issues: RuneIssue[] = [];
  const proceedProblem = summaryTokenProblem(
    proceed.tokenKey,
    proceed.value,
    proceed.oppositeAlias,
  );
  const cancelProblem = summaryTokenProblem(cancel.tokenKey, cancel.value, cancel.oppositeAlias);

  for (const [token, message] of [
    [proceed, proceedProblem],
    [cancel, cancelProblem],
  ] as const) {
    if (entries.has(token.tokenKey) && message !== undefined) {
      issues.push(summaryTokenIssue(token.tokenKey, message, sourceMap, file));
    }
  }

  if (
    proceedProblem === undefined &&
    cancelProblem === undefined &&
    proceed.value === cancel.value
  ) {
    // A partial overlay is compared with the safe English default. When both keys are
    // overridden, the later key is what introduces the conflict.
    const key =
      [...entries.keys()].findLast(
        (candidate) => candidate === proceed.tokenKey || candidate === cancel.tokenKey,
      ) ?? proceed.tokenKey;
    const other =
      key === proceed.tokenKey ? SUMMARY_ACTIONS.cancel.tokenKey : SUMMARY_ACTIONS.proceed.tokenKey;
    issues.push(
      summaryTokenIssue(
        key,
        `${key} must differ from ${other} after trimming and case normalization`,
        sourceMap,
        file,
      ),
    );
  }

  return issues;
}

function summaryTokenProblem(
  key: string,
  token: string,
  oppositeAlias: string,
): string | undefined {
  if (token.length === 0) {
    return `${key} must not be empty or whitespace`;
  }
  if (/^[0-9]+$/u.test(token)) {
    return `${key} must not be numeric because a number selects a value to change`;
  }
  if (token === oppositeAlias) {
    return `${key} must not be "${oppositeAlias}" because it is the fixed alias for the ${oppositeAlias} action`;
  }
  return undefined;
}

function summaryTokenIssue(
  key: string,
  message: string,
  sourceMap: SourceMap,
  file: string,
): RuneIssue {
  return {
    code: 'RUNE-104',
    message,
    location: sourceMap.best([key]) ?? startOfFile(file),
  };
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
