/**
 * Locale selection and overlay discovery (docs/architecture.md §6.3).
 *
 * Precedence: `--locale` > `RUNE_LOCALE` > system locale. Matching an overlay tries the
 * exact tag first, then the language alone — `de-DE` falls back to `de`.
 */

import { lstatSync, readdirSync } from 'node:fs';
import { lstat, readdir } from 'node:fs/promises';
import { join } from 'node:path';

import { formatDiagnostic, quotedDiagnostic, type DiagnosticPart } from '../diagnostics.js';
import { environmentValue } from '../environment.js';
import { ManifestError, UsageError, messageOf, withIssueDiagnosticParts } from '../errors.js';

/** Where a manifest's overlays live, relative to the manifest's directory. */
export const LOCALES_DIRECTORY = 'locales';

function canonicalizeLocaleTag(tag: string): string | undefined {
  try {
    return Intl.getCanonicalLocales(tag)[0];
  } catch {
    return undefined;
  }
}

/** Normalizes a Unicode locale identifier, accepting underscores as locale separators. */
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
    // The value is a runtime string a session may hold as a secret, so it travels as a raw
    // quoted part: quoting it here would hand every masker an escaped spelling the registry
    // never held, and the mask would miss it (§10, "Path spellings").
    const parts: readonly DiagnosticPart[] = [
      'invalid locale ',
      quotedDiagnostic(raw),
      ` from ${source}; expected a Unicode locale identifier supported by Node Intl such as "de-DE", or C/POSIX for the built-in defaults`,
    ];
    const issue = withIssueDiagnosticParts(
      { code: 'RUNE-001', message: formatDiagnostic(parts), location: undefined },
      parts,
    );
    throw new UsageError(issue.message, { issues: [issue] });
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
  const environmentLocale = environmentValue(options.environment, 'RUNE_LOCALE');
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

interface OverlayFile {
  readonly localeClaim: string;
  readonly path: string;
}

function scanOverlayFiles(manifestDir: string): readonly OverlayFile[] {
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

  return overlayFiles(directory, names);
}

async function scanOverlayFilesAsync(manifestDir: string): Promise<readonly OverlayFile[]> {
  const directory = join(manifestDir, LOCALES_DIRECTORY);
  let names: string[];
  try {
    names = await readdir(directory);
  } catch (cause) {
    if (cause instanceof Error && (cause as NodeJS.ErrnoException).code === 'ENOENT') {
      try {
        await lstat(directory);
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

  return overlayFiles(directory, names);
}

function overlayFiles(directory: string, names: readonly string[]): readonly OverlayFile[] {
  return names
    .filter((name) => /\.yaml$/i.test(name))
    .sort()
    .map((name) => ({
      localeClaim: name.replace(/\.yaml$/i, ''),
      path: join(directory, name),
    }));
}

function duplicateClaim(first: DiscoveredOverlay, second: DiscoveredOverlay): ManifestError {
  return new ManifestError(
    'RUNE-104',
    `locale overlay files "${first.path}" and "${second.path}" both claim locale "${second.locale}" (locale file names are normalized and matched case-insensitively)`,
  );
}

/** Lists the overlay files next to a manifest; no `locales/` directory is simply none. */
export function discoverOverlays(manifestDir: string): readonly DiscoveredOverlay[] {
  const overlays = scanOverlayFiles(manifestDir).map(({ localeClaim, path }) => {
    const locale = normalizeOverlayLocaleClaim(localeClaim);
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
      throw duplicateClaim(first, overlay);
    }
    claims.set(claim, overlay);
  }

  return overlays;
}

/** Discovers only the exact or language-fallback overlay needed by a run. */
export function discoverSelectedOverlay(
  manifestDir: string,
  selectedLocale: string,
): DiscoveredOverlay | undefined {
  return selectDiscoveredOverlay(scanOverlayFiles(manifestDir), selectedLocale);
}

/** Session-only selected-overlay discovery using asynchronous filesystem I/O. */
export async function discoverSelectedOverlayAsync(
  manifestDir: string,
  selectedLocale: string,
): Promise<DiscoveredOverlay | undefined> {
  return selectDiscoveredOverlay(await scanOverlayFilesAsync(manifestDir), selectedLocale);
}

function selectDiscoveredOverlay(
  files: readonly OverlayFile[],
  selectedLocale: string,
): DiscoveredOverlay | undefined {
  const selected = normalizeOverlayLocaleClaim(selectedLocale);
  if (selected === undefined) {
    return undefined;
  }

  const exactClaim = selected.toLowerCase();
  const languageClaim = selected.split('-')[0]?.toLowerCase();
  const exactMatches: DiscoveredOverlay[] = [];
  const languageMatches: DiscoveredOverlay[] = [];

  for (const file of files) {
    const locale = normalizeOverlayLocaleClaim(file.localeClaim);
    if (locale === undefined) {
      continue;
    }

    const overlay = { locale, path: file.path };
    const claim = locale.toLowerCase();
    if (claim === exactClaim) {
      exactMatches.push(overlay);
    } else if (claim === languageClaim) {
      languageMatches.push(overlay);
    }
  }

  const firstExact = exactMatches[0];
  const secondExact = exactMatches[1];
  if (firstExact !== undefined && secondExact !== undefined) {
    throw duplicateClaim(firstExact, secondExact);
  }
  if (firstExact !== undefined) {
    return firstExact;
  }

  const firstLanguage = languageMatches[0];
  const secondLanguage = languageMatches[1];
  if (firstLanguage !== undefined && secondLanguage !== undefined) {
    throw duplicateClaim(firstLanguage, secondLanguage);
  }
  return firstLanguage;
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
