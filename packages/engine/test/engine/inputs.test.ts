import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { createRuntimeContext, type RuntimeContext } from '../../src/engine/context.js';
import { buildPlan } from '../../src/engine/plan.js';
import {
  parseValuesFile,
  resolveInputs,
  resolveInputsWithRegistry,
  resolutionSnapshotFor,
  type Resolution,
  type ResolveInputsOptions,
  type ValuesDocument,
} from '../../src/engine/inputs.js';
import { isSecretString, secretEquals, SecretRegistry } from '../../src/engine/secrets.js';
import type { InputValue } from '../../src/inputs/base.js';
import { exitCodeFor, InternalError, ResolutionError, type InputError } from '../../src/errors.js';
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
    environment,
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

/** A values document without touching the disk. */
function values(file: string, entries: Record<string, unknown>): ValuesDocument {
  return {
    file,
    values: new Map(Object.entries(entries)),
    sourceMap: { location: () => undefined, keyLocation: () => undefined, best: () => undefined },
  } as unknown as ValuesDocument;
}

const SIMPLE = ['inputs:', '  target:', '    type: text'];

describe('resolution provenance', () => {
  it('rejects a structural runtime context without factory provenance', () => {
    const manifest = manifestOf(...SIMPLE);
    const fakeContext = { ...contextFor(manifest) };

    expect(() => resolveInputs({ manifest, context: fakeContext, environment: {} })).toThrow(
      InternalError,
    );
    expect(() => resolveInputs({ manifest, context: fakeContext, environment: {} })).toThrow(
      /runtime context was not created by createRuntimeContext/,
    );
  });

  it('exposes a frozen immutable map view consistent with the input snapshot', () => {
    const manifest = manifestOf(
      'inputs:',
      '  tools:',
      '    type: multiselect',
      '    options: [git, docker]',
      '  enabled:',
      '    type: boolean',
    );
    const resolution = resolve(manifest, {
      overrides: new Map([['tools', 'git,docker']]),
    });
    const state = resolution.inputs[0];

    expect(Object.isFrozen(resolution)).toBe(true);
    expect(Object.isFrozen(resolution.inputs)).toBe(true);
    expect(Object.isFrozen(resolution.byId)).toBe(true);
    expect(Object.isFrozen(state)).toBe(true);
    expect(Object.isFrozen(state?.value)).toBe(true);
    expect(state?.value).toEqual(['git', 'docker']);

    const byId = resolution.byId;
    const entries = [...byId];
    expect(byId.size).toBe(resolution.inputs.length);
    expect(byId.get('tools')).toBe(resolution.inputs[0]);
    expect(byId.has('tools')).toBe(true);
    expect(byId.has('missing')).toBe(false);
    expect([...byId.entries()]).toEqual(entries);
    expect([...byId.keys()]).toEqual(['tools', 'enabled']);
    expect([...byId.values()]).toEqual(resolution.inputs);
    expect([...byId]).toEqual(entries);

    const callbackThis = {};
    const callbackKeys: string[] = [];
    const callbackMaps: ReadonlyMap<string, (typeof resolution.inputs)[number]>[] = [];
    byId.forEach(function (this: object, _value, key, map) {
      expect(this).toBe(callbackThis);
      callbackKeys.push(key);
      callbackMaps.push(map);
    }, callbackThis);
    expect(callbackKeys).toEqual(['tools', 'enabled']);
    expect(callbackMaps).toEqual([byId, byId]);

    expect('set' in byId).toBe(false);
    expect('delete' in byId).toBe(false);
    expect('clear' in byId).toBe(false);
    const prototype = Object.getPrototypeOf(byId) as object;
    expect(Object.isFrozen(prototype)).toBe(true);
    expect(() => Object.defineProperty(prototype, 'get', { value: () => undefined })).toThrow(
      TypeError,
    );
    const mapView = byId as unknown as Map<string, (typeof resolution.inputs)[number]>;
    expect(() => Map.prototype.set.call(mapView, 'forged', resolution.inputs[0]!)).toThrow(
      TypeError,
    );
    expect(() => Map.prototype.delete.call(mapView, 'tools')).toThrow(TypeError);
    expect(() => Map.prototype.clear.call(mapView)).toThrow(TypeError);
    expect(byId.get('tools')).toBe(resolution.inputs[0]);
    expect([...byId]).toEqual(entries);
  });
});

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

    const resolution = resolveInputs({ manifest, context: preview, environment: {} });

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

  it('registers a discarded secret before masking later diagnostics', () => {
    const secret = 'disabled-secret-value';
    const withDisabledSecret = manifestOf(
      'inputs:',
      '  enabled:',
      '    type: boolean',
      '    default: false',
      '  token:',
      '    type: secret',
      '    when: "${enabled}"',
      '  mirror:',
      '    type: text',
      '    pattern: never',
    );
    const resolution = resolve(withDisabledSecret, {
      overrides: new Map([
        ['token', secret],
        ['mirror', secret],
      ]),
      invalidValues: 'collect',
    });
    const token = resolution.byId.get('token');

    expect(token).toMatchObject({
      enabled: false,
      source: undefined,
      ignored: 'set',
    });
    expect(isSecretString(token?.value)).toBe(true);
    expect(isSecretString(token?.value) && secretEquals(token.value, '')).toBe(true);
    expect(resolution.problems[0]?.message).toContain('***');
    expect(JSON.stringify(resolution.problems)).not.toContain(secret);
    expect(resolutionSnapshotFor(resolution).secrets.mask(`later diagnostic: ${secret}`)).toBe(
      'later diagnostic: ***',
    );
  });

  it('warns consistently when a discarded secret is too short to mask', () => {
    const withDisabledSecret = manifestOf(
      'inputs:',
      '  enabled:',
      '    type: boolean',
      '    default: false',
      '  token:',
      '    type: secret',
      '    when: "${enabled}"',
    );
    const resolution = resolve(withDisabledSecret, {
      overrides: new Map([['token', 'ab']]),
    });

    expect(resolution.warnings).toEqual([
      'token was set from --set, but its condition is false — the value is ignored',
      'token contains a non-empty value or line that is too short to mask reliably, so it may appear in logs — each non-empty value or line needs at least 4 non-whitespace characters to be masked',
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

  it('evaluates equality and membership against an opaque secret', () => {
    const conditional = manifestOf(
      'inputs:',
      '  token:',
      '    type: secret',
      '  environments:',
      '    type: multiselect',
      '    options: [production, staging]',
      '    default: [production]',
      '  equal:',
      '    type: text',
      '    when: "${token} == \'production\'"',
      '    required: false',
      '  member:',
      '    type: text',
      '    when: "${token} in ${environments}"',
      '    required: false',
    );
    const resolution = resolve(conditional, {
      overrides: new Map([['token', 'production']]),
    });

    expect(resolution.byId.get('equal')?.enabled).toBe(true);
    expect(resolution.byId.get('member')?.enabled).toBe(true);
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
  const collisionManifest = (inputLines: readonly string[]): ManifestV1 =>
    parseManifestText(
      [...HEAD, 'inputs:', ...inputLines, 'steps: []', ''].join('\n'),
      'installer.yaml',
      { manifestDir: '/project' },
    );
  const collisionCases = [
    [
      'before',
      ['  token:', '    type: secret', '  mirror:', '    type: text', '    pattern: never'],
    ],
    [
      'after',
      ['  mirror:', '    type: text', '    pattern: never', '  token:', '    type: secret'],
    ],
  ] as const;

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

  it.each(collisionCases)(
    'masks a registered secret in diagnostics when the secret input is %s the invalid input',
    (_position, inputLines) => {
      const secret = 'super-secret-value';
      const withCollision = collisionManifest(inputLines);
      const overrides = new Map([
        ['token', secret],
        ['mirror', secret],
      ]);
      let thrown: unknown;

      try {
        resolve(withCollision, { overrides });
      } catch (error) {
        thrown = error;
      }

      const inputError = thrown as InputError;
      expect(inputError.message).toContain('***');
      expect(inputError.message).not.toContain(secret);
      expect(inputError.issues).toHaveLength(1);
      expect(inputError.issues[0]?.message).toContain('***');
      expect(JSON.stringify(inputError.issues)).not.toContain(secret);

      const context = contextFor(withCollision);
      const resolution = resolveInputs({
        manifest: withCollision,
        context,
        environment: {},
        overrides,
        invalidValues: 'collect',
      });

      expect(resolution.problems).toHaveLength(1);
      expect(resolution.problems[0]?.message).toContain('***');
      expect(JSON.stringify(resolution.problems)).not.toContain(secret);

      let planErrorThrown: unknown;
      try {
        buildPlan({ manifest: withCollision, resolution, context });
      } catch (error) {
        planErrorThrown = error;
      }
      const planInputError = planErrorThrown as InputError;
      expect(planInputError.message).toContain('***');
      expect(planInputError.message).not.toContain(secret);
      expect(JSON.stringify(planInputError.issues)).not.toContain(secret);
    },
  );
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

  it('collects the problem instead of throwing, and treats the value as unanswered', () => {
    const resolution = resolveInputs({
      manifest,
      context: contextFor(manifest),
      environment: {},
      overrides: new Map([['port', 'eighty']]),
      invalidValues: 'collect',
    });

    expect(resolution.problems.map((problem) => problem.message)).toEqual([
      'port (from --set port=…): "eighty" does not match [0-9]{2,5}',
    ]);
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

    const value = second.byId.get('token')?.value;
    expect(isSecretString(value)).toBe(true);
    expect(isSecretString(value) && secretEquals(value, 'hunter2-and-more')).toBe(true);
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
    const resolution = resolveInputsWithRegistry(
      {
        manifest,
        context: contextFor(manifest),
        environment: {},
        overrides: new Map([['token', 'hunter2-and-more']]),
      },
      secrets,
    );

    expect(isSecretString(resolution.byId.get('token')?.value)).toBe(true);
    expect(resolution).not.toHaveProperty('secrets');
    expect(secrets.size).toBe(1);
    expect(secrets.mask('logging in with hunter2-and-more')).toBe('logging in with ***');
  });

  it('keeps the registry owned by the public resolver out of its result', () => {
    const resolution = resolve(manifest, {
      overrides: new Map([['token', 'hunter2-and-more']]),
    });

    expect(isSecretString(resolution.byId.get('token')?.value)).toBe(true);
    expect(resolution).not.toHaveProperty('secrets');
  });

  it('keeps the private masking snapshot stable when a retained registry changes', () => {
    const secrets = new SecretRegistry();
    const resolution = resolveInputsWithRegistry(
      {
        manifest,
        context: contextFor(manifest),
        environment: {},
        overrides: new Map([['token', 'resolved-secret']]),
      },
      secrets,
    );
    const snapshot = resolutionSnapshotFor(resolution).secrets;

    secrets.register('later-secret');

    expect(snapshot.mask('resolved-secret')).toBe('***');
    expect(snapshot.mask('later-secret')).toBe('later-secret');
    expect(snapshot).not.toHaveProperty('register');
    expect(snapshot).not.toHaveProperty('size');
  });

  it('warns about a secret too short to mask instead of failing or staying silent', () => {
    const secrets = new SecretRegistry();
    const resolution = resolveInputsWithRegistry(
      {
        manifest,
        context: contextFor(manifest),
        environment: {},
        overrides: new Map([['token', 'ab']]),
      },
      secrets,
    );

    expect(secrets.size).toBe(0);
    expect(resolution.warnings[0]).toContain('too short to mask reliably');
  });

  it('propagates partial multiline secret masking as a warning', () => {
    const secrets = new SecretRegistry();
    const resolution = resolveInputsWithRegistry(
      {
        manifest,
        context: contextFor(manifest),
        environment: {},
        overrides: new Map([['token', 'long-line\nno']]),
      },
      secrets,
    );

    expect(secrets.size).toBe(1);
    expect(secrets.mask('long-line\nno')).toBe('***\nno');
    expect(resolution.warnings).toEqual([
      'token contains a non-empty value or line that is too short to mask reliably, so it may appear in logs — each non-empty value or line needs at least 4 non-whitespace characters to be masked',
    ]);
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
