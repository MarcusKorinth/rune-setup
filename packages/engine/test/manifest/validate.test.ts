import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { validateManifest } from '../../src/manifest/index.js';

const HEAD = ['schemaVersion: 1', 'product:', '  name: Example', '  version: "1.0.0"'];

function manifestFile(...lines: readonly string[]): string {
  const dir = mkdtempSync(join(tmpdir(), 'rune-validate-'));
  const path = join(dir, 'installer.yaml');
  writeFileSync(path, [...HEAD, ...lines, ''].join('\n'));
  return path;
}

describe('validateManifest', () => {
  it('returns the manifest it accepted', () => {
    const report = validateManifest(manifestFile('steps: []'));

    expect(report.manifest.product.name).toBe('Example');
    expect(report.environment).toEqual([]);
  });

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
    );

    expect(report.environment.map((use) => use.name)).toEqual(['CI']);
  });

  it('checks gui assets, which is the whole point of running validate', () => {
    expect(() =>
      validateManifest(manifestFile('gui:', '  logo: missing.png', 'steps: []')),
    ).toThrow(/gui\.logo points at "missing\.png", which does not exist/);
  });

  it('lets the caller turn the asset check off', () => {
    expect(() =>
      validateManifest(manifestFile('gui:', '  logo: missing.png', 'steps: []'), {
        checkAssetFiles: false,
      }),
    ).not.toThrow();
  });
});
