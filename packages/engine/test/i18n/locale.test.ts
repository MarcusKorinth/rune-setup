import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  discoverOverlays,
  matchOverlay,
  normalizeLocaleTag,
  selectLocale,
} from '../../src/i18n/locale.js';

describe('normalizeLocaleTag', () => {
  it('turns what an OS reports into a tag', () => {
    expect(normalizeLocaleTag('de_DE.UTF-8')).toBe('de-DE');
    expect(normalizeLocaleTag('de')).toBe('de');
    expect(normalizeLocaleTag('EN')).toBe('en');
    expect(normalizeLocaleTag('pt_br')).toBe('pt-BR');
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
    expect(selectLocale({ environment: {}, systemLocale: 'en_US.UTF-8' })).toBe('en-US');
    expect(selectLocale({ environment: {} })).toBeUndefined();
  });

  it('lets an explicit choice terminate the chain, even when it means the defaults', () => {
    expect(selectLocale({ flag: 'C', environment: { RUNE_LOCALE: 'de' } })).toBeUndefined();
    expect(
      selectLocale({ environment: { RUNE_LOCALE: 'POSIX' }, systemLocale: 'de-DE' }),
    ).toBeUndefined();
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

  it('treats a missing locales directory as no overlays', () => {
    expect(discoverOverlays(mkdtempSync(join(tmpdir(), 'rune-i18n-')))).toEqual([]);
  });
});
