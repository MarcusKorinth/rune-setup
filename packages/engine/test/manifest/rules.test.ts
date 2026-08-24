import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { ManifestError } from '../../src/errors.js';
import { parseManifestText } from '../../src/manifest/index.js';
import { environmentName } from '../../src/manifest/v1/rules.js';

const HEAD = ['schemaVersion: 1', 'product:', '  name: Example', '  version: 1.0.0'];

/** Parses and returns the reported messages, so a rule can be asserted by what it says. */
function messagesOf(lines: readonly string[]): string[] {
  try {
    parseManifestText([...HEAD, ...lines, ''].join('\n'), 'installer.yaml');
  } catch (error) {
    if (error instanceof ManifestError) {
      return error.issues.map((issue) => issue.message);
    }
    throw error;
  }
  throw new Error('expected the manifest to be rejected');
}

function codeOf(lines: readonly string[]): string {
  try {
    parseManifestText([...HEAD, ...lines, ''].join('\n'), 'installer.yaml');
  } catch (error) {
    return (error as ManifestError).code;
  }
  throw new Error('expected the manifest to be rejected');
}

describe('input rules', () => {
  it('rejects ids that cannot be written as ${...}', () => {
    expect(
      messagesOf(['inputs:', '  "install dir":', '    type: text', 'steps: []']),
    ).toContainEqual(expect.stringContaining('input id "install dir" must match'));
  });

  it.each(['home', 'temp', 'platform', 'manifestDir', 'product', 'env', 'rune', 'steps'])(
    'rejects the id "%s", which shadows a built-in variable',
    (name) => {
      expect(messagesOf(['inputs:', `  ${name}:`, '    type: text', 'steps: []'])).toContainEqual(
        `input id "${name}" collides with the built-in variable \${${name}}`,
      );
    },
  );

  it('accepts an id that merely resembles a built-in', () => {
    expect(() =>
      parseManifestText(
        [...HEAD, 'inputs:', '  homeDirectory:', '    type: text', 'steps: []', ''].join('\n'),
        'installer.yaml',
      ),
    ).not.toThrow();
  });

  it('rejects two inputs that would read the same environment variable', () => {
    const messages = messagesOf([
      'inputs:',
      '  api_token:',
      '    type: text',
      '  API_TOKEN:',
      '    type: text',
      'steps: []',
    ]);

    expect(messages).toContainEqual(
      'inputs "api_token" and "API_TOKEN" both read the environment variable RUNE_INPUT_API_TOKEN — rename one of them',
    );
  });

  it('derives the environment variable name the way the resolution chain does', () => {
    expect(environmentName('installDirectory')).toBe('RUNE_INPUT_INSTALLDIRECTORY');
    expect(environmentName('api_token')).toBe('RUNE_INPUT_API_TOKEN');
  });

  it('rejects an empty option list', () => {
    expect(
      messagesOf(['inputs:', '  environment:', '    type: select', '    options: []', 'steps: []']),
    ).toContainEqual('inputs.environment.options must not be empty');
  });

  it('rejects repeated option values because scripts receive the value', () => {
    const messages = messagesOf([
      'inputs:',
      '  environment:',
      '    type: select',
      '    options:',
      '      - dev',
      '      - value: dev',
      '        label: Development',
      'steps: []',
    ]);

    expect(messages[0]).toContain('inputs.environment.options[1] repeats the option value "dev"');
  });

  it('rejects a default that is not one of the option values', () => {
    expect(
      messagesOf([
        'inputs:',
        '  environment:',
        '    type: select',
        '    options: [dev, prod]',
        '    default: staging',
        'steps: []',
      ]),
    ).toContainEqual(
      'inputs.environment.default is "staging", which is not one of the option values ("dev", "prod")',
    );
  });

  it('checks every entry of a multiselect default', () => {
    expect(
      messagesOf([
        'inputs:',
        '  tools:',
        '    type: multiselect',
        '    options: [git, docker]',
        '    default: [git, podman]',
        'steps: []',
      ]),
    ).toContainEqual(
      'inputs.tools.default is "podman", which is not one of the option values ("git", "docker")',
    );
  });

  it('matches option values against labels, never the other way round', () => {
    expect(
      messagesOf([
        'inputs:',
        '  environment:',
        '    type: select',
        '    options:',
        '      - value: prod',
        '        label: Production',
        '    default: Production',
        'steps: []',
      ]),
    ).toContainEqual(
      'inputs.environment.default is "Production", which is not one of the option values ("prod")',
    );
  });

  it('rejects a pattern that is not an ECMAScript regular expression', () => {
    const messages = messagesOf([
      'inputs:',
      '  port:',
      '    type: text',
      '    pattern: "(?P<port>[0-9]+)"',
      'steps: []',
    ]);

    expect(messages[0]).toContain('inputs.port.pattern is not a valid regular expression');
    expect(messages[0]).toContain('ECMAScript syntax');
  });

  it('accepts a valid pattern', () => {
    expect(() =>
      parseManifestText(
        [
          ...HEAD,
          'inputs:',
          '  port:',
          '    type: text',
          '    pattern: "[0-9]{2,5}"',
          'steps: []',
          '',
        ].join('\n'),
        'installer.yaml',
      ),
    ).not.toThrow();
  });

  it('rejects a patternHint that can never be shown', () => {
    expect(
      messagesOf([
        'inputs:',
        '  port:',
        '    type: text',
        '    patternHint: digits only',
        'steps: []',
      ]),
    ).toContainEqual('inputs.port.patternHint has no effect without inputs.port.pattern');
  });

  it('reports semantic problems as RUNE-104', () => {
    expect(codeOf(['inputs:', '  home:', '    type: text', 'steps: []'])).toBe('RUNE-104');
  });

  it('collects every problem instead of stopping at the first', () => {
    const messages = messagesOf([
      'inputs:',
      '  home:',
      '    type: text',
      '  port:',
      '    type: text',
      '    patternHint: digits only',
      'steps: []',
    ]);

    expect(messages).toEqual([
      'input id "home" collides with the built-in variable ${home}',
      'inputs.port.patternHint has no effect without inputs.port.pattern',
    ]);
  });
});

