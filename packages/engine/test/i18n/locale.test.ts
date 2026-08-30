import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { ManifestError, UsageError } from '../../src/errors.js';
import {
  discoverOverlays,
  matchOverlay,
  normalizeLocaleTag,
  selectLocale,
} from '../../src/i18n/locale.js';

describe('normalizeLocaleTag', () => {
  it('canonicalizes BCP-47-style tags and accepts underscores as separators', () => {
    expect(normalizeLocaleTag('de')).toBe('de');
    expect(normalizeLocaleTag('EN')).toBe('en');
    expect(normalizeLocaleTag('pt_br')).toBe('pt-BR');
    expect(normalizeLocaleTag('SR_latn_rs')).toBe('sr-Latn-RS');
  });

  it('rejects malformed tags without removing OS-specific suffixes', () => {
    expect(normalizeLocaleTag('de-')).toBeUndefined();
    expect(normalizeLocaleTag('de--DE')).toBeUndefined();
    expect(normalizeLocaleTag('de--DE.UTF-8')).toBeUndefined();
    expect(normalizeLocaleTag('de.backup')).toBeUndefined();
    expect(normalizeLocaleTag('sr_RS@latin')).toBeUndefined();
  });

  it('treats the POSIX pseudo-locales as no preference', () => {
    expect(normalizeLocaleTag('C')).toBeUndefined();
    expect(normalizeLocaleTag('POSIX')).toBeUndefined();
    expect(normalizeLocaleTag('')).toBeUndefined();
  });
});

