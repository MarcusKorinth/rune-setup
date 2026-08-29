import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { createRuntimeContext, type RuntimeContext } from '../../src/engine/context.js';
import {
  parseValuesFile,
  resolveInputs,
  type Resolution,
  type ResolveInputsOptions,
  type ValuesDocument,
} from '../../src/engine/inputs.js';
import { SecretRegistry, SecretString } from '../../src/engine/secrets.js';
import type { InputValue } from '../../src/inputs/base.js';
import { exitCodeFor, InputError, ResolutionError } from '../../src/errors.js';
import { parseManifestText } from '../../src/manifest/index.js';
import type { ManifestV1 } from '../../src/manifest/v1/schema.js';

const HEAD = ['schemaVersion: 1', 'product:', '  name: Example', '  version: "1.0.0"'];

function manifestOf(...lines: readonly string[]): ManifestV1 {
  return parseManifestText([...HEAD, ...lines, 'steps: []', ''].join('\n'), 'installer.yaml');
}

function contextFor(
  manifest: ManifestV1,
  environment: Record<string, string> = {},
): RuntimeContext {
  return createRuntimeContext({
    manifestDir: '/project',
    product: manifest.product,
    platform: 'linux',
    environment,
  });
}

function resolve(
  manifest: ManifestV1,
  options: Omit<Partial<ResolveInputsOptions>, 'manifest' | 'context'> = {},
  environment: Record<string, string> = {},
): Resolution {
  return resolveInputs({
    manifest,
    context: contextFor(manifest, environment),
    ...options,
  });
}

/** The messages a resolution was rejected with. */
function problems(
  manifest: ManifestV1,
  options: Omit<Partial<ResolveInputsOptions>, 'manifest' | 'context'> = {},
  environment: Record<string, string> = {},
): string[] {
  try {
    resolve(manifest, options, environment);
  } catch (error) {
    return (error as InputError).issues.map((issue) => issue.message);
  }
  throw new Error('expected the values to be rejected');
}

/** The input error a resolution was rejected with. */
function inputError(
  manifest: ManifestV1,
  options: Omit<Partial<ResolveInputsOptions>, 'manifest' | 'context'> = {},
  environment: Record<string, string> = {},
): InputError {
  try {
    resolve(manifest, options, environment);
  } catch (error) {
    if (error instanceof InputError) {
      return error;
    }
    throw error;
  }
  throw new Error('expected the values to be rejected');
}

/** A values document without touching the disk. */
function values(file: string, entries: Record<string, unknown>): ValuesDocument {
  return {
    file,
    values: new Map(Object.entries(entries)),
    sourceMap: { location: () => undefined, keyLocation: () => undefined, best: () => undefined },
  } as unknown as ValuesDocument;
}

/** A parsed values document with its real source locations. */
function valuesFromFile(contents: string): ValuesDocument {
  const directory = mkdtempSync(join(tmpdir(), 'rune-values-'));
  const path = join(directory, 'values.yaml');
  writeFileSync(path, contents);
  return parseValuesFile(path, 'v.yaml');
}

const SIMPLE = ['inputs:', '  target:', '    type: text'];

