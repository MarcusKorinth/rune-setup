import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import { CancelToken } from '../../src/engine/cancel.js';
import { hostPlatform } from '../../src/engine/context.js';
import * as executor from '../../src/engine/executor.js';
import type { InputState } from '../../src/engine/inputs.js';
import { isSecretString, revealSecretString } from '../../src/engine/secrets.js';
import { ExecutionError, InputError, InternalError, ManifestError } from '../../src/errors.js';
import {
  createSessionOptionsForTesting,
  Session,
  type SessionOptions,
} from '../../src/engine/session.js';
import type { RunEvent } from '../../src/engine/events.js';
import { manifestDescriptorFor } from '../../src/manifest/index.js';
import type { Runner, SpawnOutcome, SpawnRequest } from '../../src/runners/base.js';

const okRunner: Runner = { run: async () => ({ kind: 'exited', exitCode: 0 }) };

function openSessionWithRunner(
  manifestPath: string,
  options: SessionOptions,
  runner: Runner,
): Promise<Session> {
  return Session.open(manifestPath, createSessionOptionsForTesting(options, runner));
}

function fixture(lines: readonly string[], extra: Record<string, string> = {}): string {
  const dir = mkdtempSync(join(tmpdir(), 'rune-session-'));
  writeFileSync(join(dir, 'installer.yaml'), [...lines, ''].join('\n'), 'utf8');
  for (const [name, content] of Object.entries(extra)) {
    const path = join(dir, name);
    mkdirSync(join(path, '..'), { recursive: true });
    writeFileSync(path, content, 'utf8');
  }
  return join(dir, 'installer.yaml');
}

function containsSecretString(value: unknown, seen = new Set<object>()): boolean {
  if (isSecretString(value)) {
    return true;
  }
  if (value === null || typeof value !== 'object' || seen.has(value)) {
    return false;
  }
  seen.add(value);
  return Object.values(value).some((entry) => containsSecretString(entry, seen));
}

const BASE = [
  'schemaVersion: 1',
  'product:',
  '  name: Example',
  '  version: "1.0.0"',
  'inputs:',
  '  installDatabase:',
  '    type: boolean',
  '    default: false',
  '  databasePort:',
  '    type: text',
  '    when: "${installDatabase}"',
  'steps:',
  '  - id: install',
  '    run:',
  '      command: node',
];

