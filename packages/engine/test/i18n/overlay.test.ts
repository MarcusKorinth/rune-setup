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
    'gui:',
    '  windowTitle: Example setup',
    'inputs:',
    '  environment:',
    '    type: select',
    '    description: Choose an environment',
    '    options:',
    '      - production',
    '      - value: dev',
    '        label: Development',
    '  port:',
    '    type: text',
    "    pattern: '[0-9]+'",
    '    patternHint: Enter a port number',
    'steps:',
    '  - id: install',
    '    title: Install',
    '    run:',
    '      command: node',
    '',
  ].join('\n'),
  'installer.yaml',
);

const MANIFEST_WITHOUT_OPTIONAL_FALLBACKS = parseManifestText(
  [
    'schemaVersion: 1',
    'product:',
    '  name: Minimal',
    '  version: "1.0.0"',
    'inputs:',
    '  target:',
    '    type: text',
    'steps:',
    '  - id: install',
    '    run:',
    '      command: node',
    '',
  ].join('\n'),
  'installer.yaml',
);

describe('localizableKeys', () => {
  it('lists exactly every localizable path family declared by the manifest', () => {
    expect(localizableKeys(MANIFEST)).toEqual(
      new Set([
        'product.description',
        'gui.windowTitle',
        'inputs.environment.title',
        'inputs.environment.description',
        'inputs.environment.options.production.label',
        'inputs.environment.options.dev.label',
        'inputs.port.title',
        'inputs.port.patternHint',
        'steps.install.title',
      ]),
    );
  });

  it('omits optional texts that the manifest does not declare', () => {
    expect(localizableKeys(MANIFEST_WITHOUT_OPTIONAL_FALLBACKS)).toEqual(
      new Set(['inputs.target.title', 'steps.install.title']),
    );
  });
});

describe('loading an overlay', () => {
  it('accepts manifest paths and chrome keys, and keeps the mapping flat', () => {
    const overlay = loadOverlayText(
      [
        'product.description: Ein Beispielprodukt',
        'inputs.environment.description: Umgebung waehlen',
        'inputs.port.patternHint: Portnummer eingeben',
        'gui.windowTitle: Beispiel-Setup',
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
    expect(overlay.entries['product.description']).toBe('Ein Beispielprodukt');
    expect(overlay.entries['inputs.environment.description']).toBe('Umgebung waehlen');
    expect(overlay.entries['inputs.port.patternHint']).toBe('Portnummer eingeben');
    expect(overlay.entries['gui.windowTitle']).toBe('Beispiel-Setup');
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

  it('rejects a structural manifest copy without parser provenance', () => {
    expect(() =>
      loadOverlayText(
        'rune.button.next: Weiter\n',
        'locales/de.yaml',
        'de',
        structuredClone(MANIFEST),
      ),
    ).toThrow(/manifest was not created by parseManifest/);
  });

  it('rejects a key that names nothing, loudly and with its location', () => {
    expect(() =>
      loadOverlayText('steps.instal.title: Tippfehler\n', 'locales/de.yaml', 'de', MANIFEST),
    ).toThrow(/steps\.instal\.title does not name a localizable text/);
    expect(() =>
      loadOverlayText('rune.button.nope: X\n', 'locales/de.yaml', 'de', MANIFEST),
    ).toThrow(/not in RUNE's chrome catalogue/);
  });

  it.each([
    ['product description', 'product.description: Beschreibung\n'],
    ['input description', 'inputs.target.description: Beschreibung\n'],
    ['pattern hint', 'inputs.target.patternHint: Ziffern\n'],
    ['window title', 'gui.windowTitle: Minimal\n'],
  ])('rejects an overlay %s without a manifest fallback', (_name, text) => {
    expect(() =>
      loadOverlayText(text, 'locales/de.yaml', 'de', MANIFEST_WITHOUT_OPTIONAL_FALLBACKS),
    ).toThrow(/does not name a localizable text of this manifest/);
  });

  it('rejects a non-string value', () => {
    expect(() =>
      loadOverlayText('steps.install.title: [a, b]\n', 'locales/de.yaml', 'de', MANIFEST),
    ).toThrow(/must be a string/);
  });

  it('reports every invalid entry in source order', () => {
    let problem: unknown;
    try {
      loadOverlayText(
        [
          'steps.missing.title: Unbekannt',
          '"2": Ungueltig',
          'rune.button.nope: Unbekannt',
          '',
        ].join('\n'),
        'locales/de.yaml',
        'de',
        MANIFEST,
      );
    } catch (cause) {
      problem = cause;
    }

    expect(problem).toBeInstanceOf(ManifestError);
    const error = problem as ManifestError;
    expect(error.code).toBe('RUNE-104');
    expect(error.location).toEqual({ file: 'locales/de.yaml', line: 1, column: 1 });
    expect(error.issues).toEqual([
      {
        code: 'RUNE-104',
        message: 'steps.missing.title does not name a localizable text of this manifest',
        location: { file: 'locales/de.yaml', line: 1, column: 1 },
      },
      {
        code: 'RUNE-104',
        message: '2 does not name a localizable text of this manifest',
        location: { file: 'locales/de.yaml', line: 2, column: 1 },
      },
      {
        code: 'RUNE-104',
        message: "rune.button.nope is not in RUNE's chrome catalogue",
        location: { file: 'locales/de.yaml', line: 3, column: 1 },
      },
    ]);
    expect(error.message).toBe(
      [
        'locales/de.yaml:1:1: steps.missing.title does not name a localizable text of this manifest',
        'locales/de.yaml:2:1: 2 does not name a localizable text of this manifest',
        "locales/de.yaml:3:1: rune.button.nope is not in RUNE's chrome catalogue",
      ].join('\n'),
    );
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
    ['marker-only', '---\n'],
    ['marker and comments', '--- # German translations\n# None yet\n'],
    ['directive and marker-only', '%YAML 1.2\n---'],
  ])('treats a %s document as an empty overlay', (_name, text) => {
    const overlay = loadOverlayText(text, 'locales/de.yaml', 'de', MANIFEST);

    expect(Object.keys(overlay.entries)).toHaveLength(0);
  });

  it.each([
    ['null', 'null\n', 1, 1],
    ['~', '~\n', 1, 1],
    ['marked null', '---\nnull\n', 2, 1],
    ['anchored null', '&a null\n', 1, 4],
    ['anchored empty scalar', '&a\n', 1, 3],
    ['tagged null', '!!null null\n', 1, 8],
    ['tagged empty scalar', '!!null\n', 1, 7],
    ['a string scalar', 'text\n', 1, 1],
    ['a sequence', '[]\n', 1, 1],
  ])('rejects %s as a non-mapping', (_name, text, line, column) => {
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
      location: { file: 'locales/de.yaml', line, column },
    });
  });
});