describe('precedence', () => {
  const manifest = manifestOf(
    'inputs:',
    '  target:',
    '    type: text',
    '    default: from-default',
  );

  it('takes the manifest default when nothing else says otherwise', () => {
    expect(resolve(manifest).byId.get('target')).toMatchObject({
      value: 'from-default',
      source: 'default',
    });
  });

  it('lets a values file override the default', () => {
    expect(
      resolve(manifest, { values: [values('v.yaml', { target: 'from-values' })] }).byId.get(
        'target',
      ),
    ).toMatchObject({ value: 'from-values', source: 'values' });
  });

  it('lets a later values file override an earlier one', () => {
    const resolution = resolve(manifest, {
      values: [
        values('base.yaml', { target: 'base' }),
        values('overlay.yaml', { target: 'overlay' }),
      ],
    });

    expect(resolution.byId.get('target')?.value).toBe('overlay');
  });

  it('lets the environment override a values file', () => {
    const resolution = resolve(
      manifest,
      { values: [values('v.yaml', { target: 'from-values' })] },
      { RUNE_INPUT_TARGET: 'from-environment' },
    );

    expect(resolution.byId.get('target')).toMatchObject({
      value: 'from-environment',
      source: 'environment',
    });
  });

  it('lets --set override the environment, so a stray variable cannot defeat a flag', () => {
    const resolution = resolve(
      manifest,
      { overrides: new Map([['target', 'from-set']]) },
      { RUNE_INPUT_TARGET: 'from-environment' },
    );

    expect(resolution.byId.get('target')).toMatchObject({ value: 'from-set', source: 'set' });
  });

  it('lets an answer override everything, because it is the most specific of all', () => {
    const resolution = resolve(
      manifest,
      {
        overrides: new Map([['target', 'from-set']]),
        answers: new Map([['target', 'from-answer']]),
      },
      { RUNE_INPUT_TARGET: 'from-environment' },
    );

    expect(resolution.byId.get('target')).toMatchObject({ value: 'from-answer', source: 'answer' });
  });

  it('reads the environment variable an input id maps to', () => {
    const named = manifestOf('inputs:', '  install_dir:', '    type: directory');

    expect(
      resolve(named, {}, { RUNE_INPUT_INSTALL_DIR: '/opt/app' }).byId.get('install_dir')?.value,
    ).toBe('/opt/app');
  });

  it('uses the context environment for both input values and env references', () => {
    const shared = manifestOf(
      'inputs:',
      '  target:',
      '    type: text',
      '  logs:',
      '    type: directory',
      '    default: "${env.USER}/logs"',
    );
    const resolution = resolve(
      shared,
      {},
      {
        RUNE_INPUT_TARGET: 'from-environment',
        USER: 'marcus',
      },
    );

    expect(resolution.byId.get('target')?.value).toBe('from-environment');
    expect(resolution.byId.get('logs')?.value).toBe('marcus/logs');
  });
});

describe('resolved multiselect values', () => {
  it('cannot be changed through the layer-5 array after resolution', () => {
    const manifest = manifestOf(
      'inputs:',
      '  tools:',
      '    type: multiselect',
      '    options: [git, docker]',
    );
    const answer = ['git'];
    const resolution = resolve(manifest, { answers: new Map([['tools', answer]]) });
    const resolved = resolution.byId.get('tools')?.value;

    answer.push('podman');

    expect(resolved).toEqual(['git']);
    expect(Object.isFrozen(resolved)).toBe(true);
  });
});

describe('what is still missing', () => {
  it('lists a required input nobody answered', () => {
    expect(resolve(manifestOf(...SIMPLE)).missing).toEqual(['target']);
  });

  it('gives an optional input its empty value instead of calling it missing', () => {
    const manifest = manifestOf('inputs:', '  target:', '    type: text', '    required: false');
    const resolution = resolve(manifest);

    expect(resolution.missing).toEqual([]);
    expect(resolution.byId.get('target')).toMatchObject({ value: '', source: undefined });
  });

  it('does not treat an answered input as missing', () => {
    expect(resolve(manifestOf(...SIMPLE), { answers: new Map([['target', 'x']]) }).missing).toEqual(
      [],
    );
  });
});

describe('defaults are templates', () => {
  it('renders built-ins and the environment before the value is read', () => {
    const manifest = manifestOf(
      'inputs:',
      '  logs:',
      '    type: directory',
      '    default: "${manifestDir}/${env.USER}/logs"',
    );

    expect(resolve(manifest, {}, { USER: 'marcus' }).byId.get('logs')?.value).toBe(
      '/project/marcus/logs',
    );
  });

  it('renders a placeholder for a host value when another platform is previewed', () => {
    const manifest = manifestOf(
      'inputs:',
      '  logs:',
      '    type: directory',
      '    default: "${home}/logs"',
    );
    const preview = createRuntimeContext({
      manifestDir: '/project',
      product: manifest.product,
      platform: process.platform === 'win32' ? 'linux' : 'windows',
      environment: {},
    });

    const resolution = resolveInputs({ manifest, context: preview });

    expect(resolution.byId.get('logs')?.value).toMatch(/^<home@(linux|windows)>\/logs$/);
  });

  it('reports an environment variable a default needs and the machine does not have', () => {
    const manifest = manifestOf(
      'inputs:',
      '  logs:',
      '    type: directory',
      '    default: "${env.NOT_SET_ANYWHERE}/logs"',
    );

    let thrown: unknown;
    try {
      resolve(manifest);
    } catch (error) {
      thrown = error;
    }

    // A reference that resolves to nothing is a resolution error, not a value a user got
    // wrong: exit 5, not exit 4 (docs/architecture.md §6.1, §10, invariant 9).
    expect(thrown).toBeInstanceOf(ResolutionError);
    expect((thrown as ResolutionError).code).toBe('RUNE-301');
    expect(exitCodeFor(thrown)).toBe(5);
    expect((thrown as ResolutionError).message).toBe(
      'inputs.logs.default: the environment variable NOT_SET_ANYWHERE is not set',
    );
  });

  it('leaves a select default alone: it is an option value, not a template', () => {
    const manifest = manifestOf(
      'inputs:',
      '  environment:',
      '    type: select',
      '    options: [dev, prod]',
      '    default: prod',
    );

    expect(resolve(manifest).byId.get('environment')?.value).toBe('prod');
  });
});