describe('opening a session', () => {
  it('returns clone-safe masked input views with exact machine identities', async () => {
    const secret = 'text';
    const path = fixture(
      [
        'schemaVersion: 1',
        'product:',
        '  name: Example',
        '  version: "1.0.0"',
        'inputs:',
        '  text:',
        '    type: secret',
        '  fromDefault:',
        '    type: text',
        '    title: Raw title',
        '    description: Raw description',
        '    default: text',
        '    pattern: text',
        '    patternHint: Raw hint',
        '  fromValues:',
        '    type: text',
        '  fromEnvironment:',
        '    type: text',
        '  choice:',
        '    type: select',
        '    options:',
        '      - value: text',
        '        label: Raw label',
        '    default: text',
        '  fromSet:',
        '    type: multiselect',
        '    options: [text, stable]',
        '  rejected:',
        '    type: multiselect',
        '    options: [text]',
        'steps: []',
      ],
      { 'values.yaml': 'fromValues: text\nrejected: [text, invalid]\n' },
    );
    const session = await Session.open(path, {
      mode: 'gui',
      values: [join(path, '..', 'values.yaml')],
      environment: { RUNE_INPUT_FROMENVIRONMENT: secret },
      overrides: {
        text: secret,
        fromSet: '["text","stable"]',
      },
    });

    const all = session.allInputs();
    const pending = session.pendingInputs();
    expect(session.allInputs()).toBe(all);
    expect(session.pendingInputs()).toBe(pending);
    expect(pending).toHaveLength(1);
    expect(pending[0]).toBe(all.find((state) => state.id === 'rejected'));
    expect(structuredClone(all)).toEqual(all);
    expect(containsSecretString(all)).toBe(false);

    expect(all.find((state) => state.id === 'text')).toMatchObject({
      id: 'text',
      secret: true,
      spec: { type: 'secret', required: true },
      value: null,
      source: 'set',
      enabled: true,
    });
    expect(all.find((state) => state.id === 'fromDefault')).toMatchObject({
      secret: false,
      value: '***',
      source: 'default',
      spec: { type: 'text', required: true },
    });
    expect(all.find((state) => state.id === 'fromValues')?.value).toBe('***');
    expect(all.find((state) => state.id === 'fromEnvironment')?.value).toBe('***');
    expect(all.find((state) => state.id === 'choice')).toMatchObject({
      value: '***',
      spec: { type: 'select', options: ['text'] },
    });
    expect(all.find((state) => state.id === 'fromSet')).toMatchObject({
      value: ['***', 'stable'],
      source: 'set',
      spec: { type: 'multiselect', options: ['text', 'stable'] },
    });
    expect(Object.keys(all.find((state) => state.id === 'fromDefault')!.spec).sort()).toEqual([
      'required',
      'type',
    ]);

    const rejected = all.find((state) => state.id === 'rejected')!;
    expect(rejected).toMatchObject({
      value: undefined,
      source: undefined,
      rejection: {
        candidate: ['***', 'invalid'],
        source: 'values',
        issue: { code: 'RUNE-202' },
      },
      spec: { type: 'multiselect', options: ['text'] },
    });
    expect(Object.isFrozen(all)).toBe(true);
    expect(Object.isFrozen(pending)).toBe(true);
    expect(Object.isFrozen(rejected)).toBe(true);
    expect(Object.isFrozen(rejected.spec)).toBe(true);
    expect(Object.isFrozen('options' in rejected.spec ? rejected.spec.options : [])).toBe(true);
    expect(Object.isFrozen(rejected.rejection)).toBe(true);
    expect(Object.isFrozen(rejected.rejection?.candidate)).toBe(true);
    expect(Object.isFrozen(rejected.rejection?.issue)).toBe(true);
    expect(Object.isFrozen(rejected.rejection?.issue.location)).toBe(true);
  });

  it('projects secret answer state consistently across empty and disabled cases', async () => {
    const session = await Session.open(
      fixture([
        'schemaVersion: 1',
        'product:',
        '  name: Example',
        '  version: "1.0.0"',
        'inputs:',
        '  enabled:',
        '    type: boolean',
        '    default: false',
        '  requiredMissing:',
        '    type: secret',
        '  requiredEmpty:',
        '    type: secret',
        '  optionalMissing:',
        '    type: secret',
        '    required: false',
        '  optionalEmpty:',
        '    type: secret',
        '    required: false',
        '  disabledMissing:',
        '    type: secret',
        '    when: "${enabled}"',
        '  disabledSupplied:',
        '    type: secret',
        '    when: "${enabled}"',
        '  disabledEmpty:',
        '    type: secret',
        '    when: "${enabled}"',
        'steps: []',
      ]),
      {
        mode: 'gui',
        environment: {},
        overrides: {
          requiredEmpty: '',
          optionalEmpty: '',
          disabledSupplied: 'supplied-secret',
          disabledEmpty: '',
        },
      },
    );

    const all = session.allInputs();
    const byId = new Map(all.map((state) => [state.id, state]));
    expect(byId.get('requiredMissing')).toMatchObject({
      value: undefined,
      source: undefined,
      enabled: true,
    });
    expect(byId.get('requiredEmpty')).toMatchObject({
      value: undefined,
      source: 'set',
      enabled: true,
    });
    expect(byId.get('optionalMissing')).toMatchObject({
      value: undefined,
      source: undefined,
      enabled: true,
    });
    expect(byId.get('optionalEmpty')).toMatchObject({
      value: null,
      source: 'set',
      enabled: true,
    });
    expect(byId.get('disabledMissing')).toMatchObject({
      value: undefined,
      source: undefined,
      enabled: false,
      ignored: undefined,
    });
    expect(byId.get('disabledSupplied')).toMatchObject({
      value: null,
      source: undefined,
      enabled: false,
      ignored: 'set',
    });
    expect(byId.get('disabledEmpty')).toMatchObject({
      value: null,
      source: undefined,
      enabled: false,
      ignored: 'set',
    });

    const pending = session.pendingInputs();
    expect(pending.map((state) => state.id)).toEqual(['requiredMissing', 'requiredEmpty']);
    expect(pending).toEqual([byId.get('requiredMissing'), byId.get('requiredEmpty')]);
    expect(pending.every((state) => byId.get(state.id) === state)).toBe(true);
    expect(Object.isFrozen(all)).toBe(true);
    expect(Object.isFrozen(pending)).toBe(true);
    expect(pending.every(Object.isFrozen)).toBe(true);

    expect(() => session.setValue('requiredMissing', false)).toThrow(InputError);
    expect(session.allInputs()).toBe(all);
    expect(session.pendingInputs()).toBe(pending);
    expect(byId.get('requiredMissing')).toMatchObject({
      value: undefined,
      rejection: undefined,
    });
  });

  it('publishes fresh remasked snapshots atomically and preserves historical views', async () => {
    const oldSecret = 'F062-old-secret';
    const newSecret = 'F062-new-secret';
    const session = await Session.open(
      fixture([
        'schemaVersion: 1',
        'product:',
        '  name: Example',
        '  version: "1.0.0"',
        'inputs:',
        '  token:',
        '    type: secret',
        '  oldCollision:',
        '    type: text',
        `    default: ${oldSecret}`,
        '  newCollision:',
        '    type: text',
        `    default: ${newSecret}`,
        '  enabled:',
        '    type: boolean',
        '    default: true',
        'steps:',
        '  - id: install',
        '    run:',
        '      command: node',
        '      args: ["${token}", "${oldCollision}", "${newCollision}"]',
      ]),
      { environment: {} },
    );

    const unanswered = session.allInputs().find((state) => state.id === 'token');
    expect(unanswered).toMatchObject({ secret: true, value: undefined, source: undefined });
    expect(session.pendingInputs()).toContain(unanswered);

    session.setValue('token', oldSecret);
    const oldAll = session.allInputs();
    const oldPending = session.pendingInputs();
    const oldStates = [...oldAll];
    const oldPlan = session.plan();
    expect(oldAll.find((state) => state.id === 'oldCollision')?.value).toBe('***');
    expect(oldAll.find((state) => state.id === 'newCollision')?.value).toBe(newSecret);

    expect(session.setValue('token', newSecret)).toEqual([]);
    const newAll = session.allInputs();
    const newPending = session.pendingInputs();
    expect(newAll).not.toBe(oldAll);
    expect(newPending).not.toBe(oldPending);
    expect(newAll.every((state, index) => state !== oldStates[index])).toBe(true);
    expect(newAll.find((state) => state.id === 'oldCollision')?.value).toBe(oldSecret);
    expect(newAll.find((state) => state.id === 'newCollision')?.value).toBe('***');
    expect(oldAll.find((state) => state.id === 'oldCollision')?.value).toBe('***');
    expect(oldAll.find((state) => state.id === 'newCollision')?.value).toBe(newSecret);
    const newPlan = session.plan();
    expect(newPlan).not.toBe(oldPlan);
    const newStep = newPlan.steps[0];
    expect(newStep?.state).toBe('PENDING');
    if (newStep?.state !== 'PENDING' || !isSecretString(newStep.command.argv[1])) {
      throw new Error('expected the canonical secret wrapper in the execution plan');
    }
    expect(revealSecretString(newStep.command.argv[1])).toBe(newSecret);

    const acceptedAll = session.allInputs();
    const acceptedPending = session.pendingInputs();
    const acceptedStates = [...acceptedAll];
    const acceptedPlan = session.plan();
    expect(() => session.setValue('enabled', 'not-a-boolean')).toThrow(InputError);
    expect(session.allInputs()).toBe(acceptedAll);
    expect(session.pendingInputs()).toBe(acceptedPending);
    expect(session.allInputs().every((state, index) => state === acceptedStates[index])).toBe(true);
    expect(session.plan()).toBe(acceptedPlan);
    expect(revealSecretString(newStep.command.argv[1])).toBe(newSecret);
  });

  it('resolves layers 1-4 and reports what is still pending', async () => {
    const path = fixture(BASE);
    const session = await Session.open(path, { environment: {} });

    expect(session.manifest.product.name).toBe('Example');
    expect(session.pendingInputs()).toEqual([]);
    expect(session.allInputs().map((input) => input.id)).toEqual([
      'installDatabase',
      'databasePort',
    ]);
    expect(session.allInputs()[1]?.enabled).toBe(false);
  });

  it('takes --set overrides and values files as layers 4 and 2', async () => {
    const path = fixture(BASE, { 'values.yaml': 'installDatabase: "true"\n' });
    const session = await Session.open(path, {
      values: [join(path, '..', 'values.yaml')],
      environment: {},
    });

    expect(session.allInputs()[0]?.value).toBe(true);
    expect(session.allInputs()[0]?.source).toBe('values');
    expect(session.pendingInputs().map((input) => input.id)).toEqual(['databasePort']);
  });

  it('keeps multiple values-file errors in invocation order', async () => {
    const path = fixture(BASE, {
      'first.yaml': '- invalid\n',
      'second.yaml': 'unknown: value\n',
    });
    const first = join(path, '..', 'first.yaml');
    const second = join(path, '..', 'second.yaml');

    let thrown: InputError | undefined;
    try {
      await Session.open(path, { values: [first, second], environment: {} });
    } catch (error) {
      thrown = error as InputError;
    }

    expect(thrown).toBeInstanceOf(InputError);
    expect(thrown?.issues.map((issue) => issue.location?.file)).toEqual([first, second]);
    expect(thrown?.issues[0]?.message).toContain('must contain a mapping');
    expect(thrown?.issues[1]?.message).toContain('is not an input');
  });

  it.each([
    {
      name: 'manifest default',
      source: 'default',
      defaultLine: '    default: bad',
      extra: {},
      options: (): SessionOptions => ({ environment: {} }),
    },
    {
      name: 'values file',
      source: 'values',
      defaultLine: undefined,
      extra: { 'values.yaml': 'target: bad\n' },
      options: (path: string): SessionOptions => ({
        environment: {},
        values: [join(path, '..', 'values.yaml')],
      }),
    },
    {
      name: 'environment',
      source: 'environment',
      defaultLine: undefined,
      extra: {},
      options: (): SessionOptions => ({ environment: { RUNE_INPUT_TARGET: 'bad' } }),
    },
    {
      name: '--set',
      source: 'set',
      defaultLine: undefined,
      extra: {},
      options: (): SessionOptions => ({ environment: {}, overrides: { target: 'bad' } }),
    },
  ])('collects an invalid $name seed only for interactive frontends', async (scenario) => {
    const path = fixture(
      [
        'schemaVersion: 1',
        'product:',
        '  name: Example',
        '  version: "1.0.0"',
        'inputs:',
        '  target:',
        '    type: text',
        '    pattern: "x+"',
        ...(scenario.defaultLine === undefined ? [] : [scenario.defaultLine]),
        'steps: []',
      ],
      scenario.extra,
    );
    const options = scenario.options(path);

    await expect(
      Session.open(path, { ...options, mode: 'non-interactive' }),
    ).rejects.toBeInstanceOf(InputError);

    for (const mode of ['interactive', 'gui'] as const) {
      const session = await Session.open(path, { ...options, mode });
      const target = session.allInputs().find((input) => input.id === 'target');

      expect(target).toMatchObject({
        enabled: true,
        value: undefined,
        source: undefined,
        rejection: { source: scenario.source, candidate: 'bad' },
      });
      expect(session.pendingInputs()).toEqual([target]);
      expect(target?.rejection?.issue.code).toBe('RUNE-202');

      expect(session.setValue('target', 'xxx')).toEqual([]);
      expect(session.allInputs()[0]).toMatchObject({
        value: 'xxx',
        source: 'answer',
        rejection: undefined,
      });
      expect(session.pendingInputs()).toEqual([]);
      expect(() => session.plan()).not.toThrow();
    }
  });

  it('includes optional rejected seeds in pending inputs but excludes ordinary optional empties', async () => {
    const session = await Session.open(
      fixture([
        'schemaVersion: 1',
        'product:',
        '  name: Example',
        '  version: "1.0.0"',
        'inputs:',
        '  invalidOptional:',
        '    type: text',
        '    required: false',
        '    pattern: "x+"',
        '  emptyOptional:',
        '    type: text',
        '    required: false',
        '  required:',
        '    type: text',
        'steps: []',
      ]),
      {
        mode: 'gui',
        environment: {},
        overrides: { invalidOptional: 'bad' },
      },
    );

    expect(session.pendingInputs().map((input) => input.id)).toEqual([
      'invalidOptional',
      'required',
    ]);
    expect(session.allInputs().find((input) => input.id === 'emptyOptional')).toMatchObject({
      value: '',
      rejection: undefined,
    });
  });

  it('registers validated identity without inventing a locale when locale selection fails', async () => {
    const path = fixture(BASE);
    const foreign = hostPlatform() === 'windows' ? 'linux' : 'windows';
    const register = vi.spyOn(executor, 'registerOpenFailureContext');

    try {
      await expect(
        Session.open(path, {
          environment: {},
          locale: 'definitely_invalid',
          mode: 'interactive',
          platform: foreign,
        }),
      ).rejects.toMatchObject({ code: 'RUNE-001' });

      expect(register).toHaveBeenCalledOnce();
      const context = register.mock.calls[0]?.[1];
      expect(context).toBeDefined();
      expect(context?.manifest.product).toEqual({ name: 'Example', version: '1.0.0' });
      expect(manifestDescriptorFor(context!.manifest)).toMatchObject({
        path,
        sha256: expect.stringMatching(/^[a-f0-9]{64}$/),
        schemaVersion: 1,
      });
      expect(context).toMatchObject({
        mode: 'interactive',
        platform: foreign,
        preview: true,
      });
      expect(context?.getStrings().locale).toBeUndefined();
      expect(context?.allInputs()).toEqual([]);
    } finally {
      register.mockRestore();
    }
  });

  it.runIf(process.platform === 'win32')(
    'uses Windows casing semantics for interpolation, inputs, and locale selection',
    async () => {
      const path = fixture(
        [
          'schemaVersion: 1',
          'product:',
          '  name: Example',
          '  version: "1.0.0"',
          'inputs:',
          '  target:',
          '    type: text',
          'steps:',
          '  - id: install',
          '    title: Install',
          '    run:',
          '      command: node',
          '      args: ["${target}", "${env.PATH}"]',
        ],
        { 'locales/de.yaml': 'steps.install.title: Installieren\n' },
      );
      const session = await Session.open(path, {
        environment: {
          Path: 'C:\\tools',
          rUnE_iNpUt_tArGeT: 'from-environment',
          rUnE_lOcAlE: 'de',
        },
        systemLocale: 'en-US',
      });

      expect(session.allInputs()[0]).toMatchObject({
        value: 'from-environment',
        source: 'environment',
      });
      expect(session.getStrings().locale).toBe('de');
      expect(session.plan().steps[0]).toMatchObject({
        title: 'Installieren',
        command: { argv: ['node', 'from-environment', 'C:\\tools'] },
      });
    },
  );

  it.runIf(process.platform !== 'win32')(
    'keeps interpolation, inputs, and locale environment names case-sensitive on Linux',
    async () => {
      const path = fixture(
        [
          'schemaVersion: 1',
          'product:',
          '  name: Example',
          '  version: "1.0.0"',
          'inputs:',
          '  target:',
          '    type: text',
          '    required: false',
          'steps:',
          '  - id: install',
          '    title: Install',
          '    run:',
          '      command: node',
          '      args: ["${target}", "${env.PATH}"]',
        ],
        { 'locales/de.yaml': 'steps.install.title: Installieren\n' },
      );
      const session = await Session.open(path, {
        environment: {
          Path: '/tools',
          rUnE_iNpUt_tArGeT: 'from-environment',
          rUnE_lOcAlE: 'de',
        },
        systemLocale: 'en-US',
      });

      expect(session.allInputs()[0]).toMatchObject({ value: '', source: undefined });
      expect(session.getStrings().locale).toBe('en-US');
      expect(session.getStrings().stepTitle('install')).toBe('Install');
      expect(() => session.plan()).toThrow(/environment variable PATH is not set/);
    },
  );
});

