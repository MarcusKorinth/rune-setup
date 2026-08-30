/**
 * Locale selection and overlay discovery (docs/architecture.md §6.3).
 *
 * Precedence: `--locale` > `RUNE_LOCALE` > system locale. Matching an overlay tries the
 * exact tag first, then the language alone — `de-DE` falls back to `de`.
 */

import { readdirSync } from 'node:fs';
import { join } from 'node:path';

import { environmentValue } from '../environment.js';

/** Where a manifest's overlays live, relative to the manifest's directory. */
export const LOCALES_DIRECTORY = 'locales';

/**
 * Normalizes what a flag, an environment variable, or the OS reports to a BCP-47-style tag:
 * `de_DE.UTF-8` → `de-DE`, `EN` → `en`. The POSIX pseudo-locales mean "no preference".
 */
export function normalizeLocaleTag(raw: string): string | undefined {
  const bare = raw.split('.')[0]?.split('@')[0]?.replace(/_/g, '-').trim() ?? '';
  if (bare === '' || /^(c|posix)$/i.test(bare)) {
    return undefined;
  }
  const [language, ...rest] = bare.split('-');
  if (language === undefined || !/^[A-Za-z]{2,8}$/.test(language)) {
    return undefined;
  }
  const tail = rest.map((part) => (part.length === 2 ? part.toUpperCase() : part));
  return [language.toLowerCase(), ...tail].join('-');
}

export interface LocaleSelectionOptions {
  /** The `--locale` flag, verbatim, when the caller passed one. */
  readonly flag?: string | undefined;
  readonly environment: Readonly<Record<string, string | undefined>>;
  /** What the operating system reports, e.g. `Intl` — injected so hosts and tests own it. */
  readonly systemLocale?: string | undefined;
}

/** The display locale for a session, or `undefined` for the built-in defaults (§6.3). */
export function selectLocale(options: LocaleSelectionOptions): string | undefined {
  for (const candidate of [options.flag, environmentValue(options.environment, 'RUNE_LOCALE')]) {
    if (candidate !== undefined && candidate !== '') {
      // An explicit choice terminates the chain: `--locale C` asks for the built-in
      // defaults, never for whatever the next source would have said.
      return normalizeLocaleTag(candidate);
    }
  }
  return options.systemLocale === undefined ? undefined : normalizeLocaleTag(options.systemLocale);
}

export interface DiscoveredOverlay {
  /** The tag the file name claims, e.g. `de` for `locales/de.yaml`. */
  readonly locale: string;
  readonly path: string;
}

/** Lists the overlay files next to a manifest; no `locales/` directory is simply none. */
export function discoverOverlays(manifestDir: string): readonly DiscoveredOverlay[] {
  const directory = join(manifestDir, LOCALES_DIRECTORY);
  let names: string[];
  try {
    names = readdirSync(directory);
  } catch {
    return [];
  }
  return names
    .filter((name) => /\.ya?ml$/i.test(name))
    .sort()
    .map((name) => ({ locale: name.replace(/\.ya?ml$/i, ''), path: join(directory, name) }));
}

/**
 * The overlay that serves a tag: the exact tag if present, else the language alone —
 * `de-DE` uses `locales/de-DE.yaml`, or `locales/de.yaml` when only that exists.
 */
export function matchOverlay(
  tag: string,
  overlays: readonly DiscoveredOverlay[],
): DiscoveredOverlay | undefined {
  const lower = tag.toLowerCase();
  const exact = overlays.find((overlay) => overlay.locale.toLowerCase() === lower);
  if (exact !== undefined) {
    return exact;
  }
  const language = tag.split('-')[0]?.toLowerCase();
  return overlays.find((overlay) => overlay.locale.toLowerCase() === language);
}