describe('conditional inputs', () => {
  const manifest = manifestOf(
    'inputs:',
    '  installDatabase:',
    '    type: boolean',
    '    default: true',
    '  databasePort:',
    '    type: text',
    '    when: "${installDatabase}"',
    '    default: "5432"',
  );

  it('resolves an input whose condition holds', () => {
    expect(resolve(manifest).byId.get('databasePort')).toMatchObject({
      enabled: true,
      value: '5432',
    });
  });

  it('gives a disabled input its empty value and asks nothing of it', () => {
    const resolution = resolve(manifest, { overrides: new Map([['installDatabase', 'false']]) });

    expect(resolution.byId.get('databasePort')).toMatchObject({
      enabled: false,
      value: '',
      source: undefined,
      ignored: undefined,
    });
    expect(resolution.missing).toEqual([]);
    // The manifest default is not something anybody supplied for this run, so nothing was
    // discarded and there is nothing to warn about (§5 restricts the warning to layers 2–5).
    expect(resolution.warnings).toEqual([]);
  });

  it('ignores a value supplied for a disabled input, loudly and with its provenance', () => {
    const resolution = resolve(manifest, {
      overrides: new Map([
        ['installDatabase', 'false'],
        ['databasePort', '9999'],
      ]),
    });

    expect(resolution.byId.get('databasePort')).toMatchObject({
      enabled: false,
      value: '',
      source: undefined,
      ignored: 'set',
    });
    expect(resolution.warnings).toEqual([
      'databasePort was set from --set, but its condition is false — the value is ignored',
    ]);
  });

  it('honours the same value again once the condition turns true', () => {
    const resolution = resolve(manifest, {
      overrides: new Map([
        ['installDatabase', 'true'],
        ['databasePort', '9999'],
      ]),
    });

    expect(resolution.byId.get('databasePort')).toMatchObject({
      value: '9999',
      ignored: undefined,
    });
    expect(resolution.warnings).toEqual([]);
  });

  it('lets a condition read a built-in and the environment, not only other inputs', () => {
    const onPlatform = manifestOf(
      'inputs:',
      '  windowsOnly:',
      '    type: text',
      '    when: "${platform} == \'windows\'"',
      '    required: false',
      '  onCi:',
      '    type: text',
      '    when: "${env.CI} == \'true\'"',
      '    required: false',
    );

    // The context of these tests reports linux, and CI is set in the environment they pass.
    const resolution = resolve(onPlatform, {}, { CI: 'true' });

    expect(resolution.byId.get('windowsOnly')?.enabled).toBe(false);
    expect(resolution.byId.get('onCi')?.enabled).toBe(true);
  });

  it('names the condition that asked for an environment variable the machine lacks', () => {
    const needsVariable = manifestOf(
      'inputs:',
      '  onCi:',
      '    type: text',
      '    when: "${env.NOT_SET_ANYWHERE} == \'true\'"',
    );

    expect(() => resolve(needsVariable)).toThrow(
      'inputs.onCi.when: the environment variable NOT_SET_ANYWHERE is not set',
    );
  });

  it('treats an unanswered controlling input as its empty value, so a field starts off', () => {
    const conditional = manifestOf(
      'inputs:',
      '  installDatabase:',
      '    type: boolean',
      '  databasePort:',
      '    type: text',
      '    when: "${installDatabase}"',
    );

    // Nothing has answered the checkbox yet: the field it controls is off, and the run is
    // not waiting for it either.
    expect(resolve(conditional).byId.get('databasePort')?.enabled).toBe(false);
    expect(resolve(conditional).missing).toEqual(['installDatabase']);
  });
});

