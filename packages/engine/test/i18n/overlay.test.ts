import { describe, expect, it } from 'vitest';

import { ManifestError } from '../../src/errors.js';
import { CHROME_CATALOG } from '../../src/i18n/catalog.js';
import { loadOverlayText, localizableKeys } from '../../src/i18n/overlay.js';
import { parseManifestText } from '../../src/manifest/index.js';

const MANIFEST = parseManifestText(
  [
    'schemaVersion: 1',
    'product:',
    '  name: Example',
    '  version: "1.0.0"',
    '  description: An example product',
    'inputs:',
    '  environment:',
    '    type: select',
    '    options:',
    '      - production',
    '      - value: dev',
    '        label: Development',
    'steps:',
    '  - id: install',
    '    title: Install',
    '    run:',
    '      command: node',
    '',
  ].join('\n'),
  'installer.yaml',
);

describe('localizableKeys', () => {
  it('lists titles and labels always, texts only where the manifest wrote them', () => {
    const keys = localizableKeys(MANIFEST);
    expect(keys).toContain('product.description');
    expect(keys).toContain('inputs.environment.title');
    expect(keys).toContain('inputs.environment.options.production.label');
    expect(keys).toContain('inputs.environment.options.dev.label');
    expect(keys).toContain('steps.install.title');
    expect(keys).not.toContain('inputs.environment.description');
    expect(keys).not.toContain('gui.windowTitle');
  });
});

describe('loading an overlay', () => {
  it('accepts manifest paths and chrome keys, and keeps the mapping flat', () => {
    const overlay = loadOverlayText(
      [
        'steps.install.title: Installieren',
        'inputs.environment.options.production.label: Produktivumgebung',
        'rune.button.next: Weiter',
        '',
      ].join('\n'),
      'locales/de.yaml',
      'de',
      MANIFEST,
    );

    expect(overlay.locale).toBe('de');
    expect(overlay.entries['steps.install.title']).toBe('Installieren');
    expect(overlay.entries['rune.button.next']).toBe('Weiter');
    expect(Object.isFrozen(overlay)).toBe(true);
    expect(Object.isFrozen(overlay.entries)).toBe(true);
  });

  it('keeps the chrome authority and overlay snapshot immutable at runtime', () => {
    const overlay = loadOverlayText(
      'steps.install.title: Installieren\n',
      'locales/de.yaml',
      'de',
      MANIFEST,
    );

    expect(Object.isFrozen(CHROME_CATALOG)).toBe(true);
    expect(() => {
      (CHROME_CATALOG as Record<string, string>)['rune.button.nope'] = 'Injected';
    }).toThrow(TypeError);
    expect(Object.hasOwn(CHROME_CATALOG, 'rune.button.nope')).toBe(false);
    expect(() => {
      (overlay.entries as Record<string, string>)['steps.install.title'] = 'Changed';
    }).toThrow(TypeError);
    expect(overlay.entries['steps.install.title']).toBe('Installieren');
    let problem: unknown;
    try {
      loadOverlayText('rune.button.nope: X\n', 'locales/de.yaml', 'de', MANIFEST);
    } catch (cause) {
      problem = cause;
    }
    expect(problem).toBeInstanceOf(ManifestError);
    expect(problem).toMatchObject({ code: 'RUNE-104' });
  });

  it('rejects a key that names nothing, loudly and with its location', () => {
    expect(() =>
      loadOverlayText('steps.instal.title: Tippfehler\n', 'locales/de.yaml', 'de', MANIFEST),
    ).toThrow(/steps\.instal\.title does not name a localizable text/);
    expect(() =>
      loadOverlayText('rune.button.nope: X\n', 'locales/de.yaml', 'de', MANIFEST),
    ).toThrow(/not in RUNE's chrome catalogue/);
  });

  it('rejects a non-string value', () => {
    expect(() =>
      loadOverlayText('steps.install.title: [a, b]\n', 'locales/de.yaml', 'de', MANIFEST),
    ).toThrow(/must be a string/);
  });

  it('treats an empty file as an empty overlay', () => {
    const overlay = loadOverlayText('', 'locales/de.yaml', 'de', MANIFEST);
    expect(Object.keys(overlay.entries)).toHaveLength(0);
    expect(Object.isFrozen(overlay)).toBe(true);
    expect(Object.isFrozen(overlay.entries)).toBe(true);
  });

  it('treats a comment-only file as an empty overlay', () => {
    const overlay = loadOverlayText('# German translations\n', 'locales/de.yaml', 'de', MANIFEST);
    expect(Object.keys(overlay.entries)).toHaveLength(0);
  });

  it.each([
    ['null', 'null\n'],
    ['~', '~\n'],
  ])('rejects an explicit %s scalar as a non-mapping', (_name, text) => {
    let problem: unknown;
    try {
      loadOverlayText(text, 'locales/de.yaml', 'de', MANIFEST);
    } catch (cause) {
      problem = cause;
    }

    expect(problem).toBeInstanceOf(ManifestError);
    expect(problem).toMatchObject({
      code: 'RUNE-104',
      message: 'a locale overlay must be a mapping of key to text',
      location: { file: 'locales/de.yaml', line: 1, column: 1 },
    });
  });
});
