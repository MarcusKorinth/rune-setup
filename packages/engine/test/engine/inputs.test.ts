import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve as resolvePath } from 'node:path';
import { inspect } from 'node:util';

import { describe, expect, it, vi } from 'vitest';

import { createRuntimeContext, type RuntimeContext } from '../../src/engine/context.js';
import {
  parseValuesFile,
  projectInputFacadeSnapshot,
  resolveInputs,
  resolveInputsWithRegistry,
  resolutionSnapshotFor,
  UNKNOWN_KEY_SUGGESTION_WORK_BUDGET,
  type InputRejection,
  type Resolution,
  type ResolveInputsOptions,
  type ValuesDocument,
} from '../../src/engine/inputs.js';
import {
  createSecretString,
  isSecretString,
  MAX_SECRET_REGISTRY_CODE_UNITS,
  revealSecretString,
  SecretRegistry,
  type SecretString,
} from '../../src/engine/secrets.js';
import type { InputValue } from '../../src/inputs/base.js';
import {
  exitCodeFor,
  formatIssues,
  InputError,
  ManifestError,
  ResolutionError,
} from '../../src/errors.js';
import { parseManifestText } from '../../src/manifest/index.js';
import type { ManifestV1 } from '../../src/manifest/v1/schema.js';

const HEAD = ['schemaVersion: 1', 'product:', '  name: Example', '  version: "1.0.0"'];
const TEST_MANIFEST_DIR = resolvePath('/project');
const DIAGNOSTIC_CONTROLS = '\n\r\u001b\u0007\u0085\u2028\u2029';
const VISIBLE_DIAGNOSTIC_ESCAPES = [
  '\\n',
  '\\r',
  '\\u001b',
  '\\u0007',
  '\\u0085',
  '\\u2028',
  '\\u2029',
] as const;

function expectSafeDiagnostic(message: string): void {
  expect(hasRawDiagnosticControl(message)).toBe(false);
  for (const visible of VISIBLE_DIAGNOSTIC_ESCAPES) {
    expect(message).toContain(visible);
  }
}

function hasRawDiagnosticControl(message: string): boolean {
  return [...message].some((character) => {
    const codePoint = character.codePointAt(0)!;
    return (
      codePoint <= 0x1f ||
      (codePoint >= 0x7f && codePoint <= 0x9f) ||
      codePoint === 0x2028 ||
      codePoint === 0x2029
    );
  });
}

/**
 * Drops the frame list from a rendered error, keeping the header that carries its name and
 * message. Frames name the checkout, not the error: a repository directory spelled like a
 * fragment the leak assertions forbid — "path", say — would decide them for a reason no
 * secret caused.
 */
function withoutStackFrames(rendered: string): string {
  return rendered
    .split('\n')
    .filter((line) => !/^\s+at\s/u.test(line))
    .join('\n');
}

function manifestOf(...lines: readonly string[]): ManifestV1 {
  return parseManifestText([...HEAD, ...lines, 'steps: []', ''].join('\n'), 'installer.yaml');
}

function contextFor(
  manifest: ManifestV1,
  environment: Record<string, string> = {},
): RuntimeContext {
  return createRuntimeContext({
    manifestDir: TEST_MANIFEST_DIR,
    product: manifest.product,
    platform: 'linux',
    environment,
  });
}

type ResolveTestOptions = Omit<Partial<ResolveInputsOptions>, 'manifest' | 'context'> & {
  readonly secrets?: SecretRegistry;
};

function resolve(
  manifest: ManifestV1,
  options: ResolveTestOptions = {},
  environment: Record<string, string> = {},
): Resolution {
  const { secrets = new SecretRegistry(), ...rest } = options;
  return resolveInputsWithRegistry(
    {
      manifest,
      context: contextFor(manifest, environment),
      ...rest,
    },
    secrets,
  );
}