describe('values a type refuses', () => {
  const manifest = manifestOf(
    'inputs:',
    '  port:',
    '    type: text',
    '    pattern: "[0-9]{2,5}"',
    '  tools:',
    '    type: multiselect',
    '    options: [git, docker]',
  );

  it('names the input, where the value came from, and what is wrong with it', () => {
    expect(
      problems(manifest, {
        overrides: new Map([
          ['port', '8O80'],
          ['tools', 'podman'],
        ]),
      }),
    ).toEqual([
      'port (from --set port=…): "8O80" does not match [0-9]{2,5}',
      'tools (from --set tools=…): "podman" is not one of the option values ("git", "docker")',
    ]);
  });

  it('names the environment variable it read', () => {
    expect(problems(manifest, {}, { RUNE_INPUT_PORT: 'x' })[0]).toBe(
      'port (from the environment variable RUNE_INPUT_PORT): "x" does not match [0-9]{2,5}',
    );
  });

  it('names the values file it read', () => {
    expect(problems(manifest, { values: [values('production.yaml', { port: 'x' })] })[0]).toBe(
      'port (from production.yaml): "x" does not match [0-9]{2,5}',
    );
  });

  it('collects every bad value instead of stopping at the first', () => {
    expect(
      problems(manifest, {
        overrides: new Map([
          ['port', 'a'],
          ['tools', 'b'],
        ]),
      }),
    ).toHaveLength(2);
  });

  it('never repeats a secret back, not even to reject it', () => {
    const withSecret = manifestOf('inputs:', '  token:', '    type: secret');
    const message = problems(withSecret, { values: [values('v.yaml', { token: 12345 })] })[0];

    expect(message).toBe('token (from v.yaml): the value is not text');
    expect(message).not.toContain('12345');
  });
});

describe('keys that name no input', () => {
  it('refuses a typo rather than letting it do nothing', () => {
    expect(
      problems(manifestOf('inputs:', '  installDirectory:', '    type: directory'), {
        overrides: new Map([['installDirectroy', '/opt']]),
      }),
    ).toEqual([
      '"installDirectroy" is not an input of this manifest — did you mean "installDirectory"? (set from --set)',
    ]);
  });

  it('refuses one in a values file too, and names the file', () => {
    expect(
      problems(manifestOf(...SIMPLE), { values: [values('v.yaml', { nope: 'x' })] })[0],
    ).toContain('(set from v.yaml)');
  });

  it('refuses an unknown override when a frontend collects invalid values', () => {
    const error = inputError(manifestOf(...SIMPLE), {
      overrides: new Map([['nope', 'x']]),
      invalidValues: 'collect',
    });

    expect(error.code).toBe('RUNE-203');
    expect(error.issues).toMatchObject([{ code: 'RUNE-203' }]);
  });

  it('keeps the values-file origin and location when collecting invalid values', () => {
    const error = inputError(manifestOf(...SIMPLE), {
      values: [valuesFromFile('nope: x\n')],
      invalidValues: 'collect',
    });

    expect(error.code).toBe('RUNE-203');
    expect(error.issues).toMatchObject([
      {
        code: 'RUNE-203',
        message: expect.stringContaining('(set from v.yaml)'),
        location: { file: 'v.yaml', line: 1, column: 1 },
      },
    ]);
  });

  it('refuses an unknown layer-5 answer when a frontend collects invalid values', () => {
    const error = inputError(manifestOf(...SIMPLE), {
      answers: new Map([['nope', 'x']]),
      invalidValues: 'collect',
    });

    expect(error.code).toBe('RUNE-203');
    expect(error.issues).toMatchObject([{ code: 'RUNE-203' }]);
  });

  it('throws a mixed batch while preserving every issue and its invalid-value code', () => {
    const manifest = manifestOf(
      'inputs:',
      '  port:',
      '    type: text',
      '    pattern: "[0-9]{2,5}"',
    );
    const error = inputError(manifest, {
      overrides: new Map([
        ['nope', 'x'],
        ['port', 'eighty'],
      ]),
      invalidValues: 'collect',
    });

    expect(error.code).toBe('RUNE-202');
    expect(error.issues.map((issue) => issue.code)).toEqual(['RUNE-203', 'RUNE-202']);
  });
});

