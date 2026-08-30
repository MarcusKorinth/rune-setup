/**
 * Locale selection and overlay discovery (docs/architecture.md §6.3).
 *
 * Precedence: `--locale` > `RUNE_LOCALE` > system locale. Matching an overlay tries the
 * exact tag first, then the language alone — `de-DE` falls back to `de`.
 */

import { lstatSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

import { ManifestError, UsageError, messageOf } from '../errors.js';

/** Where a manifest's overlays live, relative to the manifest's directory. */
export const LOCALES_DIRECTORY = 'locales';

function canonicalizeLocaleTag(tag: string): string | undefined {
  try {
    return Intl.getCanonicalLocales(tag)[0];
  } catch {
    return undefined;
  }
}

/** Normalizes a BCP-47-style tag, accepting underscores as locale separators. */
export function normalizeLocaleTag(raw: string): string | undefined {
  const tag = raw.replace(/_/g, '-');
  if (tag === '' || /^(c|posix)$/i.test(tag)) {
    return undefined;
  }

  return canonicalizeLocaleTag(tag);
}

function normalizeOverlayLocaleClaim(raw: string): string | undefined {
  return normalizeLocaleTag(raw);
}

function normalizeExplicitLocale(
  raw: string,
  source: '--locale' | 'RUNE_LOCALE',
): string | undefined {
  const value = raw.trim();
  if (/^(c|posix)$/i.test(value)) {
    return undefined;
  }

  const tag = normalizeLocaleTag(value);
  if (tag === undefined) {
    throw new UsageError(
      `invalid locale ${JSON.stringify(raw)} from ${source}; expected a BCP 47 locale tag such as "de-DE", or C/POSIX for the built-in defaults`,
    );
  }
  return tag;
}

function normalizeSystemLocale(raw: string): string | undefined {
  // POSIX system locale names may add an encoding and modifier around the locale tag.
  const bare = raw.split('.')[0]?.split('@')[0]?.trim() ?? '';
  return normalizeLocaleTag(bare);
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
  if (options.flag !== undefined && options.flag !== '') {
    // An explicit choice terminates the chain: `--locale C` asks for the built-in
    // defaults, never for whatever the next source would have said.
    return normalizeExplicitLocale(options.flag, '--locale');
  }
  const environmentLocale = options.environment['RUNE_LOCALE'];
  if (environmentLocale !== undefined && environmentLocale !== '') {
    return normalizeExplicitLocale(environmentLocale, 'RUNE_LOCALE');
  }
  return options.systemLocale === undefined
    ? undefined
    : normalizeSystemLocale(options.systemLocale);
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
  } catch (cause) {
    if (cause instanceof Error && (cause as NodeJS.ErrnoException).code === 'ENOENT') {
      try {
        lstatSync(directory);
      } catch (lstatCause) {
        if (
          lstatCause instanceof Error &&
          (lstatCause as NodeJS.ErrnoException).code === 'ENOENT'
        ) {
          return [];
        }
      }
    }
    throw new ManifestError('RUNE-101', `${directory} cannot be read: ${messageOf(cause)}`, {
      cause,
    });
  }
  const overlays = names
    .filter((name) => /\.yaml$/i.test(name))
    .sort()
    .map((name) => {
      const path = join(directory, name);
      const locale = normalizeOverlayLocaleClaim(name.replace(/\.yaml$/i, ''));
      if (locale === undefined) {
        throw new ManifestError(
          'RUNE-104',
          `locale overlay file "${path}" does not name a valid locale`,
        );
      }
      return { locale, path };
    });

  const claims = new Map<string, DiscoveredOverlay>();
  for (const overlay of overlays) {
    const claim = overlay.locale.toLowerCase();
    const first = claims.get(claim);
    if (first !== undefined) {
      throw new ManifestError(
        'RUNE-104',
        `locale overlay files "${first.path}" and "${overlay.path}" both claim locale "${overlay.locale}" (locale file names are normalized and matched case-insensitively)`,
      );
    }
    claims.set(claim, overlay);
  }

  return overlays;
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