describe('step rules', () => {
  it('rejects step ids that do not match the documented shape', () => {
    expect(
      messagesOf(['steps:', '  - id: Install-App', '    run:', '      command: pwsh']),
    ).toContainEqual('steps[0].id "Install-App" must match ^[a-z][a-z0-9-]*$');
  });

  it('rejects duplicate step ids and names the first occurrence', () => {
    const messages = messagesOf([
      'steps:',
      '  - id: install',
      '    run:',
      '      command: a',
      '  - id: install',
      '    run:',
      '      command: b',
    ]);

    expect(messages[0]).toContain('steps[1].id "install" is already used by steps[0]');
  });

  it('rejects a platform mapping without any platform', () => {
    expect(messagesOf(['steps:', '  - id: install', '    run: {}'])).toContainEqual(
      expect.stringContaining('steps[0].run has no platform block'),
    );
  });

  it('accepts a platform mapping with only one platform', () => {
    expect(() =>
      parseManifestText(
        [
          ...HEAD,
          'steps:',
          '  - id: install',
          '    run:',
          '      windows:',
          '        command: pwsh',
          '',
        ].join('\n'),
        'installer.yaml',
      ),
    ).not.toThrow();
  });
});

describe('gui asset rules', () => {
  const manifest = (...gui: readonly string[]): string =>
    [...HEAD, 'gui:', ...gui, 'steps: []', ''].join('\n');

  /** A manifest directory holding `assets/logo.png`, so present and absent can be told apart. */
  function projectDir(): string {
    const dir = mkdtempSync(join(tmpdir(), 'rune-gui-'));
    mkdirSync(join(dir, 'assets'));
    writeFileSync(join(dir, 'assets', 'logo.png'), '');
    return dir;
  }

  it('checks asset paths only when the caller asks for it', () => {
    expect(() =>
      parseManifestText(manifest('  logo: assets/missing.png'), 'installer.yaml'),
    ).not.toThrow();
  });

  it('accepts assets that exist relative to the manifest directory', () => {
    expect(() =>
      parseManifestText(manifest('  logo: assets/logo.png'), 'installer.yaml', {
        checkAssetFiles: true,
        manifestDir: projectDir(),
      }),
    ).not.toThrow();
  });

  it('resolves relative assets against the manifest, not the working directory', () => {
    const dir = projectDir();
    // The same relative path exists next to the manifest and not in the process directory.
    expect(() =>
      parseManifestText(manifest('  logo: assets/logo.png'), 'installer.yaml', {
        checkAssetFiles: true,
        manifestDir: dir,
      }),
    ).not.toThrow();
    expect(() =>
      parseManifestText(manifest('  logo: assets/logo.png'), 'installer.yaml', {
        checkAssetFiles: true,
        manifestDir: join(dir, 'assets'),
      }),
    ).toThrow(/does not exist/);
  });

  it('accepts an absolute asset path', () => {
    const dir = projectDir();
    expect(() =>
      parseManifestText(
        manifest(`  banner: ${join(dir, 'assets', 'logo.png')}`),
        'installer.yaml',
        {
          checkAssetFiles: true,
          manifestDir: tmpdir(),
        },
      ),
    ).not.toThrow();
  });

  it('rejects a path that is a directory rather than a file', () => {
    expect(() =>
      parseManifestText(manifest('  logo: assets'), 'installer.yaml', {
        checkAssetFiles: true,
        manifestDir: projectDir(),
      }),
    ).toThrow(/gui\.logo points at "assets", which is not a file/);
  });

  it('rejects an empty asset path instead of silently accepting the directory', () => {
    expect(() =>
      parseManifestText(manifest('  logo: ""'), 'installer.yaml', {
        checkAssetFiles: true,
        manifestDir: projectDir(),
      }),
    ).toThrow(/gui\.logo is empty/);
  });

  it('reports a path that cannot be read at all as a manifest error, never as an internal one', () => {
    // `throwIfNoEntry` covers a missing entry and nothing else: a NUL byte makes the stat throw
    // on every platform, and a path an author wrote must never come back as "a bug in RUNE".
    let thrown: unknown;
    try {
      parseManifestText(manifest('  logo: "assets\\0logo.png"'), 'installer.yaml', {
        checkAssetFiles: true,
        manifestDir: projectDir(),
      });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(ManifestError);
    expect((thrown as ManifestError).code).toBe('RUNE-104');
    expect((thrown as ManifestError).message).toMatch(/gui\.logo points at .*cannot be read/);
  });

  it('reports semantic problems in source order, whatever order the rules run in', () => {
    // Assets are checked last and inputs first, but the author reads the document top to
    // bottom — and the first problem's position is what the error as a whole points at.
    let thrown: unknown;
    try {
      parseManifestText(
        [
          ...HEAD,
          'gui:',
          '  logo: missing.png',
          'inputs:',
          '  home:',
          '    type: text',
          'steps: []',
          '',
        ].join('\n'),
        'installer.yaml',
        { checkAssetFiles: true, manifestDir: projectDir() },
      );
    } catch (error) {
      thrown = error;
    }

    const error = thrown as ManifestError;
    expect(error.issues.map((issue) => issue.location?.line)).toEqual([6, 8]);
    expect(error.location).toMatchObject({ line: 6 });
  });

  it('reports every declared asset that is missing, by name', () => {
    let thrown: unknown;
    try {
      parseManifestText(
        manifest('  logo: assets/logo.png', '  banner: assets/missing.png', '  theme: theme.css'),
        'installer.yaml',
        { checkAssetFiles: true, manifestDir: projectDir() },
      );
    } catch (error) {
      thrown = error;
    }

    expect((thrown as ManifestError).issues.map((issue) => issue.message)).toEqual([
      'gui.banner points at "assets/missing.png", which does not exist (resolved against the manifest\'s directory)',
      'gui.theme points at "theme.css", which does not exist (resolved against the manifest\'s directory)',
    ]);
  });
});