describe('what counts as an answer', () => {
  it('does not let an empty string satisfy a required input', () => {
    // The shape of the CI mistake that matters: a variable that was never set expands to "".
    const manifest = manifestOf('inputs:', '  token:', '    type: secret');

    expect(resolve(manifest, {}, { RUNE_INPUT_TOKEN: '' }).missing).toEqual(['token']);
  });

  it('does not let an empty selection satisfy a required multiselect', () => {
    const manifest = manifestOf(
      'inputs:',
      '  tools:',
      '    type: multiselect',
      '    options: [git]',
    );

    expect(resolve(manifest, { overrides: new Map([['tools', '']]) }).missing).toEqual(['tools']);
  });

  it('lets false satisfy a required boolean, because false is an answer', () => {
    const manifest = manifestOf('inputs:', '  verbose:', '    type: boolean');
    const resolution = resolve(manifest, { overrides: new Map([['verbose', 'false']]) });

    expect(resolution.missing).toEqual([]);
    expect(resolution.byId.get('verbose')?.value).toBe(false);
  });

  it('leaves an optional input alone: empty is a fine answer when nothing is required', () => {
    const manifest = manifestOf('inputs:', '  note:', '    type: text', '    required: false');

    expect(resolve(manifest, { overrides: new Map([['note', '']]) }).missing).toEqual([]);
  });
});

describe('a frontend that can ask again', () => {
  const manifest = manifestOf('inputs:', '  port:', '    type: text', '    pattern: "[0-9]{2,5}"');

  it('still throws a registry value problem by default', () => {
    const error = inputError(manifest, { overrides: new Map([['port', 'eighty']]) });

    expect(error.code).toBe('RUNE-202');
    expect(error.issues).toMatchObject([{ code: 'RUNE-202' }]);
  });

  it('collects the problem instead of throwing, and treats the value as unanswered', () => {
    const resolution = resolveInputs({
      manifest,
      context: contextFor(manifest),
      overrides: new Map([['port', 'eighty']]),
      invalidValues: 'collect',
    });

    expect(resolution.problems.map((problem) => problem.message)).toEqual([
      'port (from --set port=…): "eighty" does not match [0-9]{2,5}',
    ]);
    expect(resolution.problems.map((problem) => problem.code)).toEqual(['RUNE-202']);
    expect(resolution.byId.get('port')?.value).toBeUndefined();
    expect(resolution.missing).toEqual(['port']);
  });

  it('throws by default, which is what a pipeline needs', () => {
    expect(() => resolve(manifest, { overrides: new Map([['port', 'eighty']]) })).toThrow(
      /does not match/,
    );
  });
});

