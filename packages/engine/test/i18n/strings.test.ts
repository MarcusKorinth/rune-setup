import { describe, expect, it } from 'vitest';

import { InternalError } from '../../src/errors.js';
import { formatChrome } from '../../src/i18n/catalog.js';
import { loadOverlayText } from '../../src/i18n/overlay.js';
import { resolveStrings } from '../../src/i18n/strings.js';
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
    '  target:',
    '    type: directory',
    '    title: Install directory',
    '    description: Where to install',
    '  port:',
    '    type: text',
    "    pattern: '[0-9]+'",
    '    patternHint: Enter a port number',
    '  environment:',
    '    type: select',
    '    options: [production, staging]',
    'steps:',
    '  - id: install',
    '    title: Install',
    '    run:',
    '      command: node',
    '  - id: cleanup',
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

describe('the resolved string table', () => {
  it('serves the defaults when no overlay is loaded', () => {
    const strings = resolveStrings({ manifest: MANIFEST });

    expect(strings.locale).toBeUndefined();
    expect(strings.productDescription()).toBe('An example product');
    expect(strings.windowTitle()).toBe('Example setup');
    expect(strings.inputTitle('target')).toBe('Install directory');
    expect(strings.inputDescription('target')).toBe('Where to install');
    expect(strings.patternHint('port')).toBe('Enter a port number');
    expect(strings.inputTitle('environment')).toBe('environment');
    expect(strings.optionLabel('environment', 'production')).toBe('production');
    expect(strings.stepTitle('install')).toBe('Install');
    expect(strings.stepTitle('cleanup')).toBe('cleanup');
    expect(strings.chrome('rune.button.next')).toBe('Next');
  });

  it('overrides per key and fills the gaps from the defaults', () => {
    const overlay = loadOverlayText(
      [
        'product.description: Ein Beispielprodukt',
        'inputs.target.description: Installationsort',
        'inputs.port.patternHint: Portnummer eingeben',
        'gui.windowTitle: Beispiel-Setup',
        'steps.install.title: Installieren',
        'inputs.target.title: Installationsverzeichnis',
        'rune.button.next: Weiter',
        '',
      ].join('\n'),
      'locales/de.yaml',
      'de',
      MANIFEST,
    );
    const strings = resolveStrings({ manifest: MANIFEST, locale: 'de-DE', overlay });

    expect(strings.locale).toBe('de-DE');
    expect(strings.overlayLocale).toBe('de');
    expect(strings.productDescription()).toBe('Ein Beispielprodukt');
    expect(strings.windowTitle()).toBe('Beispiel-Setup');
    expect(strings.inputDescription('target')).toBe('Installationsort');
    expect(strings.patternHint('port')).toBe('Portnummer eingeben');
    expect(strings.stepTitle('install')).toBe('Installieren');
    expect(strings.inputTitle('target')).toBe('Installationsverzeichnis');
    expect(strings.chrome('rune.button.next')).toBe('Weiter');
    expect(strings.chrome('rune.button.back')).toBe('Back');
    expect(strings.stepTitle('cleanup')).toBe('cleanup');
    expect(strings.entries['steps.install.title']).toBe('Installieren');
  });

  it('returns undefined for optional texts without manifest fallbacks', () => {
    const strings = resolveStrings({ manifest: MANIFEST_WITHOUT_OPTIONAL_FALLBACKS });

    expect(strings.productDescription()).toBeUndefined();
    expect(strings.inputDescription('target')).toBeUndefined();
    expect(strings.patternHint('target')).toBeUndefined();
    expect(strings.windowTitle()).toBeUndefined();
  });

  it('keeps the table and its entry snapshot immutable at runtime', () => {
    const strings = resolveStrings({ manifest: MANIFEST });

    expect(Object.isFrozen(strings)).toBe(true);
    expect(Object.isFrozen(strings.entries)).toBe(true);
    expect(() => {
      (strings.entries as Record<string, string>)['steps.install.title'] = 'Changed';
    }).toThrow(TypeError);
    expect(() => {
      (strings as { locale: string | undefined }).locale = 'fr';
    }).toThrow(TypeError);
    expect(strings.stepTitle('install')).toBe('Install');
    expect(strings.entries['steps.install.title']).toBe('Install');
  });

  it('fills chrome placeholders without re-scanning the substituted text', () => {
    const strings = resolveStrings({ manifest: MANIFEST });

    expect(strings.chrome('rune.progress.step', { index: 2, total: 5, title: '{index}' })).toBe(
      'Step 2 of 5: {index}',
    );
    expect(formatChrome('no placeholders')).toBe('no placeholders');
  });

  it('rejects unknown chrome keys at runtime', () => {
    const strings = resolveStrings({ manifest: MANIFEST });
    const untypedChrome = strings.chrome as (key: string) => string;

    expect.assertions(3);
    try {
      untypedChrome('steps.install.title');
    } catch (error) {
      expect(error).toBeInstanceOf(InternalError);
      expect(error).toMatchObject({ code: 'RUNE-500' });
      expect((error as Error).message).toContain('unknown chrome string key "steps.install.title"');
    }
  });

  it('fills placeholders only from own values', () => {
    expect(formatChrome('{constructor} {toString}')).toBe('{constructor} {toString}');

    const inherited = Object.create({ title: 'inherited' }) as Readonly<
      Record<string, string | number>
    >;
    expect(formatChrome('{title}', inherited)).toBe('{title}');
    expect(
      formatChrome('{constructor} {toString}', { constructor: 'own', toString: 'value' }),
    ).toBe('own value');
  });
});
