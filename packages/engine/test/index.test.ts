import { describe, expect, it } from 'vitest';

import * as engine from '../src/index.js';
import type { ChromeKey, StringTable } from '../src/index.js';

const INTERNAL_RUNTIME_EXPORTS = [
  'EXIT_CODE_BY_STATUS',
  'CHROME_CATALOG',
  'formatChrome',
  'discoverOverlays',
  'discoverSelectedOverlay',
  'LOCALES_DIRECTORY',
  'matchOverlay',
  'normalizeLocaleTag',
  'selectLocale',
  'loadOverlay',
  'loadOverlayText',
  'localizableKeys',
  'resolveStrings',
  'createLogFileSink',
] as const;

type StringTableIsExported = StringTable extends object ? true : false;
const stringTableTypeIsExported: StringTableIsExported = true;
type ChromeParameter = Parameters<StringTable['chrome']>[0];
type ChromeParameterIsPublicKey = [ChromeParameter, ChromeKey] extends [ChromeKey, ChromeParameter]
  ? true
  : false;
type KnownChromeKeyIsAccepted = 'rune.button.next' extends ChromeParameter ? true : false;
type UnknownChromeKeyIsRejected = 'rune.button.unknown' extends ChromeParameter ? false : true;
const chromeParameterIsPublicKey: ChromeParameterIsPublicKey = true;
const knownChromeKeyIsAccepted: KnownChromeKeyIsAccepted = true;
const unknownChromeKeyIsRejected: UnknownChromeKeyIsRejected = true;
const compileTimeReadonlyAccessorContract = (strings: StringTable): void => {
  // @ts-expect-error StringTable accessors are readonly public properties.
  strings.chrome = () => '';
  // @ts-expect-error StringTable accessors are readonly public properties.
  strings.inputTitle = () => '';
  // @ts-expect-error StringTable accessors are readonly public properties.
  strings.inputDescription = () => undefined;
  // @ts-expect-error StringTable accessors are readonly public properties.
  strings.patternHint = () => undefined;
  // @ts-expect-error StringTable accessors are readonly public properties.
  strings.optionLabel = () => '';
  // @ts-expect-error StringTable accessors are readonly public properties.
  strings.stepTitle = () => '';
  // @ts-expect-error StringTable accessors are readonly public properties.
  strings.productDescription = () => undefined;
  // @ts-expect-error StringTable accessors are readonly public properties.
  strings.windowTitle = () => undefined;
};

describe('@rune/engine public API', () => {
  it('exposes a semver version', () => {
    expect(engine.RUNE_VERSION).toMatch(/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/);
  });

  it('does not expose internal runtime helpers', () => {
    for (const name of INTERNAL_RUNTIME_EXPORTS) {
      expect(engine).not.toHaveProperty(name);
    }
  });

  it('keeps i18n contracts as type-only exports', () => {
    expect(stringTableTypeIsExported).toBe(true);
    expect(chromeParameterIsPublicKey).toBe(true);
    expect(knownChromeKeyIsAccepted).toBe(true);
    expect(unknownChromeKeyIsRejected).toBe(true);
    expect(compileTimeReadonlyAccessorContract).toBeTypeOf('function');
    expect(engine).not.toHaveProperty('StringTable');
    expect(engine).not.toHaveProperty('ChromeKey');
  });

  it('exports engine-owned failure-result construction', () => {
    expect(engine.createFailureResult).toBeTypeOf('function');
  });
});
