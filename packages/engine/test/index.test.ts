import { describe, expect, it } from 'vitest';

import * as engine from '../src/index.js';
import type { StringTable } from '../src/index.js';

const INTERNAL_RUNTIME_EXPORTS = [
  'EXIT_CODE_BY_STATUS',
  'CHROME_CATALOG',
  'formatChrome',
  'discoverOverlays',
  'LOCALES_DIRECTORY',
  'matchOverlay',
  'normalizeLocaleTag',
  'selectLocale',
  'loadOverlay',
  'loadOverlayText',
  'localizableKeys',
  'resolveStrings',
] as const;

type StringTableIsExported = StringTable extends object ? true : false;
const stringTableTypeIsExported: StringTableIsExported = true;

describe('@rune/engine public API', () => {
  it('exposes a semver version', () => {
    expect(engine.RUNE_VERSION).toMatch(/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/);
  });

  it('does not expose internal runtime helpers', () => {
    for (const name of INTERNAL_RUNTIME_EXPORTS) {
      expect(engine).not.toHaveProperty(name);
    }
  });

  it('keeps StringTable as a type-only contract', () => {
    expect(stringTableTypeIsExported).toBe(true);
    expect(engine).not.toHaveProperty('StringTable');
  });
});