describe('answering inputs', () => {
  it('flips dependent inputs live and reports the change', async () => {
    const session = await Session.open(fixture(BASE), { environment: {} });

    const changes = session.setValue('installDatabase', true);

    expect(changes).toEqual([{ inputId: 'databasePort', enabled: true }]);
    expect(session.pendingInputs().map((input) => input.id)).toEqual(['databasePort']);
  });

  it('rejects a bad value without changing anything', async () => {
    const session = await Session.open(fixture(BASE), { environment: {} });

    expect(() => session.setValue('installDatabase', 'not-a-boolean')).toThrow(/installDatabase/);
    expect(session.allInputs()[0]?.value).toBe(false);
    expect(() => session.setValue('nope', 'x')).toThrow(/names no input/);
  });

  it.each(['constructor', 'toString', 'valueOf', 'hasOwnProperty'])(
    'rejects inherited input id %s without changing the session',
    async (id) => {
      const session = await Session.open(fixture([...BASE, '      args: []']), { environment: {} });
      const inputs = session.allInputs();
      const plan = session.plan();

      let rejection: unknown;
      try {
        session.setValue(id, 'ignored');
      } catch (error) {
        rejection = error;
      }

      expect(rejection).toMatchObject({ code: 'RUNE-203', name: InputError.name });
      expect(session.allInputs()).toBe(inputs);
      expect(session.plan()).toBe(plan);
    },
  );

  it('accepts declared input ids that collide with Object.prototype', async () => {
    const ids = ['constructor', 'toString', 'valueOf', 'hasOwnProperty'] as const;
    const session = await Session.open(
      fixture([
        'schemaVersion: 1',
        'product:',
        '  name: Example',
        '  version: "1.0.0"',
        'inputs:',
        ...ids.flatMap((id) => [`  ${id}:`, '    type: text']),
        'steps:',
        '  - id: install',
        '    run:',
        '      command: node',
        `      args: [${ids.map((id) => `"\${${id}}"`).join(', ')}]`,
      ]),
      { environment: {} },
    );

    for (const id of ids) {
      expect(session.setValue(id, `${id}-value`)).toEqual([]);
    }

    expect(session.allInputs().map((input) => input.value)).toEqual(ids.map((id) => `${id}-value`));
    expect(session.plan().steps[0]).toMatchObject({
      command: { argv: ['node', ...ids.map((id) => `${id}-value`)] },
    });
  });

  it('masks an unknown id that matches an active secret without changing the session', async () => {
    const secret = 'unknown-input-secret-marker';
    const session = await Session.open(
      fixture([
        'schemaVersion: 1',
        'product:',
        '  name: Example',
        '  version: "1.0.0"',
        'inputs:',
        '  token:',
        '    type: secret',
        '    required: false',
        'steps:',
        '  - id: install',
        '    run:',
        '      command: node',
        '      args: ["${token}"]',
      ]),
      { environment: {}, overrides: { token: secret } },
    );
    const inputs = session.allInputs();
    const plan = session.plan();

    let rejection: unknown;
    try {
      session.setValue(secret, 'ignored');
    } catch (error) {
      rejection = error;
    }

    expect(rejection).toMatchObject({ code: 'RUNE-203', name: InputError.name });
    const error = rejection as InputError;
    expect(error.message).toContain('***');
    expect(error.message).not.toContain(secret);
    expect(JSON.stringify(error.issues)).not.toContain(secret);
    expect(String(error.location?.file)).not.toContain(secret);
    expect(String(error.cause)).not.toContain(secret);
    expect(session.allInputs()).toBe(inputs);
    expect(session.plan()).toBe(plan);
    const step = session.plan().steps[0];
    expect(step?.state).toBe('PENDING');
    if (step?.state !== 'PENDING') {
      throw new Error('expected a pending step');
    }
    expect(String(step.command.argv[1])).toBe('***');
  });

  it.each([
    ['choice', 'rejected'],
    ['port', 'not-a-port'],
  ])('rejects an invalid disabled %s answer without changing anything', async (id, value) => {
    const session = await Session.open(
      fixture([
        'schemaVersion: 1',
        'product:',
        '  name: Example',
        '  version: "1.0.0"',
        'inputs:',
        '  enabled:',
        '    type: boolean',
        '    default: false',
        '  choice:',
        '    type: select',
        '    options: [accepted]',
        '    when: "${enabled}"',
        '  port:',
        '    type: text',
        '    pattern: "[0-9]{2,5}"',
        '    when: "${enabled}"',
        'steps: []',
      ]),
      { mode: 'interactive', environment: {} },
    );
    const before = session.allInputs();

    expect(() => session.setValue(id, value)).toThrow(InputError);
    expect(session.allInputs()).toBe(before);
    expect(session.allInputs().find((input) => input.id === id)).toMatchObject({
      enabled: false,
      value: '',
      source: undefined,
      ignored: undefined,
    });
  });

  it('keeps a valid disabled answer until its controller enables the input', async () => {
    const session = await Session.open(
      fixture([
        'schemaVersion: 1',
        'product:',
        '  name: Example',
        '  version: "1.0.0"',
        'inputs:',
        '  enabled:',
        '    type: boolean',
        '    default: false',
        '  choice:',
        '    type: select',
        '    options: [accepted]',
        '    when: "${enabled}"',
        'steps: []',
      ]),
      { environment: {} },
    );

    expect(session.setValue('choice', 'accepted')).toEqual([]);
    expect(session.allInputs().find((input) => input.id === 'choice')).toMatchObject({
      enabled: false,
      value: '',
      source: undefined,
      ignored: 'answer',
    });
    expect(session.setValue('enabled', true)).toEqual([{ inputId: 'choice', enabled: true }]);
    expect(session.allInputs().find((input) => input.id === 'choice')).toMatchObject({
      enabled: true,
      value: 'accepted',
      source: 'answer',
      ignored: undefined,
    });
  });

  it('keeps an accepted answer through a later rejected edit', async () => {
    const session = await Session.open(fixture(BASE), { environment: {} });
    session.setValue('installDatabase', true);
    session.setValue('databasePort', '5432');

    expect(() => session.setValue('installDatabase', 'garbage')).toThrow(/installDatabase/);
    session.setValue('installDatabase', true);

    expect(session.allInputs().find((input) => input.id === 'databasePort')?.value).toBe('5432');
    expect(session.pendingInputs()).toEqual([]);
  });

  it('redacts a rejected secret edit with the active registry without publishing state', async () => {
    const activeSecret = 'token';
    const path = fixture([
      'schemaVersion: 1',
      'product:',
      '  name: Example',
      '  version: "1.0.0"',
      'inputs:',
      '  token:',
      '    type: secret',
      '  mirror:',
      '    type: text',
      `    default: ${activeSecret}`,
      'steps:',
      '  - id: install',
      '    run:',
      '      command: node',
      '      args: ["${token}", "${mirror}"]',
    ]);
    const session = await Session.open(path, { environment: {}, mode: 'interactive' });
    session.setValue('token', activeSecret);
    const inputs = session.allInputs();
    const pending = session.pendingInputs();
    const plan = session.plan();

    let rejection: InputError | undefined;
    try {
      session.setValue('token', false);
    } catch (error) {
      expect(error).toBeInstanceOf(InputError);
      rejection = error as InputError;
    }
    expect(rejection).toBeDefined();
    expect(rejection?.message).toContain('***');
    expect(rejection?.message).not.toContain(activeSecret);
    expect(JSON.stringify(rejection?.issues)).not.toContain(activeSecret);
    expect(String(rejection?.location?.file)).not.toContain(activeSecret);
    expect(String(rejection?.cause)).not.toContain(activeSecret);

    expect(session.allInputs()).toBe(inputs);
    expect(session.pendingInputs()).toBe(pending);
    expect(session.plan()).toBe(plan);

    const failure = executor.createFailureResult({
      error: rejection!,
      manifestPath: path,
      dryRun: true,
      session,
      plan,
    });
    expect(failure.error).toMatchObject({
      code: 'RUNE-202',
      message: expect.stringContaining('***'),
    });
    expect(JSON.stringify(failure.error)).not.toContain(activeSecret);
    expect(failure.inputs.find((input) => input.id === 'mirror')?.value).toBe('***');
    expect(failure.steps[0]?.command).toEqual(['node', '***', '***']);
  });

  it('collects a seed rejection exposed by a valid controlling edit', async () => {
    const session = await Session.open(
      fixture([
        'schemaVersion: 1',
        'product:',
        '  name: Example',
        '  version: "1.0.0"',
        'inputs:',
        '  enabled:',
        '    type: boolean',
        '    default: false',
        '  choice:',
        '    type: select',
        '    options: [accepted]',
        '    when: "${enabled}"',
        'steps: []',
      ]),
      {
        mode: 'interactive',
        environment: {},
        overrides: { choice: 'rejected' },
      },
    );

    expect(session.setValue('enabled', true)).toEqual([{ inputId: 'choice', enabled: true }]);
    expect(session.allInputs().find((input) => input.id === 'enabled')).toMatchObject({
      value: true,
      source: 'answer',
    });
    expect(session.allInputs().find((input) => input.id === 'choice')).toMatchObject({
      enabled: true,
      value: undefined,
      rejection: { source: 'set', candidate: 'rejected' },
    });
    expect(session.pendingInputs().map((input) => input.id)).toEqual(['choice']);
  });

  it('rolls back a rejected edit while retaining an independent seed rejection', async () => {
    const session = await Session.open(
      fixture([
        'schemaVersion: 1',
        'product:',
        '  name: Example',
        '  version: "1.0.0"',
        'inputs:',
        '  invalidSeed:',
        '    type: text',
        '    required: false',
        '    pattern: "x+"',
        '  enabled:',
        '    type: boolean',
        '    default: false',
        'steps: []',
      ]),
      {
        mode: 'gui',
        environment: {},
        overrides: { invalidSeed: 'bad' },
      },
    );
    session.setValue('enabled', true);
    const before = session.allInputs();

    expect(() => session.setValue('enabled', 'not-a-boolean')).toThrow(InputError);

    expect(session.allInputs()).toBe(before);
    expect(session.allInputs().find((input) => input.id === 'enabled')).toMatchObject({
      value: true,
      source: 'answer',
    });
    expect(
      session.allInputs().find((input) => input.id === 'invalidSeed')?.rejection,
    ).toMatchObject({
      source: 'set',
      candidate: 'bad',
    });
  });

  it('rolls back secret registration when a later input rejects an edit', async () => {
    const marker = 'candidate-secret-marker';
    const session = await Session.open(
      fixture([
        'schemaVersion: 1',
        'product:',
        '  name: Example',
        '  version: "1.0.0"',
        'inputs:',
        '  enabled:',
        '    type: boolean',
        '    default: false',
        '  token:',
        '    type: secret',
        '    when: "${enabled}"',
        '  choice:',
        '    type: select',
        '    options: [accepted]',
        '    when: "${enabled}"',
        'steps:',
        '  - id: install',
        '    run:',
        '      command: node',
        `      args: ["${marker}"]`,
      ]),
      { environment: {}, overrides: { choice: marker } },
    );
    session.setValue('token', marker);
    const inputs = session.allInputs();
    const plan = session.plan();

    let rejection: unknown;
    try {
      session.setValue('enabled', true);
    } catch (error) {
      rejection = error;
    }

    expect(rejection).toBeInstanceOf(InputError);
    expect(rejection).toMatchObject({ message: expect.not.stringContaining(marker) });
    expect((rejection as InputError).message).toContain('***');
    expect(JSON.stringify((rejection as InputError).issues)).not.toContain(marker);
    expect(session.allInputs()).toBe(inputs);
    expect(session.allInputs().find((input) => input.id === 'enabled')).toMatchObject({
      value: false,
      source: 'default',
    });
    expect(session.plan()).toBe(plan);
    expect(session.plan().steps[0]).toMatchObject({
      command: { argv: ['node', expect.anything()] },
    });
    const firstStep = session.plan().steps[0];
    expect(firstStep?.state).toBe('PENDING');
    if (firstStep?.state !== 'PENDING') {
      throw new Error('expected a pending step');
    }
    expect(String(firstStep.command.argv[1])).toBe('***');
  });

  it('rejects an undefined answer without falling back to a default', async () => {
    const session = await Session.open(fixture(BASE), { environment: {} });
    session.setValue('installDatabase', true);

    expect(() => session.setValue('installDatabase', undefined)).toThrow(InputError);
    expect(session.allInputs()[0]).toMatchObject({ value: true, source: 'answer' });
  });
});

