/**
 * The resolved string table (docs/architecture.md §6.3).
 *
 * One table per session: every localizable manifest text and every chrome string, already
 * resolved for the session's locale with per-key fallback — overlay text where the overlay
 * has the key, the manifest's own text or the English built-in otherwise. Frontends render
 * this table and never resolve text themselves.
 */

import { InternalError } from '../errors.js';
import { manifestDescriptorFor } from '../manifest/index.js';
import { optionLabel, optionValue, type ManifestV1 } from '../manifest/v1/schema.js';
import { CHROME_CATALOG, formatChrome, type ChromeKey } from './catalog.js';
import { matchOverlay } from './locale.js';
import { overlayManifestFor, type LocaleOverlay } from './overlay.js';

export interface StringTable {
  /** The session's selected locale; `undefined` means the built-in defaults and serializes as `null` (§6.3). */
  readonly locale: string | undefined;
  /** The overlay file that served it — `de` may serve a selected `de-DE`. */
  readonly overlayLocale: string | undefined;
  /** Every resolved key → text — what `getStrings()` hands a frontend, whole (§6.3, §9.1). */
  readonly entries: Readonly<Record<string, string>>;
  /** A chrome string, `{placeholders}` filled; the catalogue guarantees the key exists. */
  readonly chrome: (key: ChromeKey, values?: Readonly<Record<string, string | number>>) => string;
  readonly inputTitle: (id: string) => string;
  readonly inputDescription: (id: string) => string | undefined;
  readonly patternHint: (id: string) => string | undefined;
  readonly optionLabel: (inputId: string, value: string) => string;
  readonly stepTitle: (id: string) => string;
  readonly productDescription: () => string | undefined;
  readonly windowTitle: () => string | undefined;
}

export interface ResolveStringsOptions {
  readonly manifest: ManifestV1;
  /** The selected locale tag; `undefined` means the built-in defaults. */
  readonly locale: string | undefined;
  /** The overlay serving the session's locale; none means defaults only. */
  readonly overlay?: LocaleOverlay | undefined;
}

export interface StringTableContext {
  readonly manifest: ManifestV1;
  readonly locale: string | undefined;
}

const stringTableContexts = new WeakMap<StringTable, StringTableContext>();

/** Internal fail-closed lookup: structural table copies have no resolution provenance. */
export function stringTableContextFor(table: StringTable): StringTableContext {
  const context = stringTableContexts.get(table);
  if (context === undefined) {
    throw new InternalError('the string table was not created by resolveStrings');
  }
  return context;
}

/** Builds the one string table of a session. */
export function resolveStrings(options: ResolveStringsOptions): StringTable {
  const { manifest, overlay } = options;
  manifestDescriptorFor(manifest);
  if (overlay !== undefined) {
    if (overlayManifestFor(overlay) !== manifest) {
      throw new InternalError('the locale overlay belongs to a different manifest');
    }
    const candidate = { locale: overlay.locale, path: overlay.file };
    if (options.locale === undefined || matchOverlay(options.locale, [candidate]) === undefined) {
      const selected =
        options.locale === undefined
          ? 'the built-in defaults'
          : `selected locale "${options.locale}"`;
      throw new InternalError(`locale overlay "${overlay.locale}" cannot serve ${selected}`);
    }
  }
  const entries = new Map<string, string>();

  // Layer 1: the defaults — the manifest's own text, ids where nothing was written, and
  // the English chrome built-ins.
  for (const [key, text] of Object.entries(CHROME_CATALOG)) {
    entries.set(key, text);
  }
  if (manifest.product.description !== undefined) {
    entries.set('product.description', manifest.product.description);
  }
  if (manifest.gui?.windowTitle !== undefined) {
    entries.set('gui.windowTitle', manifest.gui.windowTitle);
  }
  for (const [id, spec] of Object.entries(manifest.inputs)) {
    entries.set(`inputs.${id}.title`, spec.title ?? id);
    if (spec.description !== undefined) {
      entries.set(`inputs.${id}.description`, spec.description);
    }
    if (spec.type === 'text' && spec.patternHint !== undefined) {
      entries.set(`inputs.${id}.patternHint`, spec.patternHint);
    }
    if (spec.type === 'select' || spec.type === 'multiselect') {
      for (const option of spec.options) {
        entries.set(`inputs.${id}.options.${optionValue(option)}.label`, optionLabel(option));
      }
    }
  }
  for (const step of manifest.steps) {
    entries.set(`steps.${step.id}.title`, step.title ?? step.id);
  }

  // Layer 2: the overlay, key by key — a partial overlay fills its gaps from layer 1.
  for (const [key, text] of Object.entries(overlay?.entries ?? {})) {
    entries.set(key, text);
  }

  const snapshot: Readonly<Record<string, string>> = Object.freeze(Object.fromEntries(entries));
  const get = (key: string): string | undefined =>
    Object.hasOwn(snapshot, key) ? snapshot[key] : undefined;

  const table: StringTable = {
    locale: options.locale,
    overlayLocale: overlay?.locale,
    entries: snapshot,
    chrome: (key, values) => {
      if (!Object.hasOwn(CHROME_CATALOG, key)) {
        throw new InternalError(`unknown chrome string key "${key}"`);
      }
      const template = get(key);
      if (template === undefined) {
        throw new InternalError(`missing resolved chrome string for key "${key}"`);
      }
      return formatChrome(template, values);
    },
    inputTitle: (id) => get(`inputs.${id}.title`) ?? id,
    inputDescription: (id) => get(`inputs.${id}.description`),
    patternHint: (id) => get(`inputs.${id}.patternHint`),
    optionLabel: (inputId, value) => get(`inputs.${inputId}.options.${value}.label`) ?? value,
    stepTitle: (id) => get(`steps.${id}.title`) ?? id,
    productDescription: () => get('product.description'),
    windowTitle: () => get('gui.windowTitle'),
  };
  const frozenTable = Object.freeze(table);
  stringTableContexts.set(frozenTable, Object.freeze({ manifest, locale: options.locale }));
  return frozenTable;
}
