import { describe, expect, it } from 'vitest';

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
    'inputs:',
    '  target:',
    '    type: directory',
    '    title: Install directory',
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

describe('the resolved string table', () => {
  it('serves the defaults when no overlay is loaded', () => {
    const strings = resolveStrings({ manifest: MANIFEST });

    expect(strings.locale).toBeUndefined();
    expect(strings.inputTitle('target')).toBe('Install directory');
    expect(strings.inputTitle('environment')).toBe('environment');
    expect(strings.optionLabel('environment', 'production')).toBe('production');
    expect(strings.stepTitle('install')).toBe('Install');
    expect(strings.stepTitle('cleanup')).toBe('cleanup');
    expect(strings.chrome('rune.button.next')).toBe('Next');
  });

  it('overrides per key and fills the gaps from the defaults', () => {
    const overlay = loadOverlayText(
      [
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
    expect(strings.stepTitle('install')).toBe('Installieren');
    expect(strings.inputTitle('target')).toBe('Installationsverzeichnis');
    expect(strings.chrome('rune.button.next')).toBe('Weiter');
    expect(strings.chrome('rune.button.back')).toBe('Back');
    expect(strings.stepTitle('cleanup')).toBe('cleanup');
    expect(strings.entries.get('steps.install.title')).toBe('Installieren');
  });

  it('fills chrome placeholders without re-scanning the substituted text', () => {
    const strings = resolveStrings({ manifest: MANIFEST });

    expect(strings.chrome('rune.progress.step', { index: 2, total: 5, title: '{index}' })).toBe(
      'Step 2 of 5: {index}',
    );
    expect(formatChrome('no placeholders')).toBe('no placeholders');
  });
});