describe('planning and executing', () => {
  it('uses the exact manifest bytes and mode in dry-run and live results', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'rune-session-identity-'));
    const path = join(dir, 'installer.yaml');
    const bytes = Buffer.from(
      [
        'schemaVersion: 1',
        'product:',
        '  name: Example',
        '  version: "1.0.0"',
        'steps: []',
        '# whitespace and comments are part of the file identity',
        '',
      ].join('\r\n'),
      'utf8',
    );
    writeFileSync(path, bytes);
    const expectedSha256 = createHash('sha256').update(bytes).digest('hex');
    const session = await openSessionWithRunner(path, { environment: {} }, okRunner);
    const plan = session.plan();

    const expectedIdentity = {
      mode: 'non-interactive',
      manifest: { path, sha256: expectedSha256, schemaVersion: 1 },
    };
    expect(plan).toMatchObject({
      planSchemaVersion: 1,
      manifestPath: path,
      manifestSha256: expectedSha256,
    });
    expect(session.plan()).toBe(plan);
    expect(session.describe()).toMatchObject(expectedIdentity);
    await expect(session.execute()).resolves.toMatchObject(expectedIdentity);
  });

  it('inherits only the immutable environment snapshot from session opening', async () => {
    const inheritedName = 'RUNE_SESSION_INJECTED_PARENT';
    const inheritedValue = 'captured-at-open';
    const hostOnlyName = 'RUNE_SESSION_HOST_ONLY_SENTINEL';
    const inputControlName = 'RUNE_INPUT_INSTALLDATABASE';
    const previousHostOnly = process.env[hostOnlyName];
    const callerEnvironment: Record<string, string | undefined> = {
      [inheritedName]: inheritedValue,
      [inputControlName]: 'false',
    };
    let parentEnv: SpawnRequest['parentEnv'] | undefined;
    process.env[hostOnlyName] = 'host-before-open';

    try {
      const session = await openSessionWithRunner(
        fixture(BASE),
        { environment: callerEnvironment },
        {
          run: async (request) => {
            parentEnv = request.parentEnv;
            return { kind: 'exited', exitCode: 0 };
          },
        },
      );

      callerEnvironment[inheritedName] = 'caller-mutated-after-open';
      callerEnvironment[inputControlName] = 'true';
      callerEnvironment['CALLER_ONLY_AFTER_OPEN'] = 'late-caller-value';
      process.env[hostOnlyName] = 'host-mutated-after-open';

      const result = await session.execute();

      expect(parentEnv).toEqual({ [inheritedName]: inheritedValue });
      expect(Object.isFrozen(parentEnv)).toBe(true);
      expect(parentEnv?.[inputControlName]).toBeUndefined();
      expect(parentEnv?.[hostOnlyName]).toBeUndefined();
      expect(parentEnv?.['CALLER_ONLY_AFTER_OPEN']).toBeUndefined();
      expect(session.allInputs()[0]).toMatchObject({ value: false, source: 'environment' });
      expect(JSON.stringify({ plan: session.plan(), result })).not.toContain(inheritedValue);
      expect(JSON.stringify({ plan: session.plan(), result })).not.toContain(hostOnlyName);
    } finally {
      if (previousHostOnly === undefined) {
        delete process.env[hostOnlyName];
      } else {
        process.env[hostOnlyName] = previousHostOnly;
      }
    }
  });

  it('plans the effective log path after manifest anchoring and flag precedence', async () => {
    const path = fixture([...BASE, 'execution:', '  logFile: logs/manifest.log']);
    const manifestLog = await Session.open(path, { environment: {} });
    expect(manifestLog.plan().executionOptions.logFile).toBe(
      join(path, '..', 'logs', 'manifest.log'),
    );

    const flagPath = join(path, '..', 'logs', 'flag.log');
    const flagLog = await Session.open(path, { environment: {}, logFile: flagPath });
    expect(flagLog.plan().executionOptions.logFile).toBe(flagPath);
  });

  it('preserves an explicit frontend mode in dry-run and live results', async () => {
    const session = await openSessionWithRunner(
      fixture(BASE),
      { mode: 'gui', environment: {} },
      okRunner,
    );

    expect(session.describe().mode).toBe('gui');
    await expect(session.execute()).resolves.toMatchObject({ mode: 'gui' });
  });

  it('refuses to plan while required inputs are missing, listing each one', async () => {
    const session = await Session.open(fixture(BASE), { environment: {} });
    session.setValue('installDatabase', true);

    expect(() => session.plan()).toThrow(/databasePort.*--set databasePort=/s);
  });

  it('refuses to plan with every rejection and missing-input source', async () => {
    const session = await Session.open(
      fixture([
        'schemaVersion: 1',
        'product:',
        '  name: Example',
        '  version: "1.0.0"',
        'inputs:',
        '  invalidOptional:',
        '    type: text',
        '    required: false',
        '    pattern: "x+"',
        '  firstMissing:',
        '    type: text',
        '  secondMissing:',
        '    type: secret',
        'steps: []',
      ]),
      {
        mode: 'interactive',
        environment: {},
        overrides: { invalidOptional: 'bad' },
      },
    );
    let thrown: unknown;

    try {
      session.plan();
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(InputError);
    const inputError = thrown as InputError;
    expect(inputError.code).toBe('RUNE-202');
    expect(inputError.issues.map((issue) => issue.code)).toEqual([
      'RUNE-202',
      'RUNE-201',
      'RUNE-201',
    ]);
    expect(inputError.message).toMatch(/invalidOptional \(from --set invalidOptional=…\)/);
    expect(inputError.message).toMatch(/firstMissing.*--set firstMissing=/s);
    expect(inputError.message).toMatch(/secondMissing.*--set secondMissing=/s);
  });

  it('executes through the facade and writes the log file', async () => {
    const path = fixture(BASE);
    const logFile = join(path, '..', 'logs', 'run.log');
    const session = await openSessionWithRunner(path, { environment: {}, logFile }, okRunner);
    const events: RunEvent[] = [];

    const result = await session.execute((event) => events.push(event));

    expect(result.status).toBe('succeeded');
    expect(result.steps[0]?.state).toBe('SUCCEEDED');
    expect(events[0]?.kind).toBe('runStarted');
    expect(events.at(-1)?.kind).toBe('runFinished');
    const terminal = events.filter((event) => event.kind === 'runFinished');
    expect(terminal).toHaveLength(1);
    expect(terminal[0]?.kind === 'runFinished' && terminal[0].result).toBe(result);
    const log = readFileSync(logFile, 'utf8');
    expect(log).toContain('[install] SUCCEEDED');
    expect(log).toContain('run finished: succeeded (exit 0)');
  });

  it('contains rejected Promise observers without awaiting them or changing the event bracket', async () => {
    const session = await openSessionWithRunner(fixture(BASE), { environment: {} }, okRunner);
    let rejectObserver!: (reason?: unknown) => void;
    const returned = new Promise<never>((_resolve, reject) => {
      rejectObserver = reject;
    });
    const then = vi.spyOn(returned, 'then');
    const events: RunEvent[] = [];
    const unhandledRejections: unknown[] = [];
    const onUnhandledRejection = (reason: unknown): void => {
      unhandledRejections.push(reason);
    };
    process.on('unhandledRejection', onUnhandledRejection);

    try {
      const result = await session.execute((event) => {
        events.push(event);
        return returned;
      });

      expect(result.status).toBe('succeeded');
      expect(events.map((event) => event.kind)).toEqual([
        'runStarted',
        'stepStarted',
        'stepFinished',
        'runFinished',
      ]);
      expect(then).toHaveBeenCalledTimes(4);
      expect(then.mock.calls.every(([, onRejected]) => typeof onRejected === 'function')).toBe(
        true,
      );

      rejectObserver(new Error('observer rejection'));
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(unhandledRejections).toEqual([]);
    } finally {
      process.off('unhandledRejection', onUnhandledRejection);
    }
  });

  it('contains a rejected terminal observer Promise after log finalization without awaiting it', async () => {
    const path = fixture(BASE);
    const logFile = join(path, '..', 'logs', 'run.log');
    const session = await openSessionWithRunner(path, { environment: {}, logFile }, okRunner);
    let rejectObserver!: (reason?: unknown) => void;
    const returned = new Promise<never>((_resolve, reject) => {
      rejectObserver = reject;
    });
    const then = vi.spyOn(returned, 'then');
    const events: RunEvent[] = [];
    const unhandledRejections: unknown[] = [];
    let terminalSawFinalizedLog = false;
    const onUnhandledRejection = (reason: unknown): void => {
      unhandledRejections.push(reason);
    };
    process.on('unhandledRejection', onUnhandledRejection);

    try {
      const result = await session.execute((event) => {
        events.push(event);
        if (event.kind === 'runFinished') {
          terminalSawFinalizedLog = readFileSync(logFile, 'utf8').includes(
            'run finished: succeeded (exit 0)',
          );
          return returned;
        }
      });

      expect(result.status).toBe('succeeded');
      expect(events.map((event) => event.kind)).toEqual([
        'runStarted',
        'stepStarted',
        'stepFinished',
        'runFinished',
      ]);
      expect(events.filter((event) => event.kind === 'runFinished')).toHaveLength(1);
      expect(terminalSawFinalizedLog).toBe(true);
      expect(then).toHaveBeenCalledOnce();
      expect(then.mock.calls[0]?.[1]).toEqual(expect.any(Function));

      rejectObserver(new Error('terminal observer rejection'));
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(unhandledRejections).toEqual([]);
    } finally {
      process.off('unhandledRejection', onUnhandledRejection);
    }
  });

  it('publishes a runner contract failure only after finalization, then rejects', async () => {
    const path = fixture(BASE);
    const logFile = join(path, '..', 'logs', 'run.log');
    const session = await openSessionWithRunner(
      path,
      { environment: {}, logFile },
      { run: async () => ({ kind: 'exited', exitCode: Number.NaN }) },
    );
    const events: RunEvent[] = [];
    let terminalSawFinalizedLog = false;

    await expect(
      session.execute((event) => {
        events.push(event);
        if (event.kind === 'runFinished') {
          terminalSawFinalizedLog = readFileSync(logFile, 'utf8').includes(
            'run finished: internal_error (exit 70)',
          );
        }
      }),
    ).rejects.toMatchObject({ code: 'RUNE-500', name: InternalError.name });

    expect(events.map((event) => event.kind)).toEqual([
      'runStarted',
      'stepStarted',
      'stepOutput',
      'stepFinished',
      'runFinished',
    ]);
    expect(events.filter((event) => event.kind === 'runFinished')).toHaveLength(1);
    const terminal = events.at(-1);
    expect(terminal?.kind === 'runFinished' && terminal.result).toMatchObject({
      status: 'internal_error',
      exitCode: 70,
      stepsFailed: 1,
    });
    expect(terminalSawFinalizedLog).toBe(true);
    expect(readFileSync(logFile, 'utf8')).toContain('run finished: internal_error (exit 70)');
  });

  it('uses one opaque canonical plan for observers and runner requests', async () => {
    const marker = 'shared-secret-marker';
    const mirror = `prefix-${marker}-suffix`;
    const literal = `literal-${marker}`;
    const path = fixture([
      'schemaVersion: 1',
      'product:',
      '  name: Example',
      '  version: "1.0.0"',
      'inputs:',
      '  token:',
      '    type: secret',
      '  mirror:',
      '    type: text',
      'steps:',
      '  - id: use',
      '    title: Use token',
      '    run:',
      '      command: node',
      `      args: ["\${mirror}", "${literal}"]`,
      '      env:',
      '        MIRROR: "${mirror}"',
    ]);
    const spawnedArgv: unknown[] = [];
    const spawnedEnv: unknown[] = [];
    const runner: Runner = {
      run: async (request) => {
        spawnedArgv.push(...request.command.argv);
        spawnedEnv.push(request.command.env['MIRROR']);
        request.onOutput('stdout', `child echoed ${mirror}`);
        return { kind: 'exited', exitCode: 0 };
      },
    };
    const session = await openSessionWithRunner(
      path,
      { environment: {}, overrides: { token: marker, mirror } },
      runner,
    );

    const safePlan = session.plan();
    const planned = session.describe();
    const events: RunEvent[] = [];
    const live = await session.execute((event) => events.push(event));

    expect(JSON.stringify({ safePlan, planned, live, events })).not.toContain(marker);
    expect(safePlan.resolvedInputs.find((input) => input.id === 'mirror')?.value).toBe(
      'prefix-***-suffix',
    );
    expect(events[0]).toMatchObject({ kind: 'runStarted' });
    expect(events[0]?.kind === 'runStarted' && events[0].plan).toBe(safePlan);
    const pending = safePlan.steps[0];
    expect(pending?.state).toBe('PENDING');
    expect(spawnedArgv).toEqual(pending?.state === 'PENDING' ? pending.command.argv : []);
    expect(spawnedEnv).toEqual([
      pending?.state === 'PENDING' ? pending.command.env['MIRROR'] : undefined,
    ]);
  });

  it('does not start a runner until the log is open and releases a failed execution', async () => {
    const path = fixture(BASE);
    const logFile = join(path, '..', 'blocked.log');
    mkdirSync(logFile);
    const run = vi.fn(async () => ({ kind: 'exited' as const, exitCode: 0 }));
    const session = await openSessionWithRunner(path, { environment: {}, logFile }, { run });

    await expect(session.execute()).rejects.toMatchObject({
      code: 'RUNE-406',
      name: ExecutionError.name,
      cause: expect.any(Error),
    });
    expect(run).not.toHaveBeenCalled();
    expect(session.setValue('installDatabase', false)).toEqual([]);

    rmdirSync(logFile);
    await expect(session.execute()).resolves.toMatchObject({ status: 'succeeded' });
    expect(run).toHaveBeenCalledOnce();
  });

  it('rejects overlapping executions and keeps cancellation bound to the active run', async () => {
    const cancel = new CancelToken();
    let runnerCalls = 0;
    let runnerStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      runnerStarted = resolve;
    });
    const run = vi.fn(async (request: SpawnRequest): Promise<SpawnOutcome> => {
      runnerCalls += 1;
      if (runnerCalls > 1) {
        return { kind: 'exited', exitCode: 0 };
      }
      expect(request.cancel).toBe(cancel);
      runnerStarted();
      return await new Promise<SpawnOutcome>((resolve) => {
        request.cancel.onCancel(() => resolve({ kind: 'cancelled' }));
      });
    });
    const session = await openSessionWithRunner(fixture(BASE), { environment: {} }, { run });

    const active = session.execute(undefined, cancel);
    await started;

    const overlappingObserver = vi.fn();
    await expect(session.execute(overlappingObserver)).rejects.toMatchObject({
      code: 'RUNE-500',
      name: InternalError.name,
    });
    expect(run).toHaveBeenCalledOnce();
    expect(overlappingObserver).not.toHaveBeenCalled();

    session.cancel();
    expect(cancel.isCancelled).toBe(true);
    await expect(active).resolves.toMatchObject({ status: 'cancelled', stepsCancelled: 1 });

    await expect(session.execute()).resolves.toMatchObject({ status: 'succeeded' });
    expect(run).toHaveBeenCalledTimes(2);
  });

  it('rejects value changes while execution is active without changing its plan or inputs', async () => {
    let runnerStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      runnerStarted = resolve;
    });
    let releaseRunner!: () => void;
    const runnerFinished = new Promise<SpawnOutcome>((resolve) => {
      releaseRunner = () => resolve({ kind: 'exited', exitCode: 0 });
    });
    const requests: SpawnRequest[] = [];
    const session = await openSessionWithRunner(
      fixture([
        'schemaVersion: 1',
        'product:',
        '  name: Example',
        '  version: "1.0.0"',
        'inputs:',
        '  target:',
        '    type: text',
        '    default: before',
        'steps:',
        '  - id: install',
        '    run:',
        '      command: node',
        '      args: ["${target}"]',
      ]),
      { environment: {} },
      {
        run: async (request) => {
          requests.push(request);
          runnerStarted();
          return await runnerFinished;
        },
      },
    );
    const inputs = session.allInputs();
    const warnings = session.warnings();
    const plan = session.plan();

    const active = session.execute();
    await started;

    let rejection: unknown;
    try {
      session.setValue('target', 'after');
    } catch (error) {
      rejection = error;
    }
    expect(rejection).toMatchObject({
      code: 'RUNE-500',
      name: InternalError.name,
    });
    expect(session.allInputs()).toBe(inputs);
    expect(session.warnings()).toBe(warnings);
    expect(session.plan()).toBe(plan);
    expect(requests[0]?.command.argv).toEqual(['node', 'before']);

    releaseRunner();
    await expect(active).resolves.toMatchObject({ status: 'succeeded' });

    expect(session.setValue('target', 'after')).toEqual([]);
    const updatedPlan = session.plan();
    expect(updatedPlan).not.toBe(plan);
    const updatedStep = updatedPlan.steps[0];
    expect(updatedStep?.state, 'the updated plan must retain the pending step').toBe('PENDING');
    if (updatedStep?.state !== 'PENDING') {
      throw new Error('the updated plan must retain the pending step');
    }
    expect(updatedStep.command.argv).toEqual(['node', 'after']);
  });

  it('describes a dry run without executing', async () => {
    const session = await Session.open(fixture(BASE), { environment: {} });

    const result = session.describe();

    expect(result.status).toBe('planned');
    expect(result.dryRun).toBe(true);
    expect(result.steps[0]?.state).toBe('PENDING');
  });
});

