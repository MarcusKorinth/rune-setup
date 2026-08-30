import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { validateManifest } from '../../src/manifest/index.js';

const HEAD = ['schemaVersion: 1', 'product:', '  name: Example', '  version: "1.0.0"'];
const DEFAULT_LOCALE = { environment: {}, systemLocale: 'C' } as const;

function manifestFile(...lines: readonly string[]): string {
  const dir = mkdtempSync(join(tmpdir(), 'rune-validate-'));
  const path = join(dir, 'installer.yaml');
  writeFileSync(path, [...HEAD, ...lines, ''].join('\n'));
  return path;
}

describe('validateManifest', () => {
  it('returns the manifest it accepted', () => {
    const report = validateManifest(manifestFile('steps: []'), DEFAULT_LOCALE);

    expect(report.manifest.product.name).toBe('Example');
    expect(report.locales).toEqual([]);
    expect(report.environment).toEqual([]);
  });

  it('rejects an invalid explicit locale after accepting the manifest', () => {
    expect(() =>
      validateManifest(manifestFile('steps: []'), { locale: 'definitely_invalid' }),
    ).toThrow(/invalid locale "definitely_invalid" from --locale/);
  });

  it.each(['de-DE', 'de_DE', 'C', 'POSIX'])('accepts explicit locale %s', (locale) => {
    expect(() =>
      validateManifest(manifestFile('steps: []'), { ...DEFAULT_LOCALE, locale }),
    ).not.toThrow();
  });

  it('treats an empty explicit locale like an omitted locale', () => {
    expect(() =>
      validateManifest(manifestFile('steps: []'), { ...DEFAULT_LOCALE, locale: '' }),
    ).not.toThrow();
  });

  it('reports manifest errors before an invalid explicit locale', () => {
    expect(() =>
      validateManifest(manifestFile('product: invalid', 'steps: []'), {
        ...DEFAULT_LOCALE,
        locale: 'definitely_invalid',
      }),
    ).toThrow(/duplicate key "product"/);
  });

  it('validates every locale overlay and reports its canonical locale', () => {
    const file = manifestFile(
      'steps:',
      '  - id: install',
      '    title: Install',
      '    run:',
      '      command: install',
    );
    const localesDir = join(dirname(file), 'locales');
    mkdirSync(localesDir);
    writeFileSync(join(localesDir, 'de.yaml'), 'steps.install.title: Installieren\n');

    const report = validateManifest(file, DEFAULT_LOCALE);

    expect(report.locales).toEqual(['de']);
  });

  it('rejects a broken unselected locale overlay after loading the selected one', () => {
    const file = manifestFile('steps: []');
    const localesDir = join(dirname(file), 'locales');
    mkdirSync(localesDir);
    writeFileSync(join(localesDir, 'de.yaml'), 'rune.button.next: Weiter\n');
    writeFileSync(join(localesDir, 'fr.yaml'), 'unknown.key: Invalide\n');

    expect(() => validateManifest(file, { ...DEFAULT_LOCALE, locale: 'de-DE' })).toThrow(
      /unknown\.key does not name a localizable text of this manifest/,
    );
  });

  it.each([
    {
      source: 'explicit option over environment and system',
      options: { locale: 'de-DE', environment: { RUNE_LOCALE: 'fr-FR' }, systemLocale: 'fr-FR' },
      locale: 'de-DE',
      overlayLocale: 'de-DE',
      summary: 'EXACT Example',
    },
    {
      source: 'environment over system with language fallback',
      options: { environment: { RUNE_LOCALE: 'de-AT' }, systemLocale: 'fr-FR' },
      locale: 'de-AT',
      overlayLocale: 'de',
      summary: 'LANGUAGE Example',
    },
    {
      source: 'system locale with language fallback',
      options: { environment: {}, systemLocale: 'fr-FR' },
      locale: 'fr-FR',
      overlayLocale: 'fr',
      summary: 'SYSTEM Example',
    },
  ])(
    'resolves validate strings from the $source',
    ({ options, locale, overlayLocale, summary }) => {
      const file = manifestFile('steps: []');
      const localesDir = join(dirname(file), 'locales');
      mkdirSync(localesDir);
      writeFileSync(join(localesDir, 'de-DE.yaml'), 'rune.validate.valid: EXACT {productName}\n');
      writeFileSync(join(localesDir, 'de.yaml'), 'rune.validate.valid: LANGUAGE {productName}\n');
      writeFileSync(join(localesDir, 'fr.yaml'), 'rune.validate.valid: SYSTEM {productName}\n');

      const report = validateManifest(file, options);

      expect(report.strings.locale).toBe(locale);
      expect(report.strings.overlayLocale).toBe(overlayLocale);
      expect(report.strings.chrome('rune.validate.valid', { productName: 'Example' })).toBe(
        summary,
      );
    },
  );

  it('lists every environment variable the manifest reads, sorted, with its places', () => {
    const report = validateManifest(
      manifestFile(
        'inputs:',
        '  root:',
        '    type: directory',
        '    default: "${env.HOME}/app"',
        'steps:',
        '  - id: build',
        '    run:',
        '      command: "${env.JAVA_HOME}/bin/java"',
        '      args: ["-Duser=${env.USER}"]',
        '      env:',
        '        PATH_COPY: "${env.PATH}"',
        '  - id: again',
        '    run:',
        '      command: "${env.JAVA_HOME}/bin/java"',
      ),
      DEFAULT_LOCALE,
    );

    expect(report.environment.map((use) => use.name)).toEqual([
      'HOME',
      'JAVA_HOME',
      'PATH',
      'USER',
    ]);
    // A variable read twice is reported once, with both places.
    const java = report.environment.find((use) => use.name === 'JAVA_HOME');
    expect(java?.locations).toHaveLength(2);
    expect(java?.locations[0]).toMatchObject({ line: 12, column: 7 });
    expect(java?.locations[1]).toMatchObject({ line: 18, column: 7 });
  });

  it('sees the environment a condition reads, not only the commands', () => {
    const report = validateManifest(
      manifestFile(
        'steps:',
        '  - id: a',
        '    when: "${env.CI} == \'true\'"',
        '    run:',
        '      command: x',
      ),
      DEFAULT_LOCALE,
    );

    expect(report.environment.map((use) => use.name)).toEqual(['CI']);
  });

  it('audits a manifest with many inputs and many references without a quadratic slowdown', () => {
    const inputs = Array.from({ length: 400 }, (_unused, index) => [
      `  input${index}:`,
      '    type: text',
      '    default: d',
    ]).flat();
    const args = Array.from(
      { length: 5_000 },
      (_unused, index) => `        - "\${env.VAR_${index % 5}}-\${input0}"`,
    );
    const file = manifestFile(
      'inputs:',
      ...inputs,
      'steps:',
      '  - id: build',
      '    run:',
      '      command: echo',
      '      args:',
      ...args,
    );
    const started = Date.now();

    const report = validateManifest(file, DEFAULT_LOCALE);

    // Reading the declared ids once per reference instead of once per audit is what this
    // shape costs: at 400 inputs it took ~100 ms of pure list building, and it grew with
    // both the inputs and the references.
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(report.environment.map((use) => use.name)).toEqual([
      'VAR_0',
      'VAR_1',
      'VAR_2',
      'VAR_3',
      'VAR_4',
    ]);
  });

  it('checks gui assets, which is the whole point of running validate', () => {
    expect(() =>
      validateManifest(manifestFile('gui:', '  logo: missing.png', 'steps: []'), DEFAULT_LOCALE),
    ).toThrow(/gui\.logo points at "missing\.png", which does not exist/);
  });

  it('lets the caller turn the asset check off', () => {
    expect(() =>
      validateManifest(manifestFile('gui:', '  logo: missing.png', 'steps: []'), {
        ...DEFAULT_LOCALE,
        checkAssetFiles: false,
      }),
    ).not.toThrow();
  });
});