/** The messages a resolution was rejected with. */
function problems(
  manifest: ManifestV1,
  options: ResolveTestOptions = {},
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
  options: ResolveTestOptions = {},
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

function revealForTest(value: unknown): string {
  if (!isSecretString(value)) {
    throw new Error('expected an authentic secret value');
  }
  return revealSecretString(value);
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
function valuesFromFile(contents: string, displayName = 'v.yaml'): ValuesDocument {
  const directory = mkdtempSync(join(tmpdir(), 'rune-values-'));
  const path = join(directory, 'values.yaml');
  writeFileSync(path, contents);
  return parseValuesFile(path, displayName);
}

function rejectionFor(resolution: Resolution, id: string): InputRejection {
  const rejection = resolution.byId.get(id)?.rejection;
  if (rejection === undefined) {
    throw new Error(`expected ${id} to have a rejected value`);
  }
  return rejection;
}

const SIMPLE = ['inputs:', '  target:', '    type: text'];

function numberedInputIds(count: number): readonly string[] {
  return Array.from(
    { length: count },
    (_unused, index) => `input${index.toString().padStart(6, '0')}`,
  );
}

function suggestionWorkEstimate(key: string, ids: readonly string[]): number {
  return (
    (key.toLowerCase().length + 1) *
    ids.reduce((width, id) => width + id.toLowerCase().length + 1, 0)
  );
}

describe('resolution facade', () => {
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
    expect([...byId.entries()]).toEqual(entries);
    expect([...byId.keys()]).toEqual(['tools', 'enabled']);
    expect([...byId.values()]).toEqual(resolution.inputs);

    const callbackThis = {};
    const callbackMaps: ReadonlyMap<string, (typeof resolution.inputs)[number]>[] = [];
    byId.forEach(function (this: object, _value, _key, map) {
      expect(this).toBe(callbackThis);
      callbackMaps.push(map);
    }, callbackThis);
    expect(callbackMaps).toEqual([byId, byId]);

    expect('set' in byId).toBe(false);
    expect('delete' in byId).toBe(false);
    expect('clear' in byId).toBe(false);
    const prototype = Object.getPrototypeOf(byId) as object;
    expect(Object.isFrozen(prototype)).toBe(true);
    const mapView = byId as unknown as Map<string, (typeof resolution.inputs)[number]>;
    expect(() => Map.prototype.set.call(mapView, 'forged', resolution.inputs[0]!)).toThrow(
      TypeError,
    );
    expect(() => Map.prototype.delete.call(mapView, 'tools')).toThrow(TypeError);
    expect(() => Map.prototype.clear.call(mapView)).toThrow(TypeError);
    expect([...byId]).toEqual(entries);
  });

  it('keeps masking capabilities private and stable across retained-registry changes', () => {
    const manifest = manifestOf('inputs:', '  token:', '    type: secret');
    const secrets = new SecretRegistry();
    const resolution = resolveInputsWithRegistry(
      {
        manifest,
        context: contextFor(manifest),
        overrides: new Map([['token', 'resolved-secret']]),
      },
      secrets,
    );
    const snapshot = resolutionSnapshotFor(resolution).secrets;

    secrets.register('later-secret');

    expect(resolution).not.toHaveProperty('secrets');
    expect(snapshot.mask('resolved-secret/later-secret')).toBe('***/later-secret');
    expect(snapshot).not.toHaveProperty('register');
    expect(snapshot).not.toHaveProperty('size');
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
      rejection: undefined,
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

  it('keeps the later values file origin and exact location', () => {
    const patterned = manifestOf('inputs:', '  target:', '    type: text', '    pattern: "x+"');
    const resolution = resolve(patterned, {
      values: [
        valuesFromFile('target: x\n', 'base.yaml'),
        valuesFromFile('target: not-x\n', 'overlay.yaml'),
      ],
      invalidValues: 'collect',
    });
    const rejection = rejectionFor(resolution, 'target');

    expect(rejection.source).toBe('values');
    expect(rejection.candidate).toBe('not-x');
    expect(rejection.issue).toMatchObject({
      message: 'target (from overlay.yaml): "not-x" does not match x+',
      location: { file: 'overlay.yaml', line: 1, column: 1 },
    });
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
        values: [
          values('base.yaml', { target: 'from-base-values' }),
          values('overlay.yaml', { target: 'from-overlay-values' }),
        ],
        overrides: new Map([['target', 'from-set']]),
        answers: new Map([['target', 'from-answer']]),
      },
      { RUNE_INPUT_TARGET: 'from-environment' },
    );

    expect(resolution.byId.get('target')).toMatchObject({ value: 'from-answer', source: 'answer' });
  });

  it('validates a present undefined answer instead of falling back to lower layers', () => {
    const error = inputError(manifest, {
      answers: new Map([['target', undefined as unknown as InputValue]]),
      overrides: new Map([['target', 'from-set']]),
    });

    expect(error.code).toBe('RUNE-202');
    expect(error.issues).toMatchObject([
      { message: 'target (from the answer): undefined is not text' },
    ]);
  });

  it('retains a rejected undefined answer while registering a lower secret candidate', () => {
    const secret = manifestOf('inputs:', '  token:', '    type: secret');
    const secrets = new SecretRegistry();
    const resolution = resolve(secret, {
      answers: new Map([['token', undefined as unknown as InputValue]]),
      overrides: new Map([['token', 'lower-secret']]),
      invalidValues: 'collect',
      secrets,
    });

    expect(resolution.byId.get('token')).toMatchObject({
      value: undefined,
      source: undefined,
      rejection: { candidate: undefined, source: 'answer' },
    });
    expect(resolution.problems).toMatchObject([
      { code: 'RUNE-202', message: 'token (from the answer): the value is not text' },
    ]);
    expect(secrets.size).toBe(1);
    expect(secrets.mask('lower-secret')).toBe('***');
  });

  it('validates a present undefined override instead of falling back to lower layers', () => {
    const resolution = resolve(
      manifest,
      {
        overrides: new Map([['target', undefined as unknown as string]]),
        values: [values('v.yaml', { target: 'from-values' })],
        invalidValues: 'collect',
      },
      { RUNE_INPUT_TARGET: 'from-environment' },
    );

    expect(resolution.byId.get('target')).toMatchObject({
      value: undefined,
      source: undefined,
      rejection: { candidate: undefined, source: 'set' },
    });
    expect(resolution.problems).toMatchObject([
      { code: 'RUNE-202', message: 'target (from --set target=…): undefined is not text' },
    ]);
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
  const manifest = manifestOf(
    'inputs:',
    '  tools:',
    '    type: multiselect',
    '    options: [git, docker]',
  );

  it('cannot be changed through the layer-5 array after resolution', () => {
    const answer = ['git'];
    const resolution = resolve(manifest, { answers: new Map([['tools', answer]]) });
    const resolved = resolution.byId.get('tools')?.value;

    answer.push('podman');

    expect(resolved).toEqual(['git']);
    expect(Object.isFrozen(resolved)).toBe(true);
  });

  it('checks an explicit empty string from --set against options', () => {
    expect(problems(manifest, { overrides: new Map([['tools', '']]) })).toEqual([
      'tools (from --set tools=…): "" is not one of the option values ("git", "docker")',
    ]);

    const withEmptyOption = manifestOf(
      'inputs:',
      '  tools:',
      '    type: multiselect',
      '    options: ["", git]',
    );
    expect(
      resolve(withEmptyOption, { overrides: new Map([['tools', '']]) }).byId.get('tools')?.value,
    ).toEqual(['']);
  });

  it('allows an empty native selection from a values file', () => {
    expect(
      resolve(manifest, { values: [values('values.yaml', { tools: [] })] }).byId.get('tools')
        ?.value,
    ).toEqual([]);
  });

  it('classifies a proxied programmatic values entry as RUNE-202', () => {
    const proxied = new Proxy(['git'], {
      getOwnPropertyDescriptor: () => {
        throw new Error('must become an input error');
      },
    });
    const error = inputError(manifest, {
      values: [values('programmatic.yaml', { tools: proxied })],
    });

    expect(error.code).toBe('RUNE-202');
    expect(error.issues).toMatchObject([
      {
        code: 'RUNE-202',
        message: 'tools (from programmatic.yaml): array is not a list of option values',
      },
    ]);
  });

  it('collects an accessor answer as RUNE-202 without calling its getter', () => {
    const answer = ['decoy'];
    let getterCalls = 0;
    Object.defineProperty(answer, '0', {
      get: () => {
        getterCalls += 1;
        return 'git';
      },
      enumerable: true,
      configurable: true,
    });

    const resolution = resolveInputs({
      manifest,
      context: contextFor(manifest),
      answers: new Map([['tools', answer]]),
      invalidValues: 'collect',
    });

    expect(resolution.problems).toMatchObject([
      {
        code: 'RUNE-202',
        message: 'tools (from the answer): array is not a list of option values',
      },
    ]);
    expect(resolution.byId.get('tools')?.value).toBeUndefined();
    expect(rejectionFor(resolution, 'tools').candidate).toBeUndefined();
    expect(getterCalls).toBe(0);
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
    expect(resolution.byId.get('target')).toHaveProperty('rejection', undefined);
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
      `${TEST_MANIFEST_DIR}/marcus/logs`,
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
      manifestDir: TEST_MANIFEST_DIR,
      product: manifest.product,
      platform: process.platform === 'win32' ? 'linux' : 'windows',
      environment: {},
    });

    const resolution = resolveInputs({
      manifest,
      context: preview,
    });

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
    '    pattern: "[0-9]{2,5}"',
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
      rejection: undefined,
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
      rejection: undefined,
      ignored: 'set',
    });
    expect(resolution.warnings).toEqual([
      'databasePort was set from --set, but its condition is false — the value is ignored',
    ]);
  });

  it('continues to ignore an invalid --set value for a disabled input', () => {
    const resolution = resolve(manifest, {
      overrides: new Map([
        ['installDatabase', 'false'],
        ['databasePort', 'not-a-port'],
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

  it('resolves a long valid condition chain without scanning visible input prefixes', () => {
    const inputCount = 512;
    const lines = ['inputs:'];
    for (let index = 0; index < inputCount; index += 1) {
      const id = `chain${index.toString().padStart(4, '0')}`;
      lines.push(`  ${id}:`, '    type: boolean', '    default: true');
      if (index > 0) {
        const previous = `chain${(index - 1).toString().padStart(4, '0')}`;
        lines.push(`    when: "\${${previous}}"`);
      }
    }
    const chained = manifestOf(...lines);
    const includes = vi.spyOn(Array.prototype, 'includes');
    let resolution: Resolution;
    let visiblePrefixScans = 0;

    try {
      resolution = resolve(chained);
      visiblePrefixScans = includes.mock.contexts.filter(
        (value): value is string[] =>
          Array.isArray(value) &&
          value.length > 0 &&
          value.every((item) => typeof item === 'string' && /^chain\d{4}$/.test(item)),
      ).length;
    } finally {
      includes.mockRestore();
    }

    expect(visiblePrefixScans).toBe(0);
    expect(resolution.inputs).toHaveLength(inputCount);
    expect(resolution.byId.get('chain0511')).toMatchObject({ enabled: true, value: true });
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

  it('masks a declared secret in a membership diagnostic, whichever type saw it', () => {
    // The registry holds the whole supplied value, never the pieces RUNE splits it into, so
    // a diagnostic naming those pieces printed the secret past every mask (§10). select and
    // multiselect are fed the identical text and must agree.
    const withSecret = manifestOf(
      'inputs:',
      '  token:',
      '    type: secret',
      '  tools:',
      '    type: multiselect',
      '    options: [git, docker]',
      '  tool:',
      '    type: select',
      '    options: [git, docker]',
    );

    for (const value of ['alphaonly,betaonly', '["alphaonly","betaonly"]']) {
      const messages = problems(withSecret, {
        overrides: new Map([
          ['token', value],
          ['tools', value],
          ['tool', value],
        ]),
      });

      expect(messages.join('\n')).not.toContain('alphaonly');
      expect(messages.join('\n')).not.toContain('betaonly');
      expect(messages).toContain(
        'tools (from --set tools=…): "***" contains values that are not option values ("git", "docker")',
      );
      expect(messages).toContain(
        'tool (from --set tool=…): "***" is not one of the option values ("git", "docker")',
      );
    }
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
  it('indexes values documents and entries exactly once per resolution', () => {
    const inputCount = 200;
    const documentCount = 48;
    const ids = Array.from({ length: inputCount }, (_, index) => `input${index}`);
    const supplied = Object.fromEntries(ids.map((id) => [id, `value-${id}`]));
    const manifest = manifestOf(
      'inputs:',
      ...ids.flatMap((id, index) => [`  ${id}:`, `    type: ${index === 0 ? 'secret' : 'text'}`]),
    );
    let documentIteratorRequests = 0;
    let valuesIteratorRequests = 0;
    let entryVisits = 0;
    const documents = Array.from({ length: documentCount }, (_, index) => {
      const entries = new Map(Object.entries(supplied));
      const monitoredEntries = new Proxy(entries, {
        get(target, property, receiver) {
          if (property === Symbol.iterator) {
            valuesIteratorRequests += 1;
            return function* (): Generator<[string, unknown]> {
              for (const entry of target) {
                entryVisits += 1;
                yield entry;
              }
            };
          }
          return Reflect.get(target, property, receiver);
        },
      });
      return {
        file: `values-${index}.yaml`,
        values: monitoredEntries as unknown as ReadonlyMap<string, unknown>,
        sourceMap: {
          location: () => undefined,
          keyLocation: () => undefined,
          best: () => undefined,
        },
      } as unknown as ValuesDocument;
    });
    const monitoredDocuments = new Proxy(documents, {
      get(target, property, receiver) {
        if (property === Symbol.iterator) {
          documentIteratorRequests += 1;
        }
        return Reflect.get(target, property, receiver);
      },
    });
    const includes = vi.spyOn(Array.prototype, 'includes');
    let includesCalls = 0;
    let resolution: Resolution | undefined;

    try {
      resolution = resolve(manifest, { values: monitoredDocuments });
      includesCalls = includes.mock.calls.length;
    } finally {
      includes.mockRestore();
    }

    expect(documentIteratorRequests).toBe(1);
    expect(valuesIteratorRequests).toBe(documentCount);
    expect(entryVisits).toBe(documentCount * inputCount);
    expect(includesCalls).toBe(0);
    const first = resolution?.byId.get('input0');
    expect(first?.source).toBe('values');
    expect(isSecretString(first?.value)).toBe(true);
    expect(revealForTest(first?.value)).toBe('value-input0');
  });

  it('refuses a typo rather than letting it do nothing', () => {
    expect(
      problems(manifestOf('inputs:', '  installDirectory:', '    type: directory'), {
        overrides: new Map([['installDirectroy', '/opt']]),
      }),
    ).toEqual([
      '"installDirectroy" is not an input of this manifest — did you mean "installDirectory"? (set from --set)',
    ]);
  });

  it('quotes unknown ids and escapes controls in ids, origins, and locations', () => {
    const key = `targ${DIAGNOSTIC_CONTROLS}et"\\key`;
    const origin = `values${DIAGNOSTIC_CONTROLS}"\\file.yaml`;
    const error = inputError(manifestOf(...SIMPLE), {
      values: [values(origin, { [key]: 'x' })],
    });
    const issue = error.issues[0];

    expect(issue).toBeDefined();
    expectSafeDiagnostic(issue!.message);
    expectSafeDiagnostic(error.message);
    expect(issue!.message).toContain('\\"\\\\key" is not an input');
    expect(issue!.message).toContain('(set from values\\n\\r');
    expect(error.location?.file).toBe(origin);
  });

  it('retains an ordinary suggestion while safely quoting its controlled unknown id', () => {
    const error = inputError(manifestOf(...SIMPLE), {
      overrides: new Map([['targe\n', 'x']]),
    });

    expect(error.issues[0]?.message).toBe(
      '"targe\\n" is not an input of this manifest — did you mean "target"? (set from --set)',
    );
    expect(hasRawDiagnosticControl(error.issues[0]?.message ?? '')).toBe(false);
  });

  it('reports every large batch key while bounding optional suggestion work', () => {
    const ids = numberedInputIds(100);
    const unknownKeys = ids.map((id) => `${id}x`);
    const manifest = manifestOf('inputs:', ...ids.flatMap((id) => [`  ${id}:`, '    type: text']));
    const workPerSuggestion = suggestionWorkEstimate(unknownKeys[0]!, ids);
    const expectedHints = Math.floor(UNKNOWN_KEY_SUGGESTION_WORK_BUDGET / workPerSuggestion);
    const error = inputError(manifest, {
      overrides: new Map(unknownKeys.map((key) => [key, 'value'])),
    });

    expect(expectedHints).toBeGreaterThan(0);
    expect(error.code).toBe('RUNE-203');
    expect(error.issues).toHaveLength(unknownKeys.length);
    expect(error.issues.every((issue) => issue.code === 'RUNE-203')).toBe(true);
    expect(
      error.issues
        .filter((issue) => issue.message.includes('did you mean'))
        .map((issue) => issue.message),
    ).toHaveLength(expectedHints);
  });

  it('skips a suggestion that would require a large Levenshtein matrix', () => {
    const known = `input${'a'.repeat(1_000)}`;
    const unknown = `${known.slice(0, -1)}b`;
    const manifest = manifestOf('inputs:', `  ${known}:`, '    type: text');
    const error = inputError(manifest, { overrides: new Map([[unknown, 'value']]) });

    expect(error.code).toBe('RUNE-203');
    expect(error.issues).toMatchObject([{ code: 'RUNE-203', location: undefined }]);
    expect(error.issues[0]?.message).not.toContain('did you mean');
  });

  it('shares the suggestion budget across overrides, values files, and answers', () => {
    const ids = numberedInputIds(120);
    const unknownKeys = ids.map((id) => `${id}x`);
    const manifest = manifestOf('inputs:', ...ids.flatMap((id) => [`  ${id}:`, '    type: text']));
    const workPerSuggestion = suggestionWorkEstimate(unknownKeys[0]!, ids);
    const hintCount = Math.floor(UNKNOWN_KEY_SUGGESTION_WORK_BUDGET / workPerSuggestion);
    const overrideKey = unknownKeys[0]!;
    const valuesKeys = unknownKeys.slice(1, hintCount + 2);
    const answerKey = unknownKeys[hintCount + 2]!;
    const error = inputError(manifest, {
      overrides: new Map([[overrideKey, 'value']]),
      values: [valuesFromFile(valuesKeys.map((key) => `${key}: value`).join('\n'))],
      answers: new Map([[answerKey, 'value']]),
    });

    const byKey = (key: string) =>
      error.issues.find((issue) => issue.message.startsWith(`"${key}" is not an input`));

    expect(hintCount).toBeGreaterThan(1);
    expect(error.issues).toHaveLength(1 + valuesKeys.length + 1);
    expect(error.issues.every((issue) => issue.code === 'RUNE-203')).toBe(true);
    expect(byKey(overrideKey)?.message).toContain('did you mean');
    expect(byKey(valuesKeys[0]!)?.message).toContain('did you mean');
    expect(byKey(valuesKeys[valuesKeys.length - 1]!)?.message).not.toContain('did you mean');
    expect(byKey(answerKey)?.message).not.toContain('did you mean');
    expect(byKey(overrideKey)?.location).toBeUndefined();
    expect(byKey(valuesKeys[0]!)?.location).toEqual({ file: 'v.yaml', line: 1, column: 1 });
    expect(byKey(answerKey)?.location).toBeUndefined();
    expect(error.issues.map((issue) => issue.location?.line)).toEqual([
      undefined,
      undefined,
      ...valuesKeys.map((_key, index) => index + 1),
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

  it('keeps an unknown-only aggregate at RUNE-203 when missing issues are supplemental', () => {
    const manifest = manifestOf(...SIMPLE);
    const missingIssue = vi.fn((id: string) => ({
      code: 'RUNE-201' as const,
      message: `missing ${id}`,
      location: undefined,
    }));
    let thrown: unknown;

    try {
      resolveInputsWithRegistry(
        {
          manifest,
          context: contextFor(manifest),
          overrides: new Map([['unknown', 'value']]),
        },
        new SecretRegistry(),
        undefined,
        missingIssue,
      );
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(InputError);
    const error = thrown as InputError;
    expect(error.code).toBe('RUNE-203');
    expect(error.issues.map((issue) => issue.code).sort()).toEqual(['RUNE-201', 'RUNE-203']);
    expect(missingIssue).toHaveBeenCalledExactlyOnceWith('target');
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

  it('orders values-file issues by source location instead of collection phase', () => {
    const manifest = manifestOf(
      'inputs:',
      '  port:',
      '    type: text',
      '    pattern: "[0-9]{2,5}"',
    );
    const error = inputError(manifest, {
      values: [valuesFromFile('port: eighty\nunknown: value\n')],
    });

    expect(error.issues).toMatchObject([
      { code: 'RUNE-202', location: { file: 'v.yaml', line: 1, column: 1 } },
      { code: 'RUNE-203', location: { file: 'v.yaml', line: 2, column: 1 } },
    ]);
    expect(error.location).toEqual({ file: 'v.yaml', line: 1, column: 1 });
  });

  it('keeps an unlocated override first while retaining a values-file location', () => {
    const manifest = manifestOf(
      'inputs:',
      '  port:',
      '    type: text',
      '    pattern: "[0-9]{2,5}"',
    );
    const error = inputError(manifest, {
      values: [valuesFromFile('port: eighty\n')],
      overrides: new Map([['unknown', 'value']]),
      invalidValues: 'collect',
    });

    expect(error.issues).toMatchObject([
      { code: 'RUNE-203', location: undefined },
      { code: 'RUNE-202', location: { file: 'v.yaml', line: 1, column: 1 } },
    ]);
    expect(error.location).toEqual({ file: 'v.yaml', line: 1, column: 1 });
  });
});

describe('what counts as an answer', () => {
  it('does not let an empty string satisfy a required input', () => {
    // The shape of the CI mistake that matters: a variable that was never set expands to "".
    const manifest = manifestOf('inputs:', '  token:', '    type: secret');

    expect(resolve(manifest, {}, { RUNE_INPUT_TOKEN: '' }).missing).toEqual(['token']);
  });

  it('does not let an empty native selection satisfy a required multiselect', () => {
    const manifest = manifestOf(
      'inputs:',
      '  tools:',
      '    type: multiselect',
      '    options: [git]',
    );

    expect(resolve(manifest, { answers: new Map([['tools', []]]) }).missing).toEqual(['tools']);
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
    expect(resolution.byId.get('port')).toMatchObject({
      value: undefined,
      source: undefined,
      rejection: { candidate: 'eighty', source: 'set' },
    });
    expect(rejectionFor(resolution, 'port').issue).toBe(resolution.problems[0]);
    expect(resolution.missing).toEqual(['port']);
  });

  it('throws by default, which is what a pipeline needs', () => {
    expect(() => resolve(manifest, { overrides: new Map([['port', 'eighty']]) })).toThrow(
      /does not match/,
    );
  });
});

describe('collected rejected values', () => {
  it('retains the rendered default, its source and the exact collected issue', () => {
    const manifest = manifestOf(
      'inputs:',
      '  port:',
      '    type: text',
      '    pattern: "[0-9]+"',
      '    default: "${env.PORT_SEED}"',
    );
    const resolution = resolve(
      manifest,
      { invalidValues: 'collect' },
      { PORT_SEED: 'rendered-eighty' },
    );

    expect(resolution.byId.get('port')).toMatchObject({
      value: undefined,
      source: undefined,
      rejection: { candidate: 'rendered-eighty', source: 'default' },
    });
    expect(rejectionFor(resolution, 'port').issue).toBe(resolution.problems[0]);
    expect(resolution.missing).toEqual(['port']);
  });

  it('retains a bad boolean from a values file without making an optional input missing', () => {
    const manifest = manifestOf(
      'inputs:',
      '  verbose:',
      '    type: boolean',
      '    required: false',
    );
    const resolution = resolve(manifest, {
      values: [values('v.yaml', { verbose: 'sometimes' })],
      invalidValues: 'collect',
    });

    expect(resolution.byId.get('verbose')).toMatchObject({
      value: undefined,
      source: undefined,
      rejection: { candidate: 'sometimes', source: 'values' },
    });
    expect(rejectionFor(resolution, 'verbose').issue).toBe(resolution.problems[0]);
    expect(resolution.missing).toEqual([]);
  });

  it('retains an invalid select value from the environment', () => {
    const manifest = manifestOf(
      'inputs:',
      '  channel:',
      '    type: select',
      '    options: [stable, preview]',
    );
    const resolution = resolve(
      manifest,
      { invalidValues: 'collect' },
      { RUNE_INPUT_CHANNEL: 'Production' },
    );

    expect(resolution.byId.get('channel')).toMatchObject({
      value: undefined,
      source: undefined,
      rejection: { candidate: 'Production', source: 'environment' },
    });
    expect(rejectionFor(resolution, 'channel').issue).toBe(resolution.problems[0]);
  });

  it('retains the written --set form of an invalid multiselect', () => {
    const manifest = manifestOf(
      'inputs:',
      '  tools:',
      '    type: multiselect',
      '    options: [git, docker]',
    );
    const resolution = resolve(manifest, {
      overrides: new Map([['tools', 'git,podman']]),
      invalidValues: 'collect',
    });

    expect(resolution.byId.get('tools')).toMatchObject({
      value: undefined,
      source: undefined,
      rejection: { candidate: 'git,podman', source: 'set' },
    });
    expect(rejectionFor(resolution, 'tools').issue).toBe(resolution.problems[0]);
  });

  it('takes an immutable answer snapshot independent of later array mutation', () => {
    const manifest = manifestOf(
      'inputs:',
      '  tools:',
      '    type: multiselect',
      '    options: [git, docker]',
    );
    const answer = ['git', 'podman'];
    const resolution = resolve(manifest, {
      answers: new Map([['tools', answer]]),
      invalidValues: 'collect',
    });
    const rejection = rejectionFor(resolution, 'tools');
    const candidate = rejection.candidate as readonly string[];

    answer[0] = 'docker';
    answer.push('other');

    expect(candidate).toEqual(['git', 'podman']);
    expect(candidate).not.toBe(answer);
    expect(Object.isFrozen(candidate)).toBe(true);
    expect(() => (candidate as string[]).push('docker')).toThrow(TypeError);
    expect(rejection.source).toBe('answer');
    expect(rejection.issue).toBe(resolution.problems[0]);
  });

  it('does not retain a rejected secret value or anything reachable from it', () => {
    const manifest = manifestOf('inputs:', '  token:', '    type: secret');
    const sentinel = 'SECRET-REJECTION-SENTINEL';
    const rejectedValues: readonly unknown[] = [
      { payload: sentinel },
      new Proxy(createSecretString(sentinel), {}),
    ];

    for (const raw of rejectedValues) {
      const resolution = resolve(manifest, {
        answers: new Map([['token', raw]]) as unknown as ReadonlyMap<string, InputValue>,
        invalidValues: 'collect',
      });
      const state = resolution.byId.get('token');
      const facade = projectInputFacadeSnapshot(resolution);

      expect(state).toMatchObject({
        value: undefined,
        source: undefined,
        rejection: { candidate: undefined, source: 'answer' },
      });
      expect(facade.all[0]).toMatchObject({
        secret: true,
        value: undefined,
        rejection: { candidate: undefined, source: 'answer' },
      });
      expect(facade.pending).toEqual([facade.all[0]]);
      expect(facade.pending[0]).toBe(facade.all[0]);
      expect(rejectionFor(resolution, 'token').issue).toBe(resolution.problems[0]);
      expect(inspect(state)).not.toContain(sentinel);
      expect(JSON.stringify(state)).not.toContain(sentinel);
    }
  });

  it('does not retain foreign objects, numbers or symbols as prefill candidates', () => {
    const manifest = manifestOf('inputs:', '  note:', '    type: text');
    const foreignValues: readonly unknown[] = [
      { value: 'not-a-candidate' },
      42,
      Symbol('not-a-candidate'),
    ];

    for (const raw of foreignValues) {
      const resolution = resolve(manifest, {
        answers: new Map([['note', raw]]) as unknown as ReadonlyMap<string, InputValue>,
        invalidValues: 'collect',
      });

      expect(rejectionFor(resolution, 'note').candidate).toBeUndefined();
    }
  });

  it('uses the type-empty value in conditions and leaves disabled values ignored', () => {
    const manifest = manifestOf(
      'inputs:',
      '  installDatabase:',
      '    type: boolean',
      '    required: false',
      '  databasePort:',
      '    type: text',
      '    when: "${installDatabase}"',
      '    pattern: "[0-9]+"',
    );
    const invalidController = resolve(manifest, {
      overrides: new Map([['installDatabase', 'perhaps']]),
      invalidValues: 'collect',
    });

    expect(invalidController.byId.get('databasePort')).toMatchObject({
      enabled: false,
      value: '',
      source: undefined,
      rejection: undefined,
    });
    expect(invalidController.missing).toEqual([]);

    const ignoredInvalidValue = resolve(manifest, {
      overrides: new Map([
        ['installDatabase', 'false'],
        ['databasePort', 'not-a-port'],
      ]),
      invalidValues: 'collect',
    });

    expect(ignoredInvalidValue.byId.get('databasePort')).toMatchObject({
      enabled: false,
      value: '',
      source: undefined,
      rejection: undefined,
      ignored: 'set',
    });
    expect(ignoredInvalidValue.problems).toEqual([]);
  });
});

describe('secrets', () => {
  const manifest = manifestOf('inputs:', '  token:', '    type: secret');
  const disabledSecret = manifestOf(
    'inputs:',
    '  enabled:',
    '    type: boolean',
    '    default: false',
    '  token:',
    '    type: secret',
    '    when: "${enabled}"',
  );

  function publicErrorSurfaces(error: Error): readonly string[] {
    const surfaces: string[] = [];
    const seen = new Set<Error>();
    let current: unknown = error;
    while (current instanceof Error && !seen.has(current)) {
      seen.add(current);
      surfaces.push(
        current.message,
        withoutStackFrames(current.stack ?? ''),
        String(current),
        JSON.stringify(current) ?? '',
        withoutStackFrames(inspect(current)),
      );
      if (current instanceof InputError || current instanceof ResolutionError) {
        surfaces.push(...current.issues.map((issue) => issue.message));
      }
      current = current.cause;
    }
    return surfaces;
  }

  function existingRegistry(): SecretRegistry {
    const secrets = new SecretRegistry();
    secrets.register('existing-secret');
    // Exercise replacement after the lazy longest-first cache has already been populated.
    expect(secrets.mask('existing-secret')).toBe('***');
    return secrets;
  }

  function expectExistingRegistryUnchanged(secrets: SecretRegistry): void {
    expect(secrets.size).toBe(1);
    expect(secrets.mask('existing-secret')).toBe('***');
    expect(secrets.mask('candidate-secret')).toBe('candidate-secret');
  }

  function resolveWithRecursiveCause(cause: ResolutionError, secret: string): ResolutionError {
    const withCause = manifestOf(
      'inputs:',
      '  token:',
      '    type: secret',
      '  directory:',
      '    type: directory',
      '    default: "${env.TRIGGER}"',
    );
    const baseContext = contextFor(withCause);
    const context: RuntimeContext = {
      ...baseContext,
      valueOf: () => {
        throw cause;
      },
    };

    try {
      resolveInputs({
        manifest: withCause,
        context,
        overrides: new Map([['token', secret]]),
      });
    } catch (error) {
      if (error instanceof ResolutionError) {
        return error;
      }
      throw error;
    }
    throw new Error('expected resolution to fail');
  }

  it.each([
    {
      name: 'matching secret values',
      token: 'alpha-secret',
      comparison: 'alpha-secret',
      choices: 'alpha-secret,beta-secret',
      enabled: {
        equalsLiteral: true,
        differsLiteral: false,
        equalsSecret: true,
        needleIn: true,
        needleNotIn: false,
      },
    },
    {
      name: 'different secret values',
      token: 'gamma-secret',
      comparison: 'delta-secret',
      choices: 'alpha-secret,beta-secret',
      enabled: {
        equalsLiteral: false,
        differsLiteral: true,
        equalsSecret: false,
        needleIn: false,
        needleNotIn: true,
      },
    },
  ])(
    'evaluates every secret input condition for $name',
    ({ token, comparison, choices, enabled }) => {
      const conditional = manifestOf(
        'inputs:',
        '  token:',
        '    type: secret',
        '    required: false',
        '  comparison:',
        '    type: secret',
        '    required: false',
        '  choices:',
        '    type: multiselect',
        '    required: false',
        '    options: [alpha-secret, beta-secret]',
        '  equalsLiteral:',
        '    type: text',
        '    required: false',
        '    when: \'${token} == "alpha-secret"\'',
        '  differsLiteral:',
        '    type: text',
        '    required: false',
        '    when: \'${token} != "alpha-secret"\'',
        '  equalsSecret:',
        '    type: text',
        '    required: false',
        "    when: '${token} == ${comparison}'",
        '  needleIn:',
        '    type: text',
        '    required: false',
        "    when: '${token} in ${choices}'",
        '  needleNotIn:',
        '    type: text',
        '    required: false',
        "    when: '${token} not in ${choices}'",
      );
      const resolution = resolve(conditional, {
        overrides: new Map([
          ['token', token],
          ['comparison', comparison],
          ['choices', choices],
        ]),
      });

      for (const [id, expected] of Object.entries(enabled)) {
        expect(resolution.byId.get(id)?.enabled, id).toBe(expected);
      }
    },
  );

  it('compares optional empty secrets without revealing or coercing them', () => {
    const conditional = manifestOf(
      'inputs:',
      '  token:',
      '    type: secret',
      '    required: false',
      '  comparison:',
      '    type: secret',
      '    required: false',
      '  equalsEmpty:',
      '    type: text',
      '    required: false',
      '    when: \'${token} == ""\'',
      '  differsEmpty:',
      '    type: text',
      '    required: false',
      '    when: \'${token} != ""\'',
      '  equalsEmptySecret:',
      '    type: text',
      '    required: false',
      "    when: '${token} == ${comparison}'",
    );
    const resolution = resolve(conditional);

    expect(resolution.byId.get('equalsEmpty')?.enabled).toBe(true);
    expect(resolution.byId.get('differsEmpty')?.enabled).toBe(false);
    expect(resolution.byId.get('equalsEmptySecret')?.enabled).toBe(true);
  });

  it('keeps secret condition state and serialization surfaces masked', () => {
    const content = 'F049-INPUT-CONDITION-SECRET';
    const conditional = manifestOf(
      'inputs:',
      '  token:',
      '    type: secret',
      '  comparison:',
      '    type: secret',
      '  dependent:',
      '    type: text',
      '    required: false',
      "    when: '${token} == ${comparison}'",
    );
    const resolution = resolve(conditional, {
      overrides: new Map([
        ['token', content],
        ['comparison', content],
      ]),
    });
    const surfaces = [JSON.stringify(resolution.inputs), inspect(resolution.inputs)];

    expect(resolution.byId.get('dependent')?.enabled).toBe(true);
    expect(surfaces.join('\n')).not.toContain(content);
    expect(surfaces.join('\n')).toContain('***');
  });

  it('takes a resolved value back as an answer, which is how a frontend re-resolves', () => {
    const first = resolve(manifest, { overrides: new Map([['token', 'hunter2-and-more']]) });
    const answer = first.byId.get('token')?.value;

    const second = resolve(manifest, { answers: new Map([['token', answer as InputValue]]) });

    expect(isSecretString(second.byId.get('token')?.value)).toBe(true);
    expect(revealForTest(second.byId.get('token')?.value)).toBe('hunter2-and-more');
    expect(second.missing).toEqual([]);
  });

  it('stages every values-file secret while the later value remains the winner', () => {
    const base = 'F046-BASE-VALUES-SECRET';
    const winner = 'F046-OVERLAY-VALUES-SECRET';
    const secrets = new SecretRegistry();
    const resolution = resolve(manifest, {
      values: [values('base.yaml', { token: base }), values('overlay.yaml', { token: winner })],
      secrets,
    });

    expect(resolution.byId.get('token')?.source).toBe('values');
    expect(revealForTest(resolution.byId.get('token')?.value)).toBe(winner);
    expect(secrets.mask(winner)).toBe('***');
    expect(secrets.mask(base)).toBe('***');
    expect(secrets.size).toBe(2);
  });

  it.each([
    {
      layers: 'values → values',
      options: {
        values: [
          values('base.yaml', { token: 'F047-BASE-VALUES' }),
          values('overlay.yaml', { token: 'F047-OVERLAY-VALUES' }),
        ],
      },
      environment: {},
      source: 'values',
      winner: 'F047-OVERLAY-VALUES',
      candidates: ['F047-BASE-VALUES', 'F047-OVERLAY-VALUES'],
    },
    {
      layers: 'values → environment',
      options: { values: [values('v.yaml', { token: 'F047-VALUES-BELOW-ENV' })] },
      environment: { RUNE_INPUT_TOKEN: 'F047-ENV-WINNER' },
      source: 'environment',
      winner: 'F047-ENV-WINNER',
      candidates: ['F047-VALUES-BELOW-ENV', 'F047-ENV-WINNER'],
    },
    {
      layers: 'values → --set',
      options: {
        values: [values('v.yaml', { token: 'F047-VALUES-BELOW-SET' })],
        overrides: new Map([['token', 'F047-SET-WINNER']]),
      },
      environment: {},
      source: 'set',
      winner: 'F047-SET-WINNER',
      candidates: ['F047-VALUES-BELOW-SET', 'F047-SET-WINNER'],
    },
    {
      layers: 'values → answer',
      options: {
        values: [values('v.yaml', { token: 'F047-VALUES-BELOW-ANSWER' })],
        answers: new Map([['token', 'F047-ANSWER-WINNER']]),
      },
      environment: {},
      source: 'answer',
      winner: 'F047-ANSWER-WINNER',
      candidates: ['F047-VALUES-BELOW-ANSWER', 'F047-ANSWER-WINNER'],
    },
    {
      layers: 'environment → --set',
      options: { overrides: new Map([['token', 'F047-SET-OVER-ENV']]) },
      environment: { RUNE_INPUT_TOKEN: 'F047-ENV-BELOW-SET' },
      source: 'set',
      winner: 'F047-SET-OVER-ENV',
      candidates: ['F047-ENV-BELOW-SET', 'F047-SET-OVER-ENV'],
    },
    {
      layers: 'environment → answer',
      options: { answers: new Map([['token', 'F047-ANSWER-OVER-ENV']]) },
      environment: { RUNE_INPUT_TOKEN: 'F047-ENV-BELOW-ANSWER' },
      source: 'answer',
      winner: 'F047-ANSWER-OVER-ENV',
      candidates: ['F047-ENV-BELOW-ANSWER', 'F047-ANSWER-OVER-ENV'],
    },
    {
      layers: '--set → answer',
      options: {
        overrides: new Map([['token', 'F047-SET-BELOW-ANSWER']]),
        answers: new Map([['token', 'F047-ANSWER-OVER-SET']]),
      },
      environment: {},
      source: 'answer',
      winner: 'F047-ANSWER-OVER-SET',
      candidates: ['F047-SET-BELOW-ANSWER', 'F047-ANSWER-OVER-SET'],
    },
  ] as const)(
    'registers both candidates for $layers without changing precedence',
    ({ options, environment, source, winner, candidates }) => {
      const secrets = new SecretRegistry();
      const resolution = resolve(manifest, { ...options, secrets }, environment);
      const state = resolution.byId.get('token');

      expect(state?.source).toBe(source);
      expect(revealForTest(state?.value)).toBe(winner);
      expect(secrets.size).toBe(candidates.length);
      expect(secrets.mask(candidates.join('/'))).toBe(candidates.map(() => '***').join('/'));
    },
  );

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

    expect(isSecretString(resolution.byId.get('token')?.value)).toBe(true);
    expect(secrets.size).toBe(1);
    expect(secrets.mask('logging in with hunter2-and-more')).toBe('logging in with ***');
  });

  it.each([
    {
      layer: '--set',
      options: { overrides: new Map([['token', 'F045-SET-WINNER']]) },
      source: 'set',
      winner: 'F045-SET-WINNER',
    },
    {
      layer: 'answer',
      options: { answers: new Map([['token', 'F045-ANSWER-WINNER']]) },
      source: 'answer',
      winner: 'F045-ANSWER-WINNER',
    },
  ] as const)(
    'keeps the $layer winner and inherited environment secret in the masking snapshot',
    ({ options, source, winner }) => {
      const inherited = 'F045-INHERITED-ENVIRONMENT';
      const secrets = new SecretRegistry();
      const resolution = resolve(
        manifest,
        { ...options, secrets },
        { RUNE_INPUT_TOKEN: inherited },
      );
      const state = resolution.byId.get('token');

      expect(state?.source).toBe(source);
      expect(isSecretString(state?.value)).toBe(true);
      expect(revealForTest(state?.value)).toBe(winner);
      expect(resolution.warnings).toEqual([]);
      expect(secrets.size).toBe(2);
      expect(secrets.mask(`${winner}/${inherited}`)).toBe('***/***');
    },
  );

  it('does not warn when an optional secret is absent', () => {
    const optional = manifestOf('inputs:', '  token:', '    type: secret', '    required: false');
    const secrets = new SecretRegistry();
    const resolution = resolve(optional, { secrets });

    expect(resolution.warnings).toEqual([]);
    expect(isSecretString(resolution.byId.get('token')?.value)).toBe(true);
    expect(revealForTest(resolution.byId.get('token')?.value)).toBe('');
    expect(resolution.missing).toEqual([]);
    expect(secrets.size).toBe(0);
  });

  it('warns when an optional secret is explicitly empty', () => {
    const optional = manifestOf('inputs:', '  token:', '    type: secret', '    required: false');
    const secrets = new SecretRegistry();
    const resolution = resolve(optional, { overrides: new Map([['token', '']]), secrets });

    expect(resolution.warnings).toEqual([
      'token cannot be masked reliably: all or part of its value may appear in logs; it needs non-empty content, and each content line must be at least 4 characters after trimming whitespace',
    ]);
    expect(isSecretString(resolution.byId.get('token')?.value)).toBe(true);
    expect(revealForTest(resolution.byId.get('token')?.value)).toBe('');
    expect(resolution.missing).toEqual([]);
    expect(secrets.size).toBe(0);
  });

  it('warns when a required secret is explicitly empty', () => {
    const secrets = new SecretRegistry();
    const resolution = resolve(manifest, { overrides: new Map([['token', '']]), secrets });

    expect(resolution.warnings).toEqual([
      'token cannot be masked reliably: all or part of its value may appear in logs; it needs non-empty content, and each content line must be at least 4 characters after trimming whitespace',
    ]);
    expect(resolution.missing).toEqual(['token']);
    expect(secrets.size).toBe(0);
  });

  it('publishes the matcher primed while redacting a successful warning', () => {
    const secret = 'F055-PUBLISHED-PRIMED-SECRET';
    const secrets = new SecretRegistry();
    const sort = vi.spyOn(Array.prototype, 'sort');
    const registeredSorts = (): number =>
      sort.mock.contexts.filter(
        (value): value is string[] =>
          Array.isArray(value) &&
          value.length > 0 &&
          value.every((item) => typeof item === 'string'),
      ).length;

    try {
      const resolution = resolve(disabledSecret, {
        overrides: new Map([['token', secret]]),
        secrets,
      });
      const sortsAfterResolve = registeredSorts();

      expect(resolution.warnings).toEqual([
        'token was set from --set, but its condition is false — the value is ignored',
      ]);
      expect(sortsAfterResolve).toBe(1);
      expect(secrets.mask(secret)).toBe('***');
      expect(registeredSorts()).toBe(sortsAfterResolve);
    } finally {
      sort.mockRestore();
    }
  });

  it('reuses a primed union matcher while redacting a late recursive failure', () => {
    const active = 'F055-ACTIVE-CACHE-SECRET';
    const staged = 'F055-STAGED-CACHE-SECRET';
    const withLateCause = manifestOf(
      'inputs:',
      '  token:',
      '    type: secret',
      '  note:',
      '    type: text',
      '    pattern: "x+"',
      '  directory:',
      '    type: directory',
      '    default: "${env.TRIGGER}"',
    );
    const cause = new ResolutionError('RUNE-301', `cannot resolve ${active}/${staged}`);
    const baseContext = contextFor(withLateCause);
    const context: RuntimeContext = {
      ...baseContext,
      valueOf: () => {
        throw cause;
      },
    };
    const secrets = new SecretRegistry();
    secrets.register(active);
    const sort = vi.spyOn(Array.prototype, 'sort');
    const registeredSorts = (): number =>
      sort.mock.contexts.filter(
        (value): value is string[] =>
          Array.isArray(value) &&
          value.length > 0 &&
          value.every((item) => typeof item === 'string'),
      ).length;
    let thrown: unknown;
    let matcherSorts = 0;

    try {
      resolveInputsWithRegistry(
        {
          manifest: withLateCause,
          context,
          overrides: new Map([
            ['token', staged],
            ['note', `${active}/${staged}`],
          ]),
        },
        secrets,
      );
    } catch (error) {
      thrown = error;
    } finally {
      matcherSorts = registeredSorts();
      sort.mockRestore();
    }

    expect(thrown).toBeInstanceOf(ResolutionError);
    const error = thrown as ResolutionError;
    expect(error.code).toBe('RUNE-301');
    expect(error.cause).toBe(cause);
    expect(matcherSorts).toBe(1);
    for (const sentinel of [active, staged]) {
      expect(publicErrorSurfaces(error).join('\n')).not.toContain(sentinel);
    }
    expect(secrets.size).toBe(1);
    expect(secrets.mask(active)).toBe('***');
    expect(secrets.mask(staged)).toBe(staged);
  });

  it('leaves a prefilled registry unchanged when an unknown key rejects resolution', () => {
    const secrets = existingRegistry();
    const error = inputError(manifest, {
      overrides: new Map([
        ['token', 'candidate-secret'],
        ['unknown', 'value'],
      ]),
      secrets,
    });

    expect(error.code).toBe('RUNE-203');
    expectExistingRegistryUnchanged(secrets);
  });

  it('rejects a near-5-MiB values secret before matcher construction or publication', () => {
    const prefix = 'F053-LARGE-VALUES-SECRET-PREFIX';
    const suffix = 'F053-LARGE-VALUES-SECRET-SUFFIX';
    const candidate = `${prefix}${'x'.repeat(5 * 1_024 * 1_024 - 2_048)}${suffix}`;
    const secrets = existingRegistry();
    const error = inputError(manifest, {
      values: [values('large-values.yaml', { token: candidate })],
      secrets,
    });

    expect(error.code).toBe('RUNE-202');
    expect(error.message).toBe(
      'the total size of secret input values exceeds the masking safety limit',
    );
    expect(error.message).not.toContain(String(candidate.length));
    const surfaces = publicErrorSurfaces(error).join('\n');
    expect(surfaces).not.toContain(prefix);
    expect(surfaces).not.toContain(suffix);
    expectExistingRegistryUnchanged(secrets);
  });

  it('counts every shadowed values, environment, set, and answer candidate atomically', () => {
    const candidateLength = Math.floor(MAX_SECRET_REGISTRY_CODE_UNITS / 5) + 1;
    const labels = ['F053-BASE', 'F053-OVERLAY', 'F053-ENV', 'F053-SET', 'F053-ANSWER'];
    const candidates = labels.map((label, index) => label.padEnd(candidateLength, String(index)));
    const [base, overlay, inherited, set, answer] = candidates as [
      string,
      string,
      string,
      string,
      string,
    ];
    const secrets = existingRegistry();
    const error = inputError(
      manifest,
      {
        values: [values('base.yaml', { token: base }), values('overlay.yaml', { token: overlay })],
        overrides: new Map([['token', set]]),
        answers: new Map([['token', answer]]),
        secrets,
      },
      { RUNE_INPUT_TOKEN: inherited },
    );

    expect(candidates.reduce((total, candidate) => total + candidate.length, 0)).toBeGreaterThan(
      MAX_SECRET_REGISTRY_CODE_UNITS,
    );
    expect(error.code).toBe('RUNE-202');
    expect(error.message).toBe(
      'the total size of secret input values exceeds the masking safety limit',
    );
    const surfaces = publicErrorSurfaces(error).join('\n');
    for (const label of labels) {
      expect(surfaces).not.toContain(label);
    }
    expectExistingRegistryUnchanged(secrets);
  });

  it('fails closed when the active and staged registry union exceeds the budget', () => {
    const activePrefix = 'F053-ACTIVE-UNION-SECRET';
    const stagedPrefix = 'F053-STAGED-UNION-SECRET';
    const candidateLength = MAX_SECRET_REGISTRY_CODE_UNITS / 2 + 1;
    const activeSecret = activePrefix.padEnd(candidateLength, 'a');
    const stagedSecret = stagedPrefix.padEnd(candidateLength, 'b');
    const secrets = new SecretRegistry();
    secrets.register(activeSecret);

    const error = inputError(manifest, {
      overrides: new Map([['token', stagedSecret]]),
      secrets,
    });

    expect(error.code).toBe('RUNE-202');
    expect(error.message).toBe(
      'the total size of secret input values exceeds the masking safety limit',
    );
    const surfaces = publicErrorSurfaces(error).join('\n');
    expect(surfaces).not.toContain(activePrefix);
    expect(surfaces).not.toContain(stagedPrefix);
    expect(secrets.size).toBe(1);
    expect(secrets.register(activeSecret)).toBe(true);
    expect(secrets.size).toBe(1);
  });

  it('leaves a prefilled registry unchanged when a later input is invalid', () => {
    const withInvalidLaterInput = manifestOf(
      'inputs:',
      '  token:',
      '    type: secret',
      '  port:',
      '    type: text',
      '    pattern: "[0-9]+"',
    );
    const secrets = existingRegistry();
    const error = inputError(withInvalidLaterInput, {
      overrides: new Map([
        ['token', 'candidate-secret'],
        ['port', 'not-a-port'],
      ]),
      secrets,
    });

    expect(error.code).toBe('RUNE-202');
    expectExistingRegistryUnchanged(secrets);
  });

  it('redacts active and staged secrets from an aggregate input error', () => {
    const before = 'F030-BEFORE-SECRET';
    const after = 'F030-AFTER-SECRET';
    const existing = 'F030-EXISTING-SECRET';
    const withInvalidMiddleInput = manifestOf(
      'inputs:',
      '  before:',
      '    type: secret',
      '  invalid:',
      '    type: text',
      '    pattern: "x+"',
      '  after:',
      '    type: secret',
    );
    const secrets = new SecretRegistry();
    secrets.register(existing);
    const error = inputError(withInvalidMiddleInput, {
      overrides: new Map([
        ['before', before],
        ['invalid', `${existing}/${before}/${after}`],
        ['after', after],
      ]),
      secrets,
    });

    expect(error).toBeInstanceOf(InputError);
    expect(error.code).toBe('RUNE-202');
    expect(exitCodeFor(error)).toBe(4);
    expect(error.message).toContain('"***/***/***" does not match x+');
    for (const sentinel of [existing, before, after]) {
      expect(publicErrorSurfaces(error).join('\n')).not.toContain(sentinel);
    }
    expect(secrets.size).toBe(1);
    expect(secrets.mask(existing)).toBe('***');
    expect(secrets.mask(before)).toBe(before);
    expect(secrets.mask(after)).toBe(after);
  });

  it('preserves only formatter-owned newlines in an aggregate input error message', () => {
    const active = 'F059-ACTIVE-SECRET';
    const staged = 'F059-STAGED-SECRET';
    const displayName = `${active}-${staged}${DIAGNOSTIC_CONTROLS}.yaml`;
    const unknown = `unknown${DIAGNOSTIC_CONTROLS}`;
    const withInvalidValues = manifestOf(
      'inputs:',
      '  token:',
      '    type: secret',
      '  note:',
      '    type: text',
      '    pattern: "x+"',
    );
    const secrets = new SecretRegistry();
    secrets.register(active);
    const error = inputError(withInvalidValues, {
      values: [
        values(displayName, {
          token: staged,
          note: `${active}/${staged}${DIAGNOSTIC_CONTROLS}`,
          [unknown]: 'value',
        }),
      ],
      secrets,
    });

    expect(error).toBeInstanceOf(InputError);
    expect(error.code).toBe('RUNE-202');
    expect(error.issues).toHaveLength(2);
    expect(error.message).toBe(formatIssues(error.issues));

    const messageLines = error.message.split('\n');
    expect(messageLines).toHaveLength(error.issues.length);
    expect(error.message).not.toBe(messageLines.join('\\n'));
    expect(error.issues.some((issue) => issue.message.includes('\\n'))).toBe(true);
    for (const line of messageLines) {
      expect(hasRawDiagnosticControl(line)).toBe(false);
    }

    const stackLines = error.stack?.split('\n') ?? [];
    expect(stackLines[0]).toContain('\\n');
    expect(hasRawDiagnosticControl(stackLines[0] ?? '')).toBe(false);
    expect(stackLines.slice(1).some((line) => line.startsWith('    at '))).toBe(true);

    for (const sentinel of [active, staged]) {
      expect(publicErrorSurfaces(error).join('\n')).not.toContain(sentinel);
    }
    expect(secrets.size).toBe(1);
    expect(secrets.mask(active)).toBe('***');
    expect(secrets.mask(staged)).toBe(staged);
  });

  it('redacts active and staged secrets from every located input-error surface', () => {
    const active = 'F040-ACTIVE-LOCATION-SECRET';
    const staged = 'F040-STAGED-LOCATION-SECRET';
    const displayName = `${active}-${staged}.yaml`;
    const withLocatedInvalidValue = manifestOf(
      'inputs:',
      '  token:',
      '    type: secret',
      '  note:',
      '    type: text',
      '    pattern: "x+"',
    );
    const document = valuesFromFile(`token: ${staged}\nnote: invalid\n`, displayName);
    const secrets = new SecretRegistry();
    secrets.register(active);
    const originalFromIssues = InputError.fromIssues;
    let constructed: InputError | undefined;
    let locationDescriptor: PropertyDescriptor | undefined;
    let issuesDescriptor: PropertyDescriptor | undefined;
    const fromIssues = vi.spyOn(InputError, 'fromIssues').mockImplementation((code, issues) => {
      const error = originalFromIssues(code, issues);
      constructed = error;
      locationDescriptor = Object.getOwnPropertyDescriptor(error, 'location');
      issuesDescriptor = Object.getOwnPropertyDescriptor(error, 'issues');
      return error;
    });
    let thrown: unknown;
    try {
      resolve(withLocatedInvalidValue, { values: [document], secrets });
    } catch (error) {
      thrown = error;
    } finally {
      fromIssues.mockRestore();
    }

    expect(thrown).toBeInstanceOf(InputError);
    const error = thrown as InputError;
    expect(error).toBe(constructed);
    expect(error.name).toBe('InputError');
    expect(error.code).toBe('RUNE-202');
    expect(exitCodeFor(error)).toBe(4);
    expect(error.location).toEqual({ file: '***-***.yaml', line: 2, column: 1 });
    expect(error.issues[0]?.location).toEqual({ file: '***-***.yaml', line: 2, column: 1 });
    expect({
      ...Object.getOwnPropertyDescriptor(error, 'location'),
      value: locationDescriptor?.value,
    }).toEqual(locationDescriptor);
    expect({
      ...Object.getOwnPropertyDescriptor(error, 'issues'),
      value: issuesDescriptor?.value,
    }).toEqual(issuesDescriptor);
    for (const sentinel of [active, staged]) {
      expect(error.message).not.toContain(sentinel);
      expect(error.stack).not.toContain(sentinel);
      expect(JSON.stringify(error)).not.toContain(sentinel);
      expect(inspect(error)).not.toContain(sentinel);
    }
    expect(secrets.size).toBe(1);
    expect(secrets.mask(active)).toBe('***');
    expect(secrets.mask(staged)).toBe(staged);
  });

  it('redacts collected problems, issue aliases and candidate snapshots', () => {
    const before = 'F030-COLLECT-BEFORE';
    const after = 'F030-COLLECT-AFTER';
    const existing = 'F030-COLLECT-EXISTING';
    const withRejectedValues = manifestOf(
      'inputs:',
      '  before:',
      '    type: secret',
      '  note:',
      '    type: text',
      '    pattern: "x+"',
      '  tools:',
      '    type: multiselect',
      '    options: [git]',
      '  after:',
      '    type: secret',
    );
    const secrets = new SecretRegistry();
    secrets.register(existing);
    const resolution = resolve(withRejectedValues, {
      overrides: new Map([
        ['before', before],
        ['note', `${existing}/${before}/${after}`],
        ['after', after],
      ]),
      answers: new Map([['tools', [existing, before, after]]]),
      invalidValues: 'collect',
      secrets,
    });
    const note = rejectionFor(resolution, 'note');
    const tools = rejectionFor(resolution, 'tools');

    expect(resolution.problems).toHaveLength(2);
    expect(note.candidate).toBe('***/***/***');
    expect(note.issue).toBe(resolution.problems[0]);
    expect(tools.candidate).toEqual(['***', '***', '***']);
    expect(Object.isFrozen(tools.candidate)).toBe(true);
    expect(tools.issue).toBe(resolution.problems[1]);
    for (const sentinel of [existing, before, after]) {
      expect(inspect(resolution)).not.toContain(sentinel);
      expect(JSON.stringify(resolution)).not.toContain(sentinel);
    }
    expect(secrets.size).toBe(2);
    expect(secrets.mask(existing)).toBe(existing);
    expect(secrets.mask(before)).toBe('***');
    expect(secrets.mask(after)).toBe('***');
  });

  it('redacts collected issue locations without mutating their values document', () => {
    const active = 'F040-COLLECT-ACTIVE-SECRET';
    const staged = 'F040-COLLECT-STAGED-SECRET';
    const displayName = `${active}-${staged}.yaml`;
    const withLocatedRejection = manifestOf(
      'inputs:',
      '  token:',
      '    type: secret',
      '  note:',
      '    type: text',
      '    pattern: "x+"',
    );
    const document = valuesFromFile(`token: ${staged}\nnote: invalid\n`, displayName);
    const sourceMap = document.sourceMap;
    if (sourceMap === undefined) {
      throw new Error('expected the parsed value to have a source map');
    }
    const originalLocation = sourceMap.best(['note']);
    if (originalLocation === undefined) {
      throw new Error('expected the parsed value to have a source location');
    }
    Object.freeze(originalLocation);
    const secrets = new SecretRegistry();
    secrets.register(active);

    const resolution = resolve(withLocatedRejection, {
      values: [document],
      invalidValues: 'collect',
      secrets,
    });
    const issue = resolution.problems[0];
    const rejection = rejectionFor(resolution, 'note');

    expect(issue?.location).toEqual({ file: '***-***.yaml', line: 2, column: 1 });
    expect(issue?.location).not.toBe(originalLocation);
    expect(rejection.issue).toBe(issue);
    expect(rejection.issue.location).toBe(issue?.location);
    expect(document.file).toBe(displayName);
    expect(document.sourceMap).toBe(sourceMap);
    expect(sourceMap.best(['note'])).toBe(originalLocation);
    expect(originalLocation).toEqual({ file: displayName, line: 2, column: 1 });
    for (const sentinel of [active, staged]) {
      expect(JSON.stringify(resolution)).not.toContain(sentinel);
      expect(inspect(resolution)).not.toContain(sentinel);
    }
    expect(secrets.size).toBe(1);
    expect(secrets.mask(active)).toBe(active);
    expect(secrets.mask(staged)).toBe('***');
  });

  it('leaves a prefilled registry unchanged when a later default cannot resolve', () => {
    const withUnresolvedLaterDefault = manifestOf(
      'inputs:',
      '  token:',
      '    type: secret',
      '  directory:',
      '    type: directory',
      '    default: "${env.NOT_SET_ANYWHERE}/app"',
    );
    const secrets = existingRegistry();

    expect(() =>
      resolve(withUnresolvedLaterDefault, {
        overrides: new Map([['token', 'candidate-secret']]),
        secrets,
      }),
    ).toThrow(ResolutionError);
    expectExistingRegistryUnchanged(secrets);
  });

  it('redacts a staged secret from a later resolution error and its cause', () => {
    const sentinel = 'R4_SECRET_ENV';
    const withUnresolvedLaterDefault = manifestOf(
      'inputs:',
      '  token:',
      '    type: secret',
      '  directory:',
      '    type: directory',
      `    default: "\${env.${sentinel}}/app"`,
    );
    const secrets = existingRegistry();
    let thrown: unknown;
    try {
      resolve(withUnresolvedLaterDefault, {
        overrides: new Map([['token', sentinel]]),
        secrets,
      });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(ResolutionError);
    const error = thrown as ResolutionError;
    expect(error.code).toBe('RUNE-301');
    expect(exitCodeFor(error)).toBe(5);
    expect(error.cause).toBeInstanceOf(ResolutionError);
    expect(publicErrorSurfaces(error).join('\n')).not.toContain(sentinel);
    expectExistingRegistryUnchanged(secrets);
  });

  it('redacts a recursive RuneError cause location without replacing the cause', () => {
    const sentinel = 'F040-RECURSIVE-LOCATION-SECRET';
    const withLocatedCause = manifestOf(
      'inputs:',
      '  token:',
      '    type: secret',
      '  directory:',
      '    type: directory',
      '    default: "${env.TRIGGER}"',
    );
    const originalLocation = Object.freeze({
      file: `existing-secret-${sentinel}.yaml`,
      line: 7,
      column: 11,
    });
    const cause = new ResolutionError('RUNE-301', `cannot resolve ${sentinel}`, {
      location: originalLocation,
    });
    const causeLocationDescriptor = Object.getOwnPropertyDescriptor(cause, 'location');
    const baseContext = contextFor(withLocatedCause);
    const context: RuntimeContext = {
      ...baseContext,
      valueOf: () => {
        throw cause;
      },
    };
    const secrets = existingRegistry();
    let thrown: unknown;
    try {
      resolveInputsWithRegistry(
        {
          manifest: withLocatedCause,
          context,
          overrides: new Map([['token', sentinel]]),
        },
        secrets,
      );
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(ResolutionError);
    const error = thrown as ResolutionError;
    expect(error.cause).toBe(cause);
    expect(cause).toBeInstanceOf(ResolutionError);
    expect(cause.name).toBe('ResolutionError');
    expect(cause.code).toBe('RUNE-301');
    expect(exitCodeFor(cause)).toBe(5);
    expect(cause.location).toEqual({ file: '***-***.yaml', line: 7, column: 11 });
    expect(cause.issues[0]?.location).toEqual({ file: '***-***.yaml', line: 7, column: 11 });
    expect({
      ...Object.getOwnPropertyDescriptor(cause, 'location'),
      value: causeLocationDescriptor?.value,
    }).toEqual(causeLocationDescriptor);
    expect(originalLocation).toEqual({
      file: `existing-secret-${sentinel}.yaml`,
      line: 7,
      column: 11,
    });
    expect(publicErrorSurfaces(error).join('\n')).not.toContain(sentinel);
    expect(publicErrorSurfaces(error).join('\n')).not.toContain('existing-secret');
    expectExistingRegistryUnchanged(secrets);
  });

  it.each([
    ['Named', 'message', 'Named: message'],
    ['Named', '', 'Named'],
    ['', 'message', 'message'],
    ['', '', ''],
  ])(
    'preserves native in-place header semantics for name=%j message=%j',
    (name, message, header) => {
      const cause = new ResolutionError('RUNE-301', message);
      cause.name = name;
      cause.stack = `${header}\n    at resolver`;

      const error = resolveWithRecursiveCause(cause, 'unrelated-secret');

      expect(error.cause).toBe(cause);
      expect(cause.name).toBe(name);
      expect(cause.message).toBe(message);
      expect(String(cause)).toBe(header);
      expect(cause.stack).toBe(`${header}\n    at resolver`);
    },
  );

  it('escapes injected stack headers recursively while retaining real frame separators', () => {
    const secret = 'pass\nword';
    const injectedMessage =
      `cannot resolve ${secret}${DIAGNOSTIC_CONTROLS}` + '\n    at forged (attacker.js:1:1)';
    const withInjectedCause = manifestOf(
      'inputs:',
      '  token:',
      '    type: secret',
      '  directory:',
      '    type: directory',
      '    default: "${env.TRIGGER}"',
    );
    const cause = new ResolutionError('RUNE-301', injectedMessage);
    const baseContext = contextFor(withInjectedCause);
    const context: RuntimeContext = {
      ...baseContext,
      valueOf: () => {
        throw cause;
      },
    };
    let thrown: unknown;
    try {
      resolveInputs({
        manifest: withInjectedCause,
        context,
        overrides: new Map([['token', secret]]),
      });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(ResolutionError);
    const error = thrown as ResolutionError;
    expect(error.cause).toBe(cause);

    for (const current of [error, cause]) {
      expect(current.message).not.toContain('pass');
      expect(current.message).not.toContain('word');
      expectSafeDiagnostic(current.message);

      const stack = current.stack;
      expect(stack).toBeDefined();
      const [header, ...frames] = stack!.split('\n');
      expect(header).not.toContain('pass');
      expect(header).not.toContain('word');
      expect(header).toContain('***');
      for (const visible of VISIBLE_DIAGNOSTIC_ESCAPES) {
        expect(header).toContain(visible);
      }
      expect(stack).not.toContain('\n    at forged');
      expect(frames.some((frame) => frame.startsWith('    at '))).toBe(true);
      expect(stack).not.toContain('\r');
      expect(stack).not.toContain('\u001b');
      expect(stack).not.toContain('\u0007');
      expect(stack).not.toContain('\u0085');
      expect(stack).not.toContain('\u2028');
      expect(stack).not.toContain('\u2029');
    }
  });

  it('masks and escapes every recursive stack frame while retaining only LF separators', () => {
    const secret = 'F054-CUSTOM-STACK-SECRET';
    const frameControls = '\r\u001b\u0007\u007f\u0085\u2028\u2029';
    const originalPrepareStackTrace = Error.prepareStackTrace;
    Error.prepareStackTrace = (current) =>
      `${current.name}: ${current.message}\r\n    at resolver (${secret}${frameControls}:1:1)\rtrailer`;

    let cause: ResolutionError;
    let error: ResolutionError;
    try {
      cause = new ResolutionError('RUNE-301', 'cannot resolve custom stack');
      error = resolveWithRecursiveCause(cause, secret);
    } finally {
      Error.prepareStackTrace = originalPrepareStackTrace;
    }

    expect(error.cause).toBe(cause);
    for (const current of [error, cause]) {
      expect(current).toBeInstanceOf(ResolutionError);
      expect(current.name).toBe('ResolutionError');
      expect(current.code).toBe('RUNE-301');
      expect(exitCodeFor(current)).toBe(5);

      const stack = current.stack!;
      expect(stack).not.toContain(secret);
      expect(stack).toContain('***');
      expect(stack.split('\n')).toHaveLength(2);
      expect(stack.split('\n')[1]).toContain('    at resolver');
      expect(hasRawDiagnosticControl(stack.split('\n').join(''))).toBe(false);
      for (const visible of [
        '\\r',
        '\\u001b',
        '\\u0007',
        '\\u007f',
        '\\u0085',
        '\\u2028',
        '\\u2029',
      ]) {
        expect(stack).toContain(visible);
      }
    }
  });

  it('fully escapes a recursive stack whose header does not match', () => {
    const secret = 'F054-FALLBACK-STACK-SECRET';
    const cause = new ResolutionError('RUNE-301', 'cannot resolve fallback stack');
    const rawStack = `custom stack ${secret}${DIAGNOSTIC_CONTROLS}\u007f\n    at forged (attack.js:1:1)`;
    cause.stack = rawStack;

    const error = resolveWithRecursiveCause(cause, secret);

    expect(error.cause).toBe(cause);
    expect(cause).toBeInstanceOf(ResolutionError);
    expect(cause.name).toBe('ResolutionError');
    expect(cause.code).toBe('RUNE-301');
    expect(exitCodeFor(cause)).toBe(5);
    expect(cause.stack).not.toContain(secret);
    expect(cause.stack).toContain('***');
    expect(cause.stack!.split('\n')).toHaveLength(rawStack.split('\n').length);
    expect(hasRawDiagnosticControl(cause.stack!.split('\n').join(''))).toBe(false);
    for (const visible of [...VISIBLE_DIAGNOSTIC_ESCAPES, '\\u007f'].filter(
      (escape) => escape !== '\\n',
    )) {
      expect(cause.stack).toContain(visible);
    }
  });

  it('redacts a later-declared secret from an earlier resolution error atomically', () => {
    const sentinel = 'F038_LATER_DECLARED_SECRET';
    const withUnresolvedEarlyDefault = manifestOf(
      'inputs:',
      '  directory:',
      '    type: directory',
      `    default: "\${env.${sentinel}}/app"`,
      '  token:',
      '    type: secret',
    );
    const secrets = existingRegistry();
    let thrown: unknown;
    try {
      resolve(withUnresolvedEarlyDefault, {
        overrides: new Map([['token', sentinel]]),
        secrets,
      });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(ResolutionError);
    const error = thrown as ResolutionError;
    expect(error.code).toBe('RUNE-301');
    expect(error.cause).toBeInstanceOf(ResolutionError);
    expect(error.issues).not.toHaveLength(0);
    expect(publicErrorSurfaces(error).join('\n')).not.toContain(sentinel);
    expect(secrets.size).toBe(1);
    expect(secrets.mask('existing-secret')).toBe('***');
    expect(secrets.mask(sentinel)).toBe(sentinel);
  });

  it('uses a disabled secret to redact later thrown and collected input diagnostics', () => {
    const sentinel = 'F038_DISABLED_DIAGNOSTIC_SECRET';
    const withDisabledSecret = manifestOf(
      'inputs:',
      '  enabled:',
      '    type: boolean',
      '    default: false',
      '  token:',
      '    type: secret',
      '    when: "${enabled}"',
      '  note:',
      '    type: text',
      '    pattern: "x+"',
    );
    const supplied = new Map([
      ['token', sentinel],
      ['note', `prefix/${sentinel}/suffix`],
    ]);
    const thrownSecrets = existingRegistry();
    const error = inputError(withDisabledSecret, {
      overrides: supplied,
      secrets: thrownSecrets,
    });

    expect(publicErrorSurfaces(error).join('\n')).not.toContain(sentinel);
    expect(thrownSecrets.size).toBe(1);
    expect(thrownSecrets.mask(sentinel)).toBe(sentinel);

    const collectedSecrets = new SecretRegistry();
    const resolution = resolve(withDisabledSecret, {
      overrides: supplied,
      invalidValues: 'collect',
      secrets: collectedSecrets,
    });
    const rejection = rejectionFor(resolution, 'note');

    expect(rejection.candidate).toBe('prefix/***/suffix');
    expect(rejection.issue).toBe(resolution.problems[0]);
    expect(inspect(resolution)).not.toContain(sentinel);
    expect(collectedSecrets.mask(sentinel)).toBe('***');
  });

  it('never exposes JSON parser excerpts of a registered secret', () => {
    const prefix = 'F051-MALFORMED-JSON-SECRET-PREFIX';
    const suffix = 'F051-MALFORMED-JSON-SECRET-SUFFIX';
    const secret = `${prefix}-${'secret-body-'.repeat(24)}${suffix}`;
    const malformed = `["${secret}`;
    const expectedMessage =
      'tools (from --set tools=…): starts with "[" and is therefore read as a JSON array, but it is not valid JSON';
    const withInvalidMultiselect = manifestOf(
      'inputs:',
      '  token:',
      '    type: secret',
      '  tools:',
      '    type: multiselect',
      '    options: [git]',
    );
    const supplied = new Map([
      ['token', secret],
      ['tools', malformed],
    ]);

    const thrownSecrets = new SecretRegistry();
    thrownSecrets.register(secret);
    const error = inputError(withInvalidMultiselect, {
      overrides: supplied,
      secrets: thrownSecrets,
    });

    expect(error.message).toBe(expectedMessage);
    expect(error.issues).toMatchObject([{ code: 'RUNE-202', message: expectedMessage }]);
    const thrownSurfaces = publicErrorSurfaces(error).join('\n');
    for (const fragment of [secret, prefix, suffix]) {
      expect(thrownSurfaces).not.toContain(fragment);
    }
    expect(thrownSecrets.mask(secret)).toBe('***');

    const collectedSecrets = new SecretRegistry();
    collectedSecrets.register(secret);
    const resolution = resolve(withInvalidMultiselect, {
      overrides: supplied,
      invalidValues: 'collect',
      secrets: collectedSecrets,
    });
    const rejection = rejectionFor(resolution, 'tools');
    const collectedSurfaces = [
      rejection.issue.message,
      String(rejection.candidate),
      JSON.stringify(rejection),
      inspect(rejection),
      JSON.stringify(resolution),
      inspect(resolution),
    ].join('\n');

    expect(resolution.problems).toMatchObject([{ code: 'RUNE-202', message: expectedMessage }]);
    expect(rejection.issue).toBe(resolution.problems[0]);
    expect(rejection.candidate).toBe('["***');
    for (const fragment of [secret, prefix, suffix]) {
      expect(collectedSurfaces).not.toContain(fragment);
    }
    expect(collectedSecrets.mask(secret)).toBe('***');
  });

  it('masks a control-bearing secret before a non-secret diagnostic is escaped', () => {
    const secret = 'pass\nword"\u001bmore';
    const withInvalidLaterInput = manifestOf(
      'inputs:',
      '  token:',
      '    type: secret',
      '  note:',
      '    type: text',
      '    pattern: "x+"',
    );
    const resolution = resolve(withInvalidLaterInput, {
      overrides: new Map([
        ['token', secret],
        ['note', secret],
      ]),
      invalidValues: 'collect',
    });
    const rejection = rejectionFor(resolution, 'note');

    expect(rejection.issue.message).toBe('note (from --set note=…): "***" does not match x+');
    expect(rejection.candidate).toBe('***');
    expect(JSON.stringify(resolution.problems)).not.toContain('pass');
    expect(JSON.stringify(resolution.problems)).not.toContain('word');
    expect(rejection.issue.message).not.toContain('\\n');
    expect(rejection.issue.message).not.toContain('\\u001b');
    expect(hasRawDiagnosticControl(rejection.issue.message)).toBe(false);
  });

  it('fails closed when rejection escaping creates a registered literal', () => {
    const renderedSecret = String.raw`\u001b`;
    const manifest = manifestOf(
      'inputs:',
      '  token:',
      '    type: secret',
      '  note:',
      '    type: text',
      '    pattern: "x+"',
    );
    const resolution = resolve(manifest, {
      overrides: new Map([
        ['token', renderedSecret],
        ['note', '\u001b'],
      ]),
      invalidValues: 'collect',
    });

    expect(rejectionFor(resolution, 'note').issue.message).not.toContain(renderedSecret);
  });

  it('uses an overridden environment secret to redact thrown and collected diagnostics atomically', () => {
    const inherited = 'F045-LOWER-ENVIRONMENT-SECRET';
    const winner = 'F045-HIGHER-SET-SECRET';
    const withInvalidLaterInput = manifestOf(
      'inputs:',
      '  token:',
      '    type: secret',
      '  note:',
      '    type: text',
      '    pattern: "x+"',
    );
    const supplied = new Map([
      ['token', winner],
      ['note', `${inherited}/${winner}`],
    ]);
    const environment = { RUNE_INPUT_TOKEN: inherited };
    const thrownSecrets = existingRegistry();
    const error = inputError(
      withInvalidLaterInput,
      {
        overrides: supplied,
        secrets: thrownSecrets,
      },
      environment,
    );

    expect(error.issues[0]?.message).toContain('"***/***" does not match x+');
    expect(publicErrorSurfaces(error).join('\n')).not.toContain(inherited);
    expect(publicErrorSurfaces(error).join('\n')).not.toContain(winner);
    expect(thrownSecrets.size).toBe(1);
    expect(thrownSecrets.mask(inherited)).toBe(inherited);
    expect(thrownSecrets.mask(winner)).toBe(winner);

    const collectedSecrets = new SecretRegistry();
    const resolution = resolve(
      withInvalidLaterInput,
      { overrides: supplied, invalidValues: 'collect', secrets: collectedSecrets },
      environment,
    );
    const token = resolution.byId.get('token');

    expect(token?.source).toBe('set');
    expect(revealForTest(token?.value)).toBe(winner);
    expect(rejectionFor(resolution, 'note').candidate).toBe('***/***');
    expect(resolution.problems[0]?.message).toContain('"***/***" does not match x+');
    expect(collectedSecrets.size).toBe(2);
    expect(collectedSecrets.mask(`${inherited}/${winner}`)).toBe('***/***');
  });

  it('redacts every shadowed layer from thrown and collected diagnostics', () => {
    const sentinels = [
      'F047-BASE-SECRET',
      'F047-OVERLAY-SECRET',
      'F047-ENV-SECRET',
      'F047-SET-SECRET',
      'F047-ANSWER-SECRET',
    ];
    const [base, overlay, inherited, set, answer] = sentinels as [
      string,
      string,
      string,
      string,
      string,
    ];
    const invalid = sentinels.join('/');
    const displayName = `${sentinels.join('-')}.yaml`;
    const withInvalidLaterInput = manifestOf(
      'inputs:',
      '  token:',
      '    type: secret',
      '  note:',
      '    type: text',
      '    pattern: "x+"',
    );
    const documents = [
      values('base.yaml', { token: base }),
      valuesFromFile(`token: ${overlay}\nnote: ${invalid}\n`, displayName),
    ];
    const options = {
      values: documents,
      overrides: new Map([['token', set]]),
      answers: new Map([['token', answer]]),
    };
    const environment = { RUNE_INPUT_TOKEN: inherited };
    const expectedMaskedValue = sentinels.map(() => '***').join('/');
    const expectedMaskedFile = `${sentinels.map(() => '***').join('-')}.yaml`;
    const thrownSecrets = existingRegistry();
    const error = inputError(
      withInvalidLaterInput,
      { ...options, secrets: thrownSecrets },
      environment,
    );

    expect(error.message).toContain(`"${expectedMaskedValue}" does not match x+`);
    expect(error.issues[0]?.message).toContain(`"${expectedMaskedValue}" does not match x+`);
    expect(error.location?.file).toBe(expectedMaskedFile);
    expect(error.issues[0]?.location?.file).toBe(expectedMaskedFile);
    const thrownSurfaces = [
      ...publicErrorSurfaces(error),
      JSON.stringify(error.issues),
      error.location?.file ?? '',
    ].join('\n');
    for (const sentinel of sentinels) {
      expect(thrownSurfaces).not.toContain(sentinel);
      expect(thrownSecrets.mask(sentinel)).toBe(sentinel);
    }
    expect(thrownSecrets.size).toBe(1);

    const collectedSecrets = new SecretRegistry();
    const resolution = resolve(
      withInvalidLaterInput,
      { ...options, invalidValues: 'collect', secrets: collectedSecrets },
      environment,
    );
    const token = resolution.byId.get('token');
    const rejection = rejectionFor(resolution, 'note');

    expect(token?.source).toBe('answer');
    expect(revealForTest(token?.value)).toBe(answer);
    expect(rejection.source).toBe('values');
    expect(rejection.candidate).toBe(expectedMaskedValue);
    expect(rejection.issue).toBe(resolution.problems[0]);
    expect(rejection.issue.message).toContain(`"${expectedMaskedValue}" does not match x+`);
    expect(rejection.issue.location?.file).toBe(expectedMaskedFile);
    expect(inspect(resolution)).not.toContain(invalid);
    expect(JSON.stringify(resolution)).not.toContain(invalid);
    expect(collectedSecrets.size).toBe(sentinels.length);
    expect(collectedSecrets.mask(invalid)).toBe(expectedMaskedValue);
  });

  it.each([
    {
      layer: 'values',
      options: { values: [values('v.yaml', { token: 'F038_VALUES_SECRET' })] },
      environment: {},
      source: 'values',
      sentinel: 'F038_VALUES_SECRET',
    },
    {
      layer: 'environment',
      options: {},
      environment: { RUNE_INPUT_TOKEN: 'F038_ENVIRONMENT_SECRET' },
      source: 'environment',
      sentinel: 'F038_ENVIRONMENT_SECRET',
    },
    {
      layer: '--set',
      options: { overrides: new Map([['token', 'F038_SET_SECRET']]) },
      environment: {},
      source: 'set',
      sentinel: 'F038_SET_SECRET',
    },
    {
      layer: 'answer',
      options: { answers: new Map([['token', 'F038_ANSWER_SECRET']]) },
      environment: {},
      source: 'answer',
      sentinel: 'F038_ANSWER_SECRET',
    },
  ] as const)(
    'keeps a disabled secret supplied by $layer in the successful masking snapshot',
    ({ options, environment, source, sentinel }) => {
      const secrets = new SecretRegistry();
      const resolution = resolve(disabledSecret, { ...options, secrets }, environment);
      const state = resolution.byId.get('token');

      expect(state).toMatchObject({
        enabled: false,
        source: undefined,
        rejection: undefined,
        ignored: source,
      });
      expect(isSecretString(state?.value)).toBe(true);
      expect(revealForTest(state?.value)).toBe('');
      expect(secrets.mask(sentinel)).toBe('***');
      expect(resolution.warnings).toHaveLength(1);
      expect(resolution.warnings[0]).not.toContain(sentinel);
    },
  );

  it.each([
    { name: 'short', value: 'ab', maskable: undefined },
    { name: 'empty', value: '', maskable: undefined },
    { name: 'partly maskable multiline', value: 'long-secret\nabc', maskable: 'long-secret' },
  ])(
    'warns exactly once for a $name disabled secret and protects every maskable part',
    ({ value, maskable }) => {
      const secrets = new SecretRegistry();
      const resolution = resolve(disabledSecret, {
        overrides: new Map([['token', value]]),
        secrets,
      });

      expect(
        resolution.warnings.filter((warning) => warning.includes('cannot be masked reliably')),
      ).toHaveLength(1);
      expect(resolution.warnings).toHaveLength(2);
      expect(resolution.byId.get('token')).toMatchObject({
        enabled: false,
        ignored: 'set',
      });
      if (maskable !== undefined) {
        expect(secrets.mask(maskable)).toBe('***');
      } else {
        expect(secrets.size).toBe(0);
      }
    },
  );

  it.each([
    ['undefined', undefined],
    ['invalid object', { nested: 'F038_OBJECT_CONTENT' }],
  ] as const)(
    'keeps an authentic lower-layer secret when a higher %s candidate is not authentic',
    (_name, higher) => {
      const lower = 'F038_LOWER_LAYER_SECRET';
      const secrets = new SecretRegistry();
      const resolution = resolve(disabledSecret, {
        overrides: new Map([['token', lower]]),
        answers: new Map([['token', higher]]) as unknown as ReadonlyMap<string, InputValue>,
        invalidValues: 'collect',
        secrets,
      });

      expect(resolution.byId.get('token')).toMatchObject({
        enabled: false,
        source: undefined,
        rejection: undefined,
        ignored: 'answer',
      });
      expect(resolution.problems).toEqual([
        expect.objectContaining({ code: 'RUNE-202', message: expect.stringContaining('answer') }),
      ]);
      expect(secrets.mask(lower)).toBe('***');
      expect(secrets.size).toBe(1);
    },
  );

  it('replaces every winning and shadowed secret on the next successful resolution', () => {
    const secrets = new SecretRegistry();
    const firstCandidates = [
      'F047-FIRST-BASE',
      'F047-FIRST-OVERLAY',
      'F047-FIRST-ENV',
      'F047-FIRST-SET',
      'F047-FIRST-ANSWER',
    ];

    resolve(
      manifest,
      {
        values: [
          values('base.yaml', { token: firstCandidates[0] }),
          values('overlay.yaml', { token: firstCandidates[1] }),
        ],
        overrides: new Map([['token', firstCandidates[3]!]]),
        answers: new Map([['token', firstCandidates[4]!]]),
        secrets,
      },
      { RUNE_INPUT_TOKEN: firstCandidates[2]! },
    );
    expect(secrets.size).toBe(firstCandidates.length);
    expect(secrets.mask(firstCandidates.join('/'))).toBe(
      firstCandidates.map(() => '***').join('/'),
    );

    resolve(manifest, { overrides: new Map([['token', 'second-secret']]), secrets });
    expect(secrets.size).toBe(1);
    for (const candidate of firstCandidates) {
      expect(secrets.mask(candidate)).toBe(candidate);
    }
    expect(secrets.mask('second-secret')).toBe('***');

    resolve(manifest, { overrides: new Map([['token', 'second-secret']]), secrets });
    expect(secrets.size).toBe(1);
    expect(secrets.mask('second-secret')).toBe('***');
  });

  it('publishes every safely readable candidate when invalid values are collected', () => {
    const withRejectedSecret = manifestOf(
      'inputs:',
      '  accepted:',
      '    type: secret',
      '  rejected:',
      '    type: secret',
    );
    const secrets = existingRegistry();
    const resolution = resolve(withRejectedSecret, {
      overrides: new Map([
        ['accepted', 'current-secret'],
        ['rejected', 'shadowed-secret'],
      ]),
      answers: new Map([['rejected', undefined as unknown as InputValue]]),
      invalidValues: 'collect',
      secrets,
    });

    expect(resolution.problems).toMatchObject([{ code: 'RUNE-202' }]);
    expect(secrets.size).toBe(2);
    expect(secrets.mask('existing-secret')).toBe('existing-secret');
    expect(secrets.mask('current-secret')).toBe('***');
    expect(secrets.mask('shadowed-secret')).toBe('***');
  });

  it('registers exactly the value of an authentic opaque wrapper', () => {
    const supplied = createSecretString('omega-secret');
    const secrets = new SecretRegistry();
    const resolution = resolve(manifest, {
      answers: new Map([['token', supplied]]),
      secrets,
    });
    const resolved = resolution.byId.get('token')?.value;

    expect(resolved).toBe(supplied);
    expect(revealForTest(resolved)).toBe('omega-secret');
    expect(secrets.size).toBe(1);
    expect(secrets.mask('returned omega-secret')).toBe('returned ***');
  });

  it('registers genuine wrappers from shadowed values and --set layers', () => {
    const valuesSecret = 'F047-WRAPPED-VALUES';
    const setSecret = 'F047-WRAPPED-SET';
    const answer = 'F047-STRING-ANSWER';
    const secrets = new SecretRegistry();
    const resolution = resolve(manifest, {
      values: [values('v.yaml', { token: createSecretString(valuesSecret) })],
      overrides: new Map([['token', createSecretString(setSecret)]]) as unknown as ReadonlyMap<
        string,
        string
      >,
      answers: new Map([['token', answer]]),
      secrets,
    });

    expect(resolution.byId.get('token')?.source).toBe('answer');
    expect(revealForTest(resolution.byId.get('token')?.value)).toBe(answer);
    expect(secrets.size).toBe(3);
    expect(secrets.mask(`${valuesSecret}/${setSecret}/${answer}`)).toBe('***/***/***');
  });

  it('does not invoke proxy traps, forged wrappers or accessors while staging candidates', () => {
    let accessorCalls = 0;
    let proxyCalls = 0;
    const accessor = Object.create(null, {
      reveal: {
        get: () => {
          accessorCalls += 1;
          return () => 'F047-ACCESSOR-DECOY';
        },
      },
      toString: {
        get: () => {
          accessorCalls += 1;
          return () => 'F047-ACCESSOR-STRING-DECOY';
        },
      },
    });
    const authentic = createSecretString('F047-PROXY-DECOY');
    const forged = Object.create(Object.getPrototypeOf(authentic) as object) as SecretString;
    const proxied = new Proxy(authentic, {
      get: () => {
        proxyCalls += 1;
        throw new Error('proxy candidate was inspected');
      },
      getPrototypeOf: () => {
        proxyCalls += 1;
        throw new Error('proxy candidate prototype was inspected');
      },
    });
    const secrets = new SecretRegistry();
    const resolution = resolve(disabledSecret, {
      values: [
        values('accessor.yaml', { token: accessor }),
        values('forged.yaml', { token: forged }),
      ],
      overrides: new Map([['token', accessor]]) as unknown as ReadonlyMap<string, string>,
      answers: new Map([['token', proxied]]) as unknown as ReadonlyMap<string, InputValue>,
      invalidValues: 'collect',
      secrets,
    });

    expect(accessorCalls).toBe(0);
    expect(proxyCalls).toBe(0);
    expect(secrets.size).toBe(0);
    expect(resolution.warnings).toHaveLength(1);
    expect(resolution.warnings[0]).not.toContain('cannot be masked reliably');
    expect(resolution.problems).toEqual([
      expect.objectContaining({ code: 'RUNE-202', message: expect.stringContaining('answer') }),
    ]);
    expect(resolution.byId.get('token')).toMatchObject({
      enabled: false,
      ignored: 'answer',
    });
  });

  it('warns when a secret is too short to mask reliably', () => {
    const secrets = new SecretRegistry();
    const resolution = resolve(manifest, { overrides: new Map([['token', 'ab']]), secrets });

    expect(secrets.size).toBe(0);
    expect(resolution.warnings).toEqual([
      'token cannot be masked reliably: all or part of its value may appear in logs; it needs non-empty content, and each content line must be at least 4 characters after trimming whitespace',
    ]);
  });

  it('warns once when several shadowed candidates are partly unmaskable', () => {
    const maskableLine = 'F047-MASKABLE-LINE';
    const set = 'F047-RELIABLE-SET';
    const answer = 'F047-RELIABLE-ANSWER';
    const secrets = new SecretRegistry();
    const resolution = resolve(
      manifest,
      {
        values: [
          values('base.yaml', { token: 'ab' }),
          values('overlay.yaml', { token: `${maskableLine}\nabc` }),
        ],
        overrides: new Map([['token', set]]),
        answers: new Map([['token', answer]]),
        secrets,
      },
      { RUNE_INPUT_TOKEN: '' },
    );

    expect(resolution.byId.get('token')?.source).toBe('answer');
    expect(revealForTest(resolution.byId.get('token')?.value)).toBe(answer);
    expect(
      resolution.warnings.filter((warning) => warning.includes('cannot be masked reliably')),
    ).toEqual([
      'token cannot be masked reliably: all or part of its value may appear in logs; it needs non-empty content, and each content line must be at least 4 characters after trimming whitespace',
    ]);
    expect(secrets.mask(`${maskableLine}/${set}/${answer}`)).toBe('***/***/***');
    expect(secrets.mask('ab/abc')).toBe('ab/abc');
  });

  it.each([
    { name: 'short', inherited: 'ab', maskablePart: undefined },
    { name: 'empty', inherited: '', maskablePart: undefined },
    {
      name: 'partly maskable multiline',
      inherited: 'F045-MASKABLE-LINE\nabc',
      maskablePart: 'F045-MASKABLE-LINE',
    },
  ])(
    'warns exactly once for a $name overridden environment secret',
    ({ inherited, maskablePart }) => {
      const winner = 'F045-RELIABLE-WINNER';
      const secrets = new SecretRegistry();
      const resolution = resolve(
        manifest,
        { overrides: new Map([['token', winner]]), secrets },
        { RUNE_INPUT_TOKEN: inherited },
      );
      const reliabilityWarnings = resolution.warnings.filter((warning) =>
        warning.includes('cannot be masked reliably'),
      );

      expect(resolution.byId.get('token')?.source).toBe('set');
      expect(revealForTest(resolution.byId.get('token')?.value)).toBe(winner);
      expect(reliabilityWarnings).toHaveLength(1);
      expect(resolution.warnings).toEqual([
        'token cannot be masked reliably: all or part of its value may appear in logs; it needs non-empty content, and each content line must be at least 4 characters after trimming whitespace',
      ]);
      expect(secrets.mask(winner)).toBe('***');
      if (maskablePart !== undefined) {
        expect(secrets.mask(maskablePart)).toBe('***');
      }
    },
  );

  it('retains the overridden environment warning when other invalid values are collected', () => {
    const withRejectedInput = manifestOf(
      'inputs:',
      '  token:',
      '    type: secret',
      '  note:',
      '    type: text',
      '    pattern: "x+"',
    );
    const winner = 'F045-COLLECT-WINNER';
    const secrets = new SecretRegistry();
    const resolution = resolve(
      withRejectedInput,
      {
        overrides: new Map([
          ['token', winner],
          ['note', 'invalid'],
        ]),
        invalidValues: 'collect',
        secrets,
      },
      { RUNE_INPUT_TOKEN: 'abc' },
    );

    expect(resolution.problems).toHaveLength(1);
    expect(resolution.warnings).toHaveLength(1);
    expect(
      resolution.warnings.filter((warning) => warning.includes('cannot be masked reliably')),
    ).toHaveLength(1);
    expect(resolution.byId.get('token')?.source).toBe('set');
    expect(revealForTest(resolution.byId.get('token')?.value)).toBe(winner);
    expect(secrets.mask(winner)).toBe('***');
  });

  it('warns when a multiline secret contains a content line too short to mask', () => {
    const secrets = new SecretRegistry();
    const resolution = resolve(manifest, {
      overrides: new Map([['token', 'long-secret\nabc']]),
      secrets,
    });

    expect(secrets.mask('long-secret')).toBe('***');
    expect(secrets.mask('abc')).toBe('abc');
    expect(resolution.warnings).toEqual([
      'token cannot be masked reliably: all or part of its value may appear in logs; it needs non-empty content, and each content line must be at least 4 characters after trimming whitespace',
    ]);
  });

  it('warns when a secret has only whitespace', () => {
    const secrets = new SecretRegistry();
    const resolution = resolve(manifest, { overrides: new Map([['token', '   ']]), secrets });

    expect(secrets.size).toBe(0);
    expect(resolution.warnings).toEqual([
      'token cannot be masked reliably: all or part of its value may appear in logs; it needs non-empty content, and each content line must be at least 4 characters after trimming whitespace',
    ]);
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
  const emptyManifest = manifestOf('inputs: {}');
  const controlledSecret = 'F057 "quoted" \\ path\n\r\u001b\u0085\u2028\u2029';
  const controlledSecretYaml = '"F057 \\"quoted\\" \\\\ path\\n\\r\\u001b\\u0085\\u2028\\u2029"';
  const duplicateKeySecret = 'F058 "quoted" \\ path\n\r\u001b\u0085\u2028\u2029';
  const duplicateKeySecretYaml = '"F058 \\"quoted\\" \\\\ path\\n\\r\\u001b\\u0085\\u2028\\u2029"';

  function file(contents: string | Uint8Array): string {
    const directory = mkdtempSync(join(tmpdir(), 'rune-values-'));
    const path = join(directory, 'values.yaml');
    writeFileSync(path, contents);
    return path;
  }

  function loadError(contents: string | Uint8Array, displayName = 'values.yaml'): InputError {
    return documentError(parseValuesFile(file(contents), displayName));
  }

  function documentError(
    document: ValuesDocument,
    options: Omit<ResolveTestOptions, 'values'> = {},
    environment: Record<string, string> = {},
    manifest: ManifestV1 = emptyManifest,
  ): InputError {
    return inputError(manifest, { ...options, values: [document] }, environment);
  }

  function publicErrorSurfaces(error: Error): readonly string[] {
    const surfaces: string[] = [];
    const seen = new Set<Error>();
    let current: unknown = error;
    while (current instanceof Error && !seen.has(current)) {
      seen.add(current);
      surfaces.push(
        current.message,
        withoutStackFrames(current.stack ?? ''),
        String(current),
        JSON.stringify(current) ?? '',
        withoutStackFrames(inspect(current)),
      );
      if (current instanceof InputError) {
        surfaces.push(...current.issues.map((issue) => issue.message));
      }
      current = current.cause;
    }
    return surfaces;
  }

  function existingRegistry(): SecretRegistry {
    const secrets = new SecretRegistry();
    secrets.register('existing-secret');
    expect(secrets.mask('existing-secret')).toBe('***');
    return secrets;
  }

  function expectRegistryUnchanged(secrets: SecretRegistry, candidates: readonly string[]): void {
    expect(secrets.size).toBe(1);
    expect(secrets.mask('existing-secret')).toBe('***');
    for (const candidate of candidates) {
      expect(secrets.mask(candidate)).toBe(candidate);
    }
  }

  function secretManifest(): ManifestV1 {
    return manifestOf('inputs:', '  license:', '    type: secret');
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

  it.each(['', ' \n\t\n', '# no values\n\n# here\n', '---\n', '%YAML 1.2\n---\n'])(
    'reads a contentless document as no values at all',
    (contents) => {
      const document = parseValuesFile(file(contents));

      expect(document.values.size).toBe(0);
      expect(document.problems).toBeUndefined();
    },
  );

  it.each([
    { name: 'spaces', yamlKey: '"space key"', quotedKey: '"space key"' },
    { name: 'quotes', yamlKey: '"quote\\"key"', quotedKey: '"quote\\"key"' },
    {
      name: 'backslashes',
      yamlKey: '"back\\\\slash"',
      quotedKey: '"back\\\\slash"',
    },
    {
      name: 'C0 controls',
      yamlKey: '"control\\n\\r\\u001b\\u0007"',
      quotedKey: '"control\\n\\r\\u001b\\u0007"',
    },
    { name: 'C1 controls', yamlKey: '"control\\u0085"', quotedKey: '"control\\u0085"' },
    {
      name: 'Unicode line controls',
      yamlKey: '"control\\u2028\\u2029"',
      quotedKey: '"control\\u2028\\u2029"',
    },
  ])('JSON-quotes shape keys containing $name on one diagnostic line', ({ yamlKey, quotedKey }) => {
    const error = loadError(`${yamlKey}:\n`);
    const expected = `${quotedKey} has no value — remove the key, or give it one`;

    expect(error.issues[0]?.message).toBe(expected);
    expect(error.message).toBe(`values.yaml:1:1: ${expected}`);
    expect(error.message.split('\n')).toHaveLength(1);
    expect(hasRawDiagnosticControl(error.message)).toBe(false);
  });

  it('masks a controlled same-document shape key before quoting it', () => {
    const document = parseValuesFile(
      file(`license: ${controlledSecretYaml}\n${controlledSecretYaml}:\n`),
      controlledSecret,
    );
    const secrets = existingRegistry();
    const error = documentError(document, { secrets }, {}, secretManifest());

    expect(document.values.get('license')).toBe(controlledSecret);
    expect(error.issues).toEqual([
      {
        code: 'RUNE-202',
        message: '"***" has no value — remove the key, or give it one',
        location: { file: '***', line: 2, column: 1 },
      },
    ]);
    const surfaces = publicErrorSurfaces(error).join('\n');
    expect(surfaces).not.toContain(controlledSecret);
    for (const fragment of ['F057', 'quoted', 'path']) {
      expect(surfaces).not.toContain(fragment);
    }
    expectRegistryUnchanged(secrets, [controlledSecret]);
  });

  it('masks a controlled cross-document shape key before quoting it', () => {
    const candidate = parseValuesFile(file(`license: ${controlledSecretYaml}\n`), 'candidate.yaml');
    const broken = parseValuesFile(file(`${controlledSecretYaml}:\n`), `${controlledSecret}.yaml`);
    const secrets = existingRegistry();
    const error = inputError(secretManifest(), { values: [candidate, broken], secrets });

    expect(error.issues).toEqual([
      {
        code: 'RUNE-202',
        message: '"***" has no value — remove the key, or give it one',
        location: { file: '***.yaml', line: 1, column: 1 },
      },
    ]);
    const surfaces = publicErrorSurfaces(error).join('\n');
    expect(surfaces).not.toContain(controlledSecret);
    for (const fragment of ['F057', 'quoted', 'path']) {
      expect(surfaces).not.toContain(fragment);
    }
    expectRegistryUnchanged(secrets, [controlledSecret]);
  });

  it('redacts a same-document secret from deferred shape diagnostics', () => {
    const secret = 'LICENSE.txt';
    const document = parseValuesFile(file(`license: ${secret}\n${secret}:\n`), secret);
    const secrets = existingRegistry();

    expect(document.values.get('license')).toBe(secret);
    expect(document.problems).toHaveLength(1);
    const error = documentError(document, { secrets }, {}, secretManifest());

    expect(error.issues).toEqual([
      {
        code: 'RUNE-202',
        message: '"***" has no value — remove the key, or give it one',
        location: { file: '***', line: 2, column: 1 },
      },
    ]);
    expect(publicErrorSurfaces(error).join('\n')).not.toContain(secret);
    expectRegistryUnchanged(secrets, [secret]);
  });

  it('uses a secret candidate from another values document to redact an error', () => {
    const secret = 'F052-CROSS-DOCUMENT-SECRET';
    const candidate = parseValuesFile(file(`license: ${secret}\n`), 'candidate.yaml');
    const broken = parseValuesFile(file(`${secret}:\n`), `${secret}.yaml`);
    const secrets = existingRegistry();
    const error = inputError(secretManifest(), {
      values: [candidate, broken],
      secrets,
    });

    expect(error.issues).toEqual([
      {
        code: 'RUNE-202',
        message: '"***" has no value — remove the key, or give it one',
        location: { file: '***.yaml', line: 1, column: 1 },
      },
    ]);
    expect(publicErrorSurfaces(error).join('\n')).not.toContain(secret);
    expectRegistryUnchanged(secrets, [secret]);
  });

  it('uses an environment secret to redact a deferred YAML syntax error', () => {
    const secret = 'F052-ENVIRONMENT-LOAD-SECRET';
    const document = parseValuesFile(file('target:\n\tvalue: x\n'), secret);
    const secrets = existingRegistry();
    const error = documentError(
      document,
      { secrets },
      { RUNE_INPUT_LICENSE: secret },
      secretManifest(),
    );

    expect(error.code).toBe('RUNE-202');
    expect(error.location?.file).toBe('***');
    expect(publicErrorSurfaces(error).join('\n')).not.toContain(secret);
    expectRegistryUnchanged(secrets, [secret]);
  });

  it('uses an override secret to redact a deferred file-load error', () => {
    const secret = 'F052-OVERRIDE-LOAD-SECRET';
    const missing = join(mkdtempSync(join(tmpdir(), 'rune-values-')), 'missing.yaml');
    const document = parseValuesFile(missing, secret);
    const secrets = existingRegistry();
    const error = documentError(
      document,
      { overrides: new Map([['license', secret]]), secrets },
      {},
      secretManifest(),
    );

    expect(error.code).toBe('RUNE-202');
    expect(error.location?.file).toBe('***');
    expect(publicErrorSurfaces(error).join('\n')).not.toContain(secret);
    expectRegistryUnchanged(secrets, [secret]);
  });

  it('uses an answer secret to redact a deferred top-level shape error', () => {
    const secret = 'F052-ANSWER-SHAPE-SECRET';
    const document = parseValuesFile(file('- value\n'), secret);
    const secrets = existingRegistry();
    const error = documentError(
      document,
      { answers: new Map([['license', secret]]), secrets },
      {},
      secretManifest(),
    );

    expect(error.code).toBe('RUNE-202');
    expect(error.location?.file).toBe('***');
    expect(publicErrorSurfaces(error).join('\n')).not.toContain(secret);
    expectRegistryUnchanged(secrets, [secret]);
  });

  it('retains multiple located problems while staging every readable secret candidate', () => {
    const first = 'F052-FIRST-VALUES-SECRET';
    const second = 'F052-SECOND-VALUES-SECRET';
    const documents = [
      parseValuesFile(file(`license: ${first}\n${second}:\n`), `${first}.yaml`),
      parseValuesFile(file(`license: ${second}\n${first}:\n`), `${second}.yaml`),
    ];
    const secrets = existingRegistry();
    const error = inputError(secretManifest(), { values: documents, secrets });

    expect(error.issues).toEqual([
      {
        code: 'RUNE-202',
        message: '"***" has no value — remove the key, or give it one',
        location: { file: '***.yaml', line: 2, column: 1 },
      },
      {
        code: 'RUNE-202',
        message: '"***" has no value — remove the key, or give it one',
        location: { file: '***.yaml', line: 2, column: 1 },
      },
    ]);
    const surfaces = publicErrorSurfaces(error).join('\n');
    for (const secret of [first, second]) {
      expect(surfaces).not.toContain(secret);
    }
    expectRegistryUnchanged(secrets, [first, second]);
  });

  it.each([
    { contents: 'null\n', line: 1 },
    { contents: '~\n', line: 1 },
    { contents: '---\nnull\n', line: 2 },
  ])('refuses an explicit top-level null value', ({ contents, line }) => {
    const error = loadError(contents);

    expect(error.code).toBe('RUNE-202');
    expect(error.message).toBe(
      `values.yaml:${line}:1: values.yaml must contain a mapping of input ids to values`,
    );
    expect(error.location).toEqual({ file: 'values.yaml', line, column: 1 });
  });

  it('classifies YAML syntax errors as invalid values input and keeps their location', () => {
    const error = loadError('target:\n\tvalue: x\n');

    expect(error).not.toBeInstanceOf(ManifestError);
    expect(error.code).toBe('RUNE-202');
    expect(exitCodeFor(error)).toBe(4);
    expect(error.issues).toMatchObject([
      { code: 'RUNE-202', location: { file: 'values.yaml', line: 2 } },
    ]);
  });

  it('classifies a duplicate key without retaining document content or a loader cause', () => {
    const error = loadError('target: first\ntarget: second\n');

    expect(error.code).toBe('RUNE-202');
    expect(error.message).toBe('values.yaml:2:1: a mapping key is defined more than once');
    expect(error.issues).toEqual([
      {
        code: 'RUNE-202',
        message: 'a mapping key is defined more than once',
        location: { file: 'values.yaml', line: 2, column: 1 },
      },
    ]);
    expect(error.cause).toBeUndefined();
  });

  it.each([
    {
      name: 'plain',
      secret: 'F058-PLAIN-DUPLICATE-SECRET',
      yaml: 'F058-PLAIN-DUPLICATE-SECRET',
      fragments: ['F058', 'PLAIN', 'DUPLICATE', 'SECRET'],
    },
    {
      name: 'quoted, escaped and controlled',
      secret: duplicateKeySecret,
      yaml: duplicateKeySecretYaml,
      fragments: ['F058', 'quoted', 'path'],
    },
  ])(
    'does not expose a same-document declared secret used as a $name duplicate key',
    ({ secret, yaml, fragments }) => {
      const document = parseValuesFile(
        file(`license: ${yaml}\n${yaml}: first\n${yaml}: second\n`),
        'values.yaml',
      );
      const secrets = existingRegistry();
      const error = documentError(document, { secrets }, {}, secretManifest());

      expect(document.values.size).toBe(0);
      expect(error.code).toBe('RUNE-202');
      expect(error.message).toBe('values.yaml:3:1: a mapping key is defined more than once');
      expect(error.issues).toEqual([
        {
          code: 'RUNE-202',
          message: 'a mapping key is defined more than once',
          location: { file: 'values.yaml', line: 3, column: 1 },
        },
      ]);
      expect(error.cause).toBeUndefined();

      const surfaces = publicErrorSurfaces(error).join('\n');
      expect(surfaces).not.toContain(secret);
      for (const fragment of fragments) {
        expect(surfaces).not.toContain(fragment);
      }
      expectRegistryUnchanged(secrets, [secret]);
    },
  );

  it('redacts unknown YAML tag names from every public error surface', () => {
    const sentinel = 'F015_UNKNOWN_TAG_SECRET';
    const error = loadError(`target: !${sentinel} value\n`);

    expect(error.code).toBe('RUNE-202');
    expect(error.message).toBe('values.yaml:1:9: YAML tags are not allowed in values files');
    expect(error.issues).toEqual([
      {
        code: 'RUNE-202',
        message: 'YAML tags are not allowed in values files',
        location: { file: 'values.yaml', line: 1, column: 9 },
      },
    ]);
    expect(error.cause).toBeUndefined();
    expect(publicErrorSurfaces(error).join('\n')).not.toContain(sentinel);
  });

  it('redacts unresolved YAML alias names from every public error surface', () => {
    const sentinel = 'F015_UNRESOLVED_ALIAS_SECRET';
    const error = loadError(`target: *${sentinel}\n`);

    expect(error.code).toBe('RUNE-202');
    expect(error.message).toBe(
      'values.yaml:1:1: YAML alias refers to an anchor that has not been defined yet',
    );
    expect(error.issues).toEqual([
      {
        code: 'RUNE-202',
        message: 'YAML alias refers to an anchor that has not been defined yet',
        location: { file: 'values.yaml', line: 1, column: 1 },
      },
    ]);
    expect(error.cause).toBeUndefined();
    expect(publicErrorSurfaces(error).join('\n')).not.toContain(sentinel);
  });

  it('keeps the UTF-8 category and location without exposing the loader cause', () => {
    const error = loadError(Buffer.from([0x74, 0x61, 0x72, 0x67, 0x65, 0x74, 0x3a, 0xff, 0x0a]));

    expect(error.code).toBe('RUNE-202');
    expect(exitCodeFor(error)).toBe(4);
    expect(error.message).toContain('not valid UTF-8');
    expect(error.location).toEqual({ file: 'values.yaml', line: 1, column: 1 });
    expect(error.issues).toEqual([
      {
        code: 'RUNE-202',
        message: 'values.yaml is not valid UTF-8',
        location: { file: 'values.yaml', line: 1, column: 1 },
      },
    ]);
    expect(error.cause).toBeUndefined();
  });

  it('keeps the unreadable-file category and location without exposing the loader cause', () => {
    const missing = join(mkdtempSync(join(tmpdir(), 'rune-values-')), 'missing.yaml');
    const error = documentError(parseValuesFile(missing, 'missing.yaml'));

    expect(error.code).toBe('RUNE-202');
    expect(exitCodeFor(error)).toBe(4);
    expect(error.message).toContain('cannot be read');
    expect(error.location).toEqual({ file: 'missing.yaml', line: 1, column: 1 });
    expect(error.issues).toEqual([
      {
        code: 'RUNE-202',
        message: 'missing.yaml cannot be read',
        location: { file: 'missing.yaml', line: 1, column: 1 },
      },
    ]);
    expect(error.cause).toBeUndefined();
  });

  it('refuses a document that is not a mapping', () => {
    const error = loadError('- a\n- b\n');

    expect(error.code).toBe('RUNE-202');
    expect(exitCodeFor(error)).toBe(4);
    expect(error.message).toMatch(/must contain a mapping/);
  });

  it('refuses a nested section, because a values file has no sections', () => {
    expect(loadError('database:\n  port: "5432"\n').message).toMatch(
      /"database" is a mapping; a values file is one flat mapping/,
    );
  });

  it('asks for a number to be written in quotes, without repeating it', () => {
    const error = loadError('port: 5432\n');

    // This runs before anything knows which input the key belongs to, so it cannot know that
    // the value it would be quoting is a secret — a numeric API key lands here (§10).
    expect(error.message).toContain(
      '"port" is a number — write it in quotes so it means exactly what it says',
    );
    expect(error.message).not.toContain('5432');
  });

  it('refuses a key with no value at all', () => {
    expect(loadError('target:\n').message).toMatch(/"target" has no value/);
  });

  it('refuses a list with an entry that is not a string', () => {
    expect(loadError('tools:\n  - git\n  - 7\n').message).toMatch(
      /"tools" is a list with an entry that is not a string/,
    );
  });

  it('locates each problem in the file it came from', () => {
    const error = loadError('a: "ok"\nb:\n  nested: 1\n');

    expect(error.issues.map((issue) => [issue.code, issue.location])).toEqual([
      ['RUNE-203', { file: 'values.yaml', line: 1, column: 1 }],
      ['RUNE-202', { file: 'values.yaml', line: 2, column: 1 }],
    ]);
  });

  it.each([undefined, 'collect'] as const)(
    'aggregates deferred shape, unknown-key and coercion problems with invalidValues=%s',
    (invalidValues) => {
      const manifest = manifestOf(
        'inputs:',
        '  badShape:',
        '    type: text',
        '    required: false',
        '  known:',
        '    type: boolean',
        '    required: false',
      );
      const document = valuesFromFile(
        ['badShape:', '  nested: value', 'mistake: value', 'known: perhaps', ''].join('\n'),
      );
      const error = inputError(manifest, {
        values: [document],
        ...(invalidValues === undefined ? {} : { invalidValues }),
      });

      expect(error.code).toBe('RUNE-202');
      expect(error.issues.map((issue) => [issue.code, issue.location])).toEqual([
        ['RUNE-202', { file: 'v.yaml', line: 1, column: 1 }],
        ['RUNE-203', { file: 'v.yaml', line: 3, column: 1 }],
        ['RUNE-202', { file: 'v.yaml', line: 4, column: 1 }],
      ]);
      expect(error.issues.map((issue) => issue.message)).toEqual([
        '"badShape" is a mapping; a values file is one flat mapping of input ids to values',
        '"mistake" is not an input of this manifest (set from v.yaml)',
        'known (from v.yaml): "perhaps" is not one of true, 1, yes, false, 0, no',
      ]);
    },
  );

  it('keeps deferred primary issue taxonomy and values order with supplemental missing issues', () => {
    const manifest = manifestOf(
      'inputs:',
      '  firstMissing:',
      '    type: text',
      '  badShape:',
      '    type: text',
      '    required: false',
      '  known:',
      '    type: boolean',
      '    required: false',
    );
    const missingIssue = vi.fn((id: string) => ({
      code: 'RUNE-201' as const,
      message: `missing ${id}`,
      location: undefined,
    }));
    let thrown: unknown;

    try {
      resolveInputsWithRegistry(
        {
          manifest,
          context: contextFor(manifest),
          values: [
            valuesFromFile(
              ['badShape:', '  nested: value', 'mistake: value', 'known: perhaps', ''].join('\n'),
            ),
          ],
        },
        new SecretRegistry(),
        undefined,
        missingIssue,
      );
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(InputError);
    const error = thrown as InputError;
    expect(error.code).toBe('RUNE-202');
    expect(
      error.issues
        .filter((issue) => issue.code !== 'RUNE-201')
        .map((issue) => [issue.code, issue.location]),
    ).toEqual([
      ['RUNE-202', { file: 'v.yaml', line: 1, column: 1 }],
      ['RUNE-203', { file: 'v.yaml', line: 3, column: 1 }],
      ['RUNE-202', { file: 'v.yaml', line: 4, column: 1 }],
    ]);
    expect(missingIssue).toHaveBeenCalledExactlyOnceWith('firstMissing');
  });

  it.each([undefined, 'collect'] as const)(
    'orders aggregate values-file issues by document before their source positions with invalidValues=%s',
    (invalidValues) => {
      const manifest = manifestOf(
        'inputs:',
        '  badShape:',
        '    type: text',
        '    required: false',
        '  known:',
        '    type: boolean',
        '    required: false',
      );
      const first = valuesFromFile(
        [...Array<string>(9).fill(''), 'badShape:', '  nested: value', ''].join('\n'),
        'first.yaml',
      );
      const second = valuesFromFile('mistake: value\nknown: perhaps\n', 'second.yaml');
      const error = inputError(manifest, {
        values: [first, second],
        ...(invalidValues === undefined ? {} : { invalidValues }),
      });

      expect(error.code).toBe('RUNE-202');
      expect(error.issues.map((issue) => [issue.code, issue.location])).toEqual([
        ['RUNE-202', { file: 'first.yaml', line: 10, column: 1 }],
        ['RUNE-203', { file: 'second.yaml', line: 1, column: 1 }],
        ['RUNE-202', { file: 'second.yaml', line: 2, column: 1 }],
      ]);
      expect(error.location).toEqual({ file: 'first.yaml', line: 10, column: 1 });
    },
  );

  it.each([undefined, 'collect'] as const)(
    'keeps a reused invalid values document at its first ordinal with invalidValues=%s',
    (invalidValues) => {
      const first = valuesFromFile('- invalid\n', 'first.yaml');
      const second = valuesFromFile('- invalid\n', 'second.yaml');
      const error = inputError(emptyManifest, {
        values: [first, second, first],
        ...(invalidValues === undefined ? {} : { invalidValues }),
      });

      expect(error.code).toBe('RUNE-202');
      expect(error.issues.map((issue) => [issue.code, issue.location])).toEqual([
        ['RUNE-202', { file: 'first.yaml', line: 1, column: 1 }],
        ['RUNE-202', { file: 'second.yaml', line: 1, column: 1 }],
      ]);
      expect(error.location).toEqual({ file: 'first.yaml', line: 1, column: 1 });
    },
  );

  it('keeps a deferred values problem ahead of a later input condition resolution error', () => {
    const manifest = manifestOf(
      'inputs:',
      '  firstMissing:',
      '    type: text',
      '  badShape:',
      '    type: text',
      '    required: false',
      '  conditional:',
      '    type: text',
      '    required: false',
      '    when: \'${env.MISSING} == "enabled"\'',
    );
    const missingIssue = vi.fn((id: string) => ({
      code: 'RUNE-201' as const,
      message: `missing ${id}`,
      location: undefined,
    }));
    let thrown: unknown;

    try {
      resolveInputsWithRegistry(
        {
          manifest,
          context: contextFor(manifest),
          values: [valuesFromFile(['badShape:', '  nested: value', ''].join('\n'))],
        },
        new SecretRegistry(),
        undefined,
        missingIssue,
      );
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(InputError);
    const error = thrown as InputError;
    expect(error.code).toBe('RUNE-202');
    expect(error.issues).toEqual([
      {
        code: 'RUNE-202',
        message:
          '"badShape" is a mapping; a values file is one flat mapping of input ids to values',
        location: { file: 'v.yaml', line: 1, column: 1 },
      },
    ]);
    expect(missingIssue).not.toHaveBeenCalled();
  });

  it('does not supplement partial missing state after default resolution aborts traversal', () => {
    const manifest = manifestOf(
      'inputs:',
      '  firstMissing:',
      '    type: text',
      '  unresolvedDefault:',
      '    type: text',
      '    required: false',
      '    default: "${env.MISSING}"',
    );
    const missingIssue = vi.fn((id: string) => ({
      code: 'RUNE-201' as const,
      message: `missing ${id}`,
      location: undefined,
    }));

    expect(() =>
      resolveInputsWithRegistry(
        { manifest, context: contextFor(manifest) },
        new SecretRegistry(),
        undefined,
        missingIssue,
      ),
    ).toThrow(ResolutionError);
    expect(missingIssue).not.toHaveBeenCalled();
  });
});