describe('strings and theme', () => {
  it('serves the overlay of the selected locale', async () => {
    const path = fixture(BASE, {
      'locales/de.yaml': 'steps.install.title: Installieren\nrune.button.next: Weiter\n',
    });
    const session = await Session.open(path, { locale: 'de-DE', environment: {} });

    const strings = session.getStrings();
    expect(strings.locale).toBe('de-DE');
    expect(strings.stepTitle('install')).toBe('Installieren');
    expect(strings.chrome('rune.button.next')).toBe('Weiter');
    expect(session.describe().steps[0]?.title).toBe('Installieren');
  });

  it('ignores malformed locale claims unrelated to the selected fallback', async () => {
    const path = fixture(BASE, {
      'locales/de.yaml': 'steps.install.title: Installieren\n',
      'locales/de--DE.yaml': 'steps.install.title: Ungueltig\n',
    });

    const session = await Session.open(path, { locale: 'de-DE', environment: {} });

    expect(session.getStrings().stepTitle('install')).toBe('Installieren');
  });

  it('masks sink strings with the current secret snapshot after a successful edit', async () => {
    const productName = 'IdentityProduct';
    const path = fixture([
      'schemaVersion: 1',
      'product:',
      `  name: ${productName}`,
      '  version: "1.0.0"',
      'inputs:',
      '  lateSecret:',
      '    type: secret',
      '  productSecret:',
      '    type: secret',
      '  manifestSecret:',
      '    type: secret',
      '  logSecret:',
      '    type: secret',
      'steps:',
      '  - id: install',
      '    title: Next',
      '    run:',
      '      command: node',
    ]);
    const logFile = join(path, '..', 'identity.log');
    const session = await Session.open(path, {
      mode: 'interactive',
      environment: {},
      logFile,
      overrides: {
        productSecret: productName,
        manifestSecret: path,
        logSecret: logFile,
      },
    });
    const strings = session.getStrings();

    expect(strings.chrome('rune.button.next')).toBe('Next');
    expect(session.setValue('lateSecret', 'Next')).toEqual([]);
    expect(strings.chrome('rune.button.next')).toBe('***');
    expect(strings.entries['rune.button.next']).toBe('***');
    expect(session.getStrings().stepTitle('install')).toBe('***');

    const plan = session.plan();
    const result = session.describe();
    expect(plan.manifestPath).toBe(path);
    expect(plan.executionOptions.logFile).toBe(logFile);
    expect(result.product).toEqual({ name: productName, version: '1.0.0' });
    expect(result.manifest.path).toBe(path);
  });

  it.each(['logo', 'banner', 'theme'] as const)(
    'rejects a missing gui $asset file',
    async (asset) => {
      const path = fixture([...BASE, 'gui:', `  ${asset}: assets/missing-${asset}`]);

      await expect(Session.open(path, { mode: 'gui', environment: {} })).rejects.toMatchObject({
        code: 'RUNE-104',
        name: ManifestError.name,
        issues: expect.arrayContaining([
          expect.objectContaining({
            code: 'RUNE-104',
            message: expect.stringContaining(`gui.${asset}`),
          }),
        ]),
      });
    },
  );

  it.each(['logo', 'banner', 'theme'] as const)(
    'does not check a missing gui $asset file outside GUI mode',
    async (asset) => {
      const path = fixture([...BASE, 'gui:', `  ${asset}: assets/missing-${asset}`]);

      for (const mode of ['interactive', 'non-interactive'] as const) {
        await expect(Session.open(path, { mode, environment: {} })).resolves.toBeInstanceOf(
          Session,
        );
      }
    },
  );

  it('returns fresh frozen empty theme snapshots when gui is absent', async () => {
    const plain = await Session.open(fixture(BASE), { environment: {} });
    const first = plain.getThemeConfig();
    const second = plain.getThemeConfig();

    expect(first).toEqual({});
    expect(Object.getPrototypeOf(first)).toBe(Object.prototype);
    expect(Object.isFrozen(first)).toBe(true);
    expect(second).not.toBe(first);
    expect(Object.isFrozen(second)).toBe(true);
  });

  it('returns fresh frozen full theme snapshots and masks only the manifest window title', async () => {
    const path = fixture(
      [
        'schemaVersion: 1',
        'product:',
        '  name: Example',
        '  version: "1.0.0"',
        'inputs:',
        '  titleSecret:',
        '    type: secret',
        '  accentSecret:',
        '    type: secret',
        '  logoSecret:',
        '    type: secret',
        '  bannerSecret:',
        '    type: secret',
        '  themeSecret:',
        '    type: secret',
        'steps: []',
        'gui:',
        '  accentColor: "#3355ff"',
        '  logo: assets/logo.png',
        '  banner: assets/banner.png',
        '  theme: assets/theme.css',
        '  windowTitle: Manifest secret title',
      ],
      {
        'assets/logo.png': 'not-a-real-png',
        'assets/banner.png': 'not-a-real-png',
        'assets/theme.css': 'body {}',
      },
    );
    const logo = join(path, '..', 'assets', 'logo.png');
    const banner = join(path, '..', 'assets', 'banner.png');
    const themePath = join(path, '..', 'assets', 'theme.css');
    const themed = await Session.open(path, {
      mode: 'gui',
      environment: {},
      overrides: {
        titleSecret: 'Manifest secret title',
        accentSecret: '#3355ff',
        logoSecret: logo,
        bannerSecret: banner,
        themeSecret: themePath,
      },
    });

    const first = themed.getThemeConfig();
    const second = themed.getThemeConfig();
    expect(first).toEqual({
      accentColor: '#3355ff',
      logo,
      banner,
      theme: themePath,
      windowTitle: '***',
    });
    expect(Object.getPrototypeOf(first)).toBe(Object.prototype);
    expect(Object.isFrozen(first)).toBe(true);
    expect(second).toEqual(first);
    expect(second).not.toBe(first);
    expect(Object.isFrozen(second)).toBe(true);
  });

  it('masks a localized overlay window title', async () => {
    const path = fixture(
      [
        'schemaVersion: 1',
        'product:',
        '  name: Example',
        '  version: "1.0.0"',
        'inputs:',
        '  titleSecret:',
        '    type: secret',
        'steps: []',
        'gui:',
        '  windowTitle: Manifest title',
      ],
      { 'locales/de.yaml': 'gui.windowTitle: Overlay secret title\n' },
    );
    const session = await Session.open(path, {
      mode: 'gui',
      locale: 'de',
      environment: {},
      overrides: { titleSecret: 'Overlay secret title' },
    });

    expect(session.getThemeConfig()).toEqual({ windowTitle: '***' });
  });

  it('remasks only new theme snapshots after a successful secret edit', async () => {
    const session = await Session.open(
      fixture([
        'schemaVersion: 1',
        'product:',
        '  name: Example',
        '  version: "1.0.0"',
        'inputs:',
        '  lateSecret:',
        '    type: secret',
        '    required: false',
        'steps: []',
        'gui:',
        '  accentColor: "#3355ff"',
        '  windowTitle: "#3355ff"',
      ]),
      { mode: 'gui', environment: {} },
    );
    const historical = session.getThemeConfig();

    expect(historical).toEqual({ accentColor: '#3355ff', windowTitle: '#3355ff' });
    expect(session.setValue('lateSecret', '#3355ff')).toEqual([]);

    const current = session.getThemeConfig();
    expect(current).toEqual({ accentColor: '#3355ff', windowTitle: '***' });
    expect(current).not.toBe(historical);
    expect(historical).toEqual({ accentColor: '#3355ff', windowTitle: '#3355ff' });
    expect(Object.isFrozen(historical)).toBe(true);
    expect(Object.isFrozen(current)).toBe(true);
  });

  it('omits windowTitle when gui does not declare it', async () => {
    const session = await Session.open(fixture([...BASE, 'gui:', '  accentColor: "#3355ff"']), {
      mode: 'gui',
      environment: {},
    });
    const theme = session.getThemeConfig();

    expect(theme).toEqual({ accentColor: '#3355ff' });
    expect(Object.hasOwn(theme, 'windowTitle')).toBe(false);
  });
});

