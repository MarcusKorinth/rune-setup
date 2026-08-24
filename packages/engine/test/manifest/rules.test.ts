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

  it('rejects ids that shadow a built-in variable', () => {
    expect(messagesOf(['inputs:', '  home:', '    type: text', 'steps: []'])).toContainEqual(
      'input id "home" collides with the built-in variable ${home}',
    );
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
      '  environment:',
      '    type: select',
      '    options: []',
      'steps: []',
    ]);

    expect(messages.length).toBeGreaterThanOrEqual(2);
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
  const lines = [...HEAD, 'gui:', '  logo: assets/missing.png', 'steps: []', ''].join('\n');

  it('checks asset paths only when the caller asks for it', () => {
    expect(() => parseManifestText(lines, 'installer.yaml')).not.toThrow();
  });

  it('reports assets that do not exist next to the manifest', () => {
    let thrown: unknown;
    try {
      parseManifestText(lines, 'installer.yaml', {
        checkAssetFiles: true,
        manifestDir: process.cwd(),
      });
    } catch (error) {
      thrown = error;
    }

    expect((thrown as ManifestError).issues[0]?.message).toContain(
      'gui.logo points at "assets/missing.png", which does not exist',
    );
  });
});