describe('secrets', () => {
  const manifest = manifestOf('inputs:', '  token:', '    type: secret');

  it('takes a resolved value back as an answer, which is how a frontend re-resolves', () => {
    const first = resolve(manifest, { overrides: new Map([['token', 'hunter2-and-more']]) });
    const answer = first.byId.get('token')?.value;

    const second = resolve(manifest, { answers: new Map([['token', answer as InputValue]]) });

    expect(second.byId.get('token')?.value).toBeInstanceOf(SecretString);
    expect((second.byId.get('token')?.value as SecretString).reveal()).toBe('hunter2-and-more');
    expect(second.missing).toEqual([]);
  });

  it('takes every other type back as an answer too', () => {
    const typed = manifestOf(
      'inputs:',
      '  verbose:',
      '    type: boolean',
      '  tools:',
      '    type: multiselect',
      '    options: [git, docker]',
    );
    const first = resolve(typed, {
      overrides: new Map([
        ['verbose', 'true'],
        ['tools', 'git,docker'],
      ]),
    });

    const second = resolve(typed, {
      answers: new Map(first.inputs.map((state) => [state.id, state.value as InputValue])),
    });

    expect(second.byId.get('verbose')?.value).toBe(true);
    expect(second.byId.get('tools')?.value).toEqual(['git', 'docker']);
  });

  it('wraps the value and registers it for masking before anything can run', () => {
    const secrets = new SecretRegistry();
    const resolution = resolve(manifest, {
      overrides: new Map([['token', 'hunter2-and-more']]),
      secrets,
    });

    expect(resolution.byId.get('token')?.value).toBeInstanceOf(SecretString);
    expect(secrets.size).toBe(1);
    expect(secrets.mask('logging in with hunter2-and-more')).toBe('logging in with ***');
  });

  it('warns about a secret too short to mask instead of failing or staying silent', () => {
    const secrets = new SecretRegistry();
    const resolution = resolve(manifest, { overrides: new Map([['token', 'ab']]), secrets });

    expect(secrets.size).toBe(0);
    expect(resolution.warnings[0]).toContain('too short to mask reliably');
  });

  it('warns when a multiline secret contains a content line too short to mask', () => {
    const secrets = new SecretRegistry();
    const resolution = resolve(manifest, {
      overrides: new Map([['token', 'long-secret\nabc']]),
      secrets,
    });

    expect(secrets.mask('long-secret')).toBe('***');
    expect(secrets.mask('abc')).toBe('abc');
    expect(resolution.warnings[0]).toContain('too short to mask reliably');
  });

  it('does not warn about blank lines in an otherwise maskable CRLF secret', () => {
    const secrets = new SecretRegistry();
    const resolution = resolve(manifest, {
      overrides: new Map([['token', 'first-long\r\n   \r\nsecond-long']]),
      secrets,
    });

    expect(resolution.warnings).toEqual([]);
  });
});

describe('values files', () => {
  function file(contents: string): string {
    const directory = mkdtempSync(join(tmpdir(), 'rune-values-'));
    const path = join(directory, 'values.yaml');
    writeFileSync(path, contents);
    return path;
  }

  it('reads a flat mapping of ids to values', () => {
    const document = parseValuesFile(
      file('target: /opt/app\nverbose: true\ntools:\n  - git\n  - docker\n'),
    );

    expect([...document.values.entries()]).toEqual([
      ['target', '/opt/app'],
      ['verbose', true],
      ['tools', ['git', 'docker']],
    ]);
  });

  it('reads an empty file as no values at all', () => {
    expect(parseValuesFile(file('')).values.size).toBe(0);
  });

  it('refuses a document that is not a mapping', () => {
    expect(() => parseValuesFile(file('- a\n- b\n'))).toThrow(/must contain a mapping/);
  });

  it('refuses a nested section, because a values file has no sections', () => {
    expect(() => parseValuesFile(file('database:\n  port: "5432"\n'))).toThrow(
      /database is a mapping; a values file is one flat mapping/,
    );
  });

  it('asks for a number to be written in quotes, without repeating it', () => {
    let thrown: unknown;
    try {
      parseValuesFile(file('port: 5432\n'));
    } catch (error) {
      thrown = error;
    }

    // This runs before anything knows which input the key belongs to, so it cannot know that
    // the value it would be quoting is a secret — a numeric API key lands here (§10).
    expect((thrown as InputError).message).toContain(
      'port is a number — write it in quotes so it means exactly what it says',
    );
    expect((thrown as InputError).message).not.toContain('5432');
  });

  it('refuses a key with no value at all', () => {
    expect(() => parseValuesFile(file('target:\n'))).toThrow(/target has no value/);
  });

  it('refuses a list with an entry that is not a string', () => {
    expect(() => parseValuesFile(file('tools:\n  - git\n  - 7\n'))).toThrow(
      /tools is a list with an entry that is not a string/,
    );
  });

  it('locates each problem in the file it came from', () => {
    let thrown: unknown;
    try {
      parseValuesFile(file('a: "ok"\nb:\n  nested: 1\n'), 'values.yaml');
    } catch (error) {
      thrown = error;
    }

    expect((thrown as InputError).issues[0]?.location).toMatchObject({
      file: 'values.yaml',
      line: 2,
      column: 1,
    });
  });
});