describe('facade immutability', () => {
  it('snapshots process.env before later process mutations', async () => {
    const variable = `RUNE_F016_SNAPSHOT_${process.pid}`;
    const previous = process.env[variable];
    const path = fixture([
      'schemaVersion: 1',
      'product:',
      '  name: Example',
      '  version: "1.0.0"',
      'steps:',
      '  - id: install',
      '    run:',
      '      command: node',
      `      args: ["\${env.${variable}}"]`,
    ]);

    try {
      process.env[variable] = 'before';
      const session = await Session.open(path);
      process.env[variable] = 'after';

      expect(session.plan().steps[0]).toMatchObject({
        command: { argv: ['node', 'before'] },
      });
    } finally {
      if (previous === undefined) {
        delete process.env[variable];
      } else {
        process.env[variable] = previous;
      }
    }
  });

  it('keeps manifest, input, warning, change, and string projections outside engine authority', async () => {
    const path = fixture([
      'schemaVersion: 1',
      'product:',
      '  name: Example',
      '  version: "1.0.0"',
      'inputs:',
      '  choice:',
      '    type: multiselect',
      '    options:',
      '      - value: vanilla',
      '        label: Vanilla',
      '      - value: chocolate',
      '        label: Chocolate',
      '  enableExtra:',
      '    type: boolean',
      '    default: false',
      '  extra:',
      '    type: text',
      '    when: "${enableExtra}"',
      'steps:',
      '  - id: install',
      '    title: Trusted step',
      '    run:',
      '      command: node',
      '      args: ["${choice}", "${extra}", "${env.TRUSTED_ENV}"]',
    ]);
    const environment = { TRUSTED_ENV: 'trusted' };
    const session = await Session.open(path, {
      environment,
      overrides: { extra: 'trusted' },
    });
    environment.TRUSTED_ENV = 'corrupted';

    const mutableManifest = session.manifest as unknown as {
      inputs: { choice: { options: Array<{ value: string; label: string }> } };
      steps: Array<{ title: string; run: { args: string[] } }>;
    };
    expect(() => {
      (session as unknown as { manifest: object }).manifest = {};
    }).toThrow(TypeError);
    expect(() => {
      mutableManifest.steps[0]!.title = 'Corrupted step';
    }).toThrow(TypeError);
    expect(() => mutableManifest.steps[0]!.run.args.push('corrupted')).toThrow(TypeError);

    const pending = session.pendingInputs();
    expect(pending.map((state) => state.id)).toEqual(['choice']);
    expect(() => (pending as InputState[]).pop()).toThrow(TypeError);
    expect(() => {
      const spec = pending[0]!.spec as unknown as {
        options: Array<{ value: string; label: string }>;
      };
      spec.options[0]!.value = 'corrupted';
    }).toThrow(TypeError);

    const warnings = session.warnings();
    expect(warnings).toHaveLength(1);
    expect(() => (warnings as string[]).push('corrupted')).toThrow(TypeError);

    const answer = ['vanilla'];
    session.setValue('choice', answer);
    answer[0] = 'chocolate';

    const all = session.allInputs();
    const choice = all.find((state) => state.id === 'choice');
    expect(() => (all as InputState[]).pop()).toThrow(TypeError);
    expect(() => (choice!.value as string[]).push('chocolate')).toThrow(TypeError);

    const changes = session.setValue('enableExtra', true);
    expect(changes).toEqual([{ inputId: 'extra', enabled: true }]);
    expect(() => {
      (changes as Array<{ inputId: string; enabled: boolean }>)[0]!.inputId = 'choice';
    }).toThrow(TypeError);
    expect(() =>
      (changes as Array<{ inputId: string; enabled: boolean }>).push({
        inputId: 'choice',
        enabled: false,
      }),
    ).toThrow(TypeError);

    const strings = session.getStrings();
    expect(() => {
      (strings.entries as Record<string, string>)['steps.install.title'] = 'Corrupted title';
    }).toThrow(TypeError);

    expect(session.plan().steps[0]).toMatchObject({
      title: 'Trusted step',
      command: { argv: ['node', 'vanilla', 'trusted', 'trusted'] },
    });
    expect(session.getStrings().stepTitle('install')).toBe('Trusted step');
    expect(session.getStrings().optionLabel('choice', 'vanilla')).toBe('Vanilla');
  });
});

describe('platform previews', () => {
  it('describes a foreign platform but refuses to execute it', async () => {
    const foreign = hostPlatform() === 'windows' ? 'linux' : 'windows';
    const session = await Session.open(fixture(BASE), { environment: {}, platform: foreign });

    expect(session.describe().crossPlatformPreview).toBe(true);
    await expect(session.execute()).rejects.toThrow(/preview plan/);
  });
});
