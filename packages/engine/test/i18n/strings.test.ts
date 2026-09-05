import { describe, expect, it } from 'vitest';

import { InternalError } from '../../src/errors.js';
import { SecretRegistry } from '../../src/engine/secrets.js';
import { formatChrome } from '../../src/i18n/catalog.js';
import { loadOverlayText } from '../../src/i18n/overlay.js';
import {
  formatSessionTerminalLine,
  projectStringsForSink,
  resolveStrings,
  type StringTable,
} from '../../src/i18n/strings.js';
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
    const strings = resolveStrings({ manifest: MANIFEST, locale: undefined });

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
        'inputs.environment.options.production.label: Produktivumgebung',
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
    expect(strings.optionLabel('environment', 'production')).toBe('Produktivumgebung');
    expect(strings.stepTitle('install')).toBe('Installieren');
    expect(strings.inputTitle('target')).toBe('Installationsverzeichnis');
    expect(strings.chrome('rune.button.next')).toBe('Weiter');
    expect(strings.chrome('rune.button.back')).toBe('Back');
    expect(strings.stepTitle('cleanup')).toBe('cleanup');
    expect(strings.entries['steps.install.title']).toBe('Installieren');
  });

  it('returns undefined for optional texts without manifest fallbacks', () => {
    const strings = resolveStrings({
      manifest: MANIFEST_WITHOUT_OPTIONAL_FALLBACKS,
      locale: undefined,
    });

    expect(strings.productDescription()).toBeUndefined();
    expect(strings.inputDescription('target')).toBeUndefined();
    expect(strings.patternHint('target')).toBeUndefined();
    expect(strings.windowTitle()).toBeUndefined();
  });

  it('keeps the table and its entry snapshot immutable at runtime', () => {
    const strings = resolveStrings({ manifest: MANIFEST, locale: undefined });

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

  it('masks raw and control-escaped secrets in an authenticated terminal line', () => {
    const source = resolveStrings({ manifest: MANIFEST, locale: undefined });
    const secrets = new SecretRegistry();
    secrets.register('raw-secret');
    secrets.register(String.raw`\u001b`);
    const strings = projectStringsForSink(source, secrets);

    expect(formatSessionTerminalLine(strings, 'raw-secret and \u001b')).toBe('*** and ***');
    expect(
      formatSessionTerminalLine(strings, strings.chrome('rune.warning', { message: '\u001b' })),
    ).toBe('***');
  });

  it('projects every dynamic accessor through its JSON string content', () => {
    const quoted = '""';
    const manifest = parseManifestText(
      [
        'schemaVersion: 1',
        'product:',
        '  name: Example',
        '  version: "1.0.0"',
        `  description: ${JSON.stringify(quoted)}`,
        'gui:',
        `  windowTitle: ${JSON.stringify(quoted)}`,
        'inputs:',
        '  choice:',
        '    type: select',
        `    title: ${JSON.stringify(quoted)}`,
        `    description: ${JSON.stringify(quoted)}`,
        '    options:',
        `      - value: exact-option-identity`,
        `        label: ${JSON.stringify(quoted)}`,
        'steps:',
        '  - id: install',
        `    title: ${JSON.stringify(quoted)}`,
        '    run:',
        '      command: node',
      ].join('\n'),
      'structured-strings.yaml',
    );
    const registry = new SecretRegistry();
    registry.register(String.raw`\"\"`);
    const strings = projectStringsForSink(
      resolveStrings({ manifest, locale: undefined }),
      registry,
    );

    expect(strings.productDescription()).toBe('***');
    expect(strings.windowTitle()).toBe('***');
    expect(strings.inputTitle('choice')).toBe('***');
    expect(strings.inputDescription('choice')).toBe('***');
    expect(strings.optionLabel('choice', 'exact-option-identity')).toBe('***');
    expect(strings.stepTitle('install')).toBe('***');
    expect(strings.chrome('rune.warning', { message: quoted })).toBe('***');
    expect(Object.values(strings.entries)).not.toContain(quoted);
    expect(strings.optionLabel('choice', 'missing-option-identity')).toBe(
      'missing-option-identity',
    );
  });

  it.each([
    ['raw table', () => resolveStrings({ manifest: MANIFEST, locale: undefined })],
    [
      'spread copy',
      () => {
        const source = resolveStrings({ manifest: MANIFEST, locale: undefined });
        return { ...projectStringsForSink(source, new SecretRegistry()) };
      },
    ],
    [
      'prototype clone',
      () => {
        const source = resolveStrings({ manifest: MANIFEST, locale: undefined });
        return Object.create(projectStringsForSink(source, new SecretRegistry())) as StringTable;
      },
    ],
    [
      'proxy',
      () => {
        const source = resolveStrings({ manifest: MANIFEST, locale: undefined });
        return new Proxy(projectStringsForSink(source, new SecretRegistry()), {});
      },
    ],
  ] as const)('rejects an unauthenticated %s for terminal projection', (_name, makeTable) => {
    const strings = makeTable() as StringTable;

    expect(() => formatSessionTerminalLine(strings, 'safe')).toThrow(
      'terminal rendering requires the exact StringTable returned by Session.getStrings',
    );
  });

  it('fills chrome placeholders without re-scanning the substituted text', () => {
    const strings = resolveStrings({ manifest: MANIFEST, locale: undefined });

    expect(strings.chrome('rune.progress.step', { index: 2, total: 5, title: '{index}' })).toBe(
      'Step 2 of 5: {index}',
    );
    expect(formatChrome('no placeholders')).toBe('no placeholders');
  });

  it('rejects unknown chrome keys at runtime', () => {
    const strings = resolveStrings({ manifest: MANIFEST, locale: undefined });
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

  it('accepts an overlay that exactly matches the selected locale', () => {
    const overlay = loadOverlayText(
      'steps.install.title: Installieren\n',
      'locales/de-DE.yaml',
      'de-DE',
      MANIFEST,
    );

    const strings = resolveStrings({ manifest: MANIFEST, locale: 'de-DE', overlay });

    expect(strings.overlayLocale).toBe('de-DE');
    expect(strings.stepTitle('install')).toBe('Installieren');
  });

  it.each([
    { selected: undefined, overlayLocale: 'de', serves: 'the built-in defaults' },
    { selected: 'fr-FR', overlayLocale: 'de', serves: 'selected locale "fr-FR"' },
    { selected: 'de', overlayLocale: 'de-DE', serves: 'selected locale "de"' },
    { selected: 'de-DE', overlayLocale: 'de-AT', serves: 'selected locale "de-DE"' },
  ])('rejects overlay $overlayLocale for $serves', ({ selected, overlayLocale, serves }) => {
    const overlay = loadOverlayText(
      'steps.install.title: Installieren\n',
      `locales/${overlayLocale}.yaml`,
      overlayLocale,
      MANIFEST,
    );

    expect(() => resolveStrings({ manifest: MANIFEST, locale: selected, overlay })).toThrow(
      `locale overlay "${overlayLocale}" cannot serve ${serves}`,
    );
  });

  it('rejects an overlay loaded for a different manifest instance', () => {
    const otherManifest = parseManifestText(
      [
        'schemaVersion: 1',
        'product:',
        '  name: Other',
        '  version: "1.0.0"',
        'steps:',
        '  - id: install',
        '    run:',
        '      command: node',
        '',
      ].join('\n'),
      'other.yaml',
    );
    const overlay = loadOverlayText(
      'rune.button.next: Weiter\n',
      'locales/de.yaml',
      'de',
      MANIFEST,
    );

    expect(() => resolveStrings({ manifest: otherManifest, locale: 'de', overlay })).toThrow(
      'the locale overlay belongs to a different manifest',
    );
  });

  it('rejects a structural copy of an authentic overlay', () => {
    const overlay = loadOverlayText(
      'steps.install.title: Installieren\n',
      'locales/de.yaml',
      'de',
      MANIFEST,
    );

    expect(() =>
      resolveStrings({ manifest: MANIFEST, locale: 'de', overlay: { ...overlay } }),
    ).toThrow('the locale overlay was not created by loadOverlay or loadOverlayText');
  });
});