describe('selectLocale', () => {
  it('prefers the flag over the environment over the system', () => {
    expect(
      selectLocale({
        flag: 'fr',
        environment: { RUNE_LOCALE: 'de' },
        systemLocale: 'en-US',
      }),
    ).toBe('fr');
    expect(selectLocale({ environment: { RUNE_LOCALE: 'de' }, systemLocale: 'en-US' })).toBe('de');
    expect(selectLocale({ flag: 'de_DE', environment: {}, systemLocale: 'en-US' })).toBe('de-DE');
    expect(selectLocale({ environment: {}, systemLocale: 'en_US.UTF-8' })).toBe('en-US');
    expect(selectLocale({ environment: {}, systemLocale: 'sr_RS@latin' })).toBe('sr-RS');
    expect(selectLocale({ environment: {} })).toBeUndefined();
  });

  it('lets an explicit choice terminate the chain, even when it means the defaults', () => {
    expect(selectLocale({ flag: 'C', environment: { RUNE_LOCALE: 'de' } })).toBeUndefined();
    expect(
      selectLocale({ environment: { RUNE_LOCALE: 'POSIX' }, systemLocale: 'de-DE' }),
    ).toBeUndefined();
    expect(selectLocale({ flag: ' c ', environment: { RUNE_LOCALE: 'de' } })).toBeUndefined();
    expect(selectLocale({ environment: {}, systemLocale: 'C.UTF-8' })).toBeUndefined();
  });

  it.each(['de--DE', 'de.backup', '   '])(
    'rejects invalid explicit flag locale %j without falling back',
    (flag) => {
      let thrown: unknown;
      try {
        selectLocale({
          flag,
          environment: { RUNE_LOCALE: 'de' },
          systemLocale: 'en-US',
        });
      } catch (error) {
        thrown = error;
      }

      expect(thrown).toBeInstanceOf(UsageError);
      const error = thrown as UsageError;
      expect(error.code).toBe('RUNE-001');
      expect(error.message).toContain(`invalid locale ${JSON.stringify(flag)} from --locale`);
      expect(error.message).toContain('C/POSIX');
    },
  );

  it('rejects an invalid explicit environment locale without falling back', () => {
    let thrown: unknown;
    try {
      selectLocale({ environment: { RUNE_LOCALE: 'de@backup' }, systemLocale: 'en-US' });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(UsageError);
    const error = thrown as UsageError;
    expect(error.code).toBe('RUNE-001');
    expect(error.message).toContain('invalid locale "de@backup" from RUNE_LOCALE');
    expect(error.message).toContain('C/POSIX');
  });

  it('silently ignores an invalid system locale', () => {
    expect(selectLocale({ environment: {}, systemLocale: 'de--DE.UTF-8' })).toBeUndefined();
  });
});

describe('overlay discovery and matching', () => {
  it('lists the yaml files of locales/ and matches exact tag before language', () => {
    const dir = mkdtempSync(join(tmpdir(), 'rune-i18n-'));
    mkdirSync(join(dir, 'locales'));
    writeFileSync(join(dir, 'locales', 'de.yaml'), 'steps.install.title: Installieren\n');
    writeFileSync(join(dir, 'locales', 'de-AT.yaml'), 'steps.install.title: Aufsetzen\n');

    const overlays = discoverOverlays(dir);
    expect(overlays.map((overlay) => overlay.locale).sort()).toEqual(['de', 'de-AT']);
    expect(matchOverlay('de-AT', overlays)?.locale).toBe('de-AT');
    expect(matchOverlay('de-DE', overlays)?.locale).toBe('de');
    expect(matchOverlay('fr', overlays)).toBeUndefined();
  });

  it('normalizes locale file names before matching them', () => {
    const dir = mkdtempSync(join(tmpdir(), 'rune-i18n-'));
    mkdirSync(join(dir, 'locales'));
    writeFileSync(join(dir, 'locales', 'de_DE.yaml'), 'steps.install.title: Installieren\n');

    const overlays = discoverOverlays(dir);
    expect(overlays).toHaveLength(1);
    expect(overlays[0]?.locale).toBe('de-DE');
    expect(matchOverlay('de-DE', overlays)?.locale).toBe('de-DE');
  });

  it('canonicalizes the full script and region casing claimed by a file name', () => {
    const dir = mkdtempSync(join(tmpdir(), 'rune-i18n-'));
    mkdirSync(join(dir, 'locales'));
    writeFileSync(join(dir, 'locales', 'zh_hANT_tw.yaml'), 'rune.button.next: Continue\n');

    const overlays = discoverOverlays(dir);
    expect(overlays).toHaveLength(1);
    expect(overlays[0]?.locale).toBe('zh-Hant-TW');
  });

  it('treats a missing locales directory as no overlays', () => {
    expect(discoverOverlays(mkdtempSync(join(tmpdir(), 'rune-i18n-')))).toEqual([]);
  });

  it('fails loudly when locales is a dangling link', () => {
    const dir = mkdtempSync(join(tmpdir(), 'rune-i18n-'));
    const localesPath = join(dir, 'locales');
    const missingTarget = join(dir, 'missing-locales-target');
    symlinkSync(missingTarget, localesPath, process.platform === 'win32' ? 'junction' : 'dir');

    let thrown: unknown;
    try {
      discoverOverlays(dir);
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(ManifestError);
    const error = thrown as ManifestError;
    expect(error.code).toBe('RUNE-101');
    expect(error.message).toContain(localesPath);
    expect(error.message).toMatch(/ENOENT|no such file or directory/i);
  });

  it('rejects multiple files that claim the same locale', () => {
    const dir = mkdtempSync(join(tmpdir(), 'rune-i18n-'));
    const localesPath = join(dir, 'locales');
    const hyphenatedPath = join(localesPath, 'de-DE.yaml');
    const underscoredPath = join(localesPath, 'de_DE.yaml');
    mkdirSync(localesPath);
    writeFileSync(hyphenatedPath, 'rune.button.next: Weiter\n');
    writeFileSync(underscoredPath, 'rune.button.next: Vorwaerts\n');

    let thrown: unknown;
    try {
      discoverOverlays(dir);
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(ManifestError);
    const error = thrown as ManifestError;
    expect(error.code).toBe('RUNE-104');
    expect(error.message).toContain(hyphenatedPath);
    expect(error.message).toContain(underscoredPath);
    expect(error.message).toContain('locale "de-DE"');
  });

  it('ignores yml files when discovering and matching overlays', () => {
    const dir = mkdtempSync(join(tmpdir(), 'rune-i18n-'));
    const localesPath = join(dir, 'locales');
    mkdirSync(localesPath);
    writeFileSync(join(localesPath, 'de.yml'), 'rune.button.next: Weiter\n');

    const overlays = discoverOverlays(dir);
    expect(overlays).toEqual([]);
    expect(matchOverlay('de', overlays)).toBeUndefined();
  });

  it('rejects a locale file name that cannot be normalized', () => {
    const dir = mkdtempSync(join(tmpdir(), 'rune-i18n-'));
    const localesPath = join(dir, 'locales');
    const invalidPath = join(localesPath, 'POSIX.yaml');
    mkdirSync(localesPath);
    writeFileSync(invalidPath, 'rune.button.next: Weiter\n');

    let thrown: unknown;
    try {
      discoverOverlays(dir);
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(ManifestError);
    const error = thrown as ManifestError;
    expect(error.code).toBe('RUNE-104');
    expect(error.message).toContain(invalidPath);
  });

  it.each(['de.backup.yaml', 'de@backup.yaml', 'de-.yaml', 'de--DE.yaml'])(
    'rejects the complete invalid locale claim in %s',
    (fileName) => {
      const dir = mkdtempSync(join(tmpdir(), 'rune-i18n-'));
      const localesPath = join(dir, 'locales');
      const invalidPath = join(localesPath, fileName);
      mkdirSync(localesPath);
      writeFileSync(invalidPath, 'rune.button.next: Weiter\n');

      let thrown: unknown;
      try {
        discoverOverlays(dir);
      } catch (error) {
        thrown = error;
      }

      expect(thrown).toBeInstanceOf(ManifestError);
      const error = thrown as ManifestError;
      expect(error.code).toBe('RUNE-104');
      expect(error.message).toContain(invalidPath);
    },
  );

  it('fails loudly when locales is not a directory', () => {
    const dir = mkdtempSync(join(tmpdir(), 'rune-i18n-'));
    const localesPath = join(dir, 'locales');
    writeFileSync(localesPath, 'not a directory');

    let thrown: unknown;
    try {
      discoverOverlays(dir);
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(ManifestError);
    const error = thrown as ManifestError;
    expect(error.code).toBe('RUNE-101');
    expect(error.message).toContain(localesPath);
    expect(error.message).toMatch(/ENOTDIR|not a directory/i);
  });
});
