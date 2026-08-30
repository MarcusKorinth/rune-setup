import { describe, expect, it } from 'vitest';

import { formatIssues, ManifestError } from '../../src/errors.js';
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
        'rune.summary.proceedToken: weiter',
        'rune.summary.cancelToken: abbrechen',
        '',
      ].join('\n'),
      'locales/de.yaml',
      'de',
      MANIFEST,
    );

    expect(overlay.locale).toBe('de');
    expect(overlay.entries.get('steps.install.title')).toBe('Installieren');
    expect(overlay.entries.get('rune.button.next')).toBe('Weiter');
  });

  it('rejects equal effective summary tokens at the conflicting key', () => {
    const error = overlayError([
      'rune.summary.proceedToken: weiter',
      'rune.summary.cancelToken: weiter',
    ]);

    expect(error.code).toBe('RUNE-104');
    expect(formatIssues(error.issues)).toBe(
      'locales/de.yaml:2:1: rune.summary.cancelToken must differ from ' +
        'rune.summary.proceedToken after trimming and case normalization',
    );
  });

  it('compares summary tokens after trimming and case normalization', () => {
    const error = overlayError([
      'rune.summary.proceedToken: " Weiter "',
      'rune.summary.cancelToken: WEITER',
    ]);

    expect(formatIssues(error.issues)).toBe(
      'locales/de.yaml:2:1: rune.summary.cancelToken must differ from ' +
        'rune.summary.proceedToken after trimming and case normalization',
    );
  });

  it('rejects empty and whitespace-only summary tokens at their keys', () => {
    const error = overlayError([
      'rune.summary.proceedToken: ""',
      'rune.summary.cancelToken: "   "',
    ]);

    expect(formatIssues(error.issues)).toBe(
      'locales/de.yaml:1:1: rune.summary.proceedToken must not be empty or whitespace\n' +
        'locales/de.yaml:2:1: rune.summary.cancelToken must not be empty or whitespace',
    );
  });

  it.each([
    ['rune.summary.proceedToken', '"weiter\\njetzt"'],
    ['rune.summary.proceedToken', '"weiter\\rjetzt"'],
    ['rune.summary.cancelToken', '"abbrechen\\njetzt"'],
    ['rune.summary.cancelToken', '"abbrechen\\rjetzt"'],
  ])('rejects escaped line breaks in %s', (key, value) => {
    const error = overlayError([`${key}: ${value}`]);

    expect(error.code).toBe('RUNE-104');
    expect(formatIssues(error.issues)).toBe(`locales/de.yaml:1:1: ${key} must be a single line`);
  });

  it('rejects a YAML multiline summary token with an internal line break', () => {
    const error = overlayError([
      'rune.summary.proceedToken: |-',
      '  weiter',
      '  jetzt',
      'rune.summary.cancelToken: abbrechen',
    ]);

    expect(error.code).toBe('RUNE-104');
    expect(formatIssues(error.issues)).toBe(
      'locales/de.yaml:1:1: rune.summary.proceedToken must be a single line',
    );
  });

  it('rejects numeric summary tokens because numbers select values to change', () => {
    const error = overlayError([
      'rune.summary.proceedToken: "1"',
      'rune.summary.cancelToken: "02"',
    ]);

    expect(formatIssues(error.issues)).toBe(
      'locales/de.yaml:1:1: rune.summary.proceedToken must not be numeric because a number ' +
        'selects a value to change\n' +
        'locales/de.yaml:2:1: rune.summary.cancelToken must not be numeric because a number ' +
        'selects a value to change',
    );
  });

  it('rejects tokens that shadow the fixed alias of the opposite action', () => {
    const error = overlayError([
      'rune.summary.proceedToken: " CANCEL "',
      'rune.summary.cancelToken: Proceed',
    ]);

    expect(formatIssues(error.issues)).toBe(
      'locales/de.yaml:1:1: rune.summary.proceedToken must not be "cancel" because it is the ' +
        'fixed alias for the cancel action\n' +
        'locales/de.yaml:2:1: rune.summary.cancelToken must not be "proceed" because it is the ' +
        'fixed alias for the proceed action',
    );
  });

  it('compares a partial override with the effective English default', () => {
    const error = overlayError(['rune.summary.proceedToken: c']);

    expect(formatIssues(error.issues)).toBe(
      'locales/de.yaml:1:1: rune.summary.proceedToken must differ from ' +
        'rune.summary.cancelToken after trimming and case normalization',
    );
  });

  it('accepts the fixed alias for the same action', () => {
    const overlay = loadOverlayText(
      'rune.summary.proceedToken: proceed\nrune.summary.cancelToken: cancel\n',
      'locales/de.yaml',
      'de',
      MANIFEST,
    );

    expect(overlay.entries.get('rune.summary.proceedToken')).toBe('proceed');
    expect(overlay.entries.get('rune.summary.cancelToken')).toBe('cancel');
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
    expect(overlay.entries.size).toBe(0);
  });
});

function overlayError(lines: readonly string[]): ManifestError {
  try {
    loadOverlayText([...lines, ''].join('\n'), 'locales/de.yaml', 'de', MANIFEST);
  } catch (error) {
    expect(error).toBeInstanceOf(ManifestError);
    return error as ManifestError;
  }
  throw new Error('expected the overlay to be rejected');
}
