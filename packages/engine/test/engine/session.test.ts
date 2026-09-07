import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmdirSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import { CancelToken } from '../../src/engine/cancel.js';
import { hostPlatform } from '../../src/engine/context.js';
import * as failureResults from '../../src/results/failure.js';
import type { InputState } from '../../src/engine/inputs.js';
import {
  isSecretString,
  MAX_SECRET_REGISTRY_CODE_UNITS,
  revealSecretString,
} from '../../src/engine/secrets.js';
import {
  CancelledError,
  ExecutionError,
  formatIssues,
  formatRuneError,
  InputError,
  InternalError,
  ManifestError,
  ResolutionError,
  type RuneIssue,
} from '../../src/errors.js';
import {
  createSessionOptionsForTesting,
  Session,
  type SessionOptions,
} from '../../src/engine/session.js';
import type { RunEvent } from '../../src/engine/events.js';
import { manifestDescriptorFor } from '../../src/manifest/index.js';
import { formatSessionTerminalLine } from '../../src/i18n/strings.js';
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
  it.each(['default', 'values', 'environment', 'set'] as const)(
    'rejects an invalid %s seed with every independently missing required input',
    async (source) => {
      const path = fixture(
        [
          'schemaVersion: 1',
          'product:',
          '  name: Example',
          '  version: "1.0.0"',
          'inputs:',
          '  invalidOptional:',
          '    type: text',
          '    required: false',
          '    pattern: "x+"',
          ...(source === 'default' ? ['    default: bad'] : []),
          '  firstMissing:',
          '    type: text',
          '  secondMissing:',
          '    type: secret',
          'steps: []',
        ],
        source === 'values' ? { 'values.yaml': 'invalidOptional: bad\n' } : {},
      );
      const options: SessionOptions = {
        mode: 'non-interactive',
        environment: source === 'environment' ? { RUNE_INPUT_INVALIDOPTIONAL: 'bad' } : {},
        ...(source === 'values' ? { values: [join(path, '..', 'values.yaml')] } : {}),
        ...(source === 'set' ? { overrides: { invalidOptional: 'bad' } } : {}),
      };
      let opened: Session | undefined;
      let thrown: unknown;

      try {
        opened = await Session.open(path, options);
      } catch (error) {
        thrown = error;
      }

      expect(opened).toBeUndefined();
      expect(thrown).toBeInstanceOf(InputError);
      const inputError = thrown as InputError;
      expect(inputError.code).toBe('RUNE-202');
      expect(inputError.issues.filter((issue) => issue.code === 'RUNE-202')).toHaveLength(1);
      expect(inputError.issues.filter((issue) => issue.code === 'RUNE-201')).toHaveLength(2);
      expect(inputError.message).toContain('invalidOptional');
      for (const id of ['firstMissing', 'secondMissing']) {
        expect(inputError.message).toContain(
          `input "${id}" is required and has no value — supply it with --set ${id}=... | RUNE_INPUT_${id.toUpperCase()} | values-file key '${id}'`,
        );
      }
    },
  );

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

  it('projects input views, rejections, strings, and window titles for JSON string content', async () => {
    const quoted = '""';
    const path = fixture([
      'schemaVersion: 1',
      'product:',
      '  name: Example',
      '  version: "1.0.0"',
      `  description: ${JSON.stringify(quoted)}`,
      'inputs:',
      '  token:',
      '    type: secret',
      '  note:',
      '    type: text',
      `    default: ${JSON.stringify(quoted)}`,
      '  rejected:',
      '    type: select',
      '    options: [exact-option-identity]',
      'steps: []',
      'gui:',
      `  windowTitle: ${JSON.stringify(quoted)}`,
    ]);
    const session = await Session.open(path, {
      mode: 'interactive',
      environment: {},
      overrides: { token: String.raw`\"\"`, rejected: quoted },
    });

    expect(session.allInputs().find((input) => input.id === 'note')?.value).toBe('***');
    expect(session.allInputs().find((input) => input.id === 'rejected')?.rejection?.candidate).toBe(
      '***',
    );
    expect(session.allInputs().find((input) => input.id === 'rejected')?.spec).toMatchObject({
      options: ['exact-option-identity'],
    });
    expect(session.getStrings().productDescription()).toBe('***');
    expect(session.getThemeConfig()).toEqual({ windowTitle: '***' });

    const failure = failureResults.createFailureResult({
      error: new InputError('RUNE-202', 'test failure'),
      manifestPath: path,
      dryRun: false,
      session,
    });
    expect(failure.inputs.find((input) => input.id === 'note')?.value).toBe('***');
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
    const register = vi.spyOn(failureResults, 'registerOpenFailureContext');

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

  it('keeps an invalid manifest ahead of an invalid explicit locale', async () => {
    const invalidPath = fixture(['schemaVersion: 1', 'product:', '  name: Invalid']);
    const validPath = fixture(BASE);

    await expect(
      Session.open(invalidPath, { environment: {}, locale: 'definitely_invalid' }),
    ).rejects.toMatchObject({ code: 'RUNE-103' });
    await expect(
      Session.open(validPath, { environment: {}, locale: 'definitely_invalid' }),
    ).rejects.toMatchObject({ code: 'RUNE-001' });
  });

  it.each(['set', 'environment', 'values'] as const)(
    'masks a selected-overlay key supplied by the %s layer before resolution',
    async (source) => {
      const secret = `unknown-overlay-${source}-secret`;
      const path = fixture(
        [
          'schemaVersion: 1',
          'product:',
          '  name: Example',
          '  version: "1.0.0"',
          'inputs:',
          '  openingSecret:',
          '    type: secret',
          'steps: []',
        ],
        {
          'locales/de.yaml': `${JSON.stringify(secret)}: Unbekannt\n`,
          ...(source === 'values'
            ? { 'values.yaml': `openingSecret: ${JSON.stringify(secret)}\n` }
            : {}),
        },
      );
      const options: SessionOptions = {
        locale: 'de',
        environment: source === 'environment' ? { RUNE_INPUT_OPENINGSECRET: secret } : {},
        ...(source === 'set' ? { overrides: { openingSecret: secret } } : {}),
        ...(source === 'values' ? { values: [join(path, '..', 'values.yaml')] } : {}),
      };

      let thrown: unknown;
      try {
        await Session.open(path, options);
      } catch (error) {
        thrown = error;
      }

      expect(thrown).toBeInstanceOf(ManifestError);
      const error = thrown as ManifestError;
      expect(error.code).toBe('RUNE-104');
      const projected = JSON.stringify({
        message: error.message,
        issues: error.issues,
        location: error.location,
        stack: error.stack,
      });
      expect(projected).not.toContain(secret);
      expect(error.message).toContain('*** does not name a localizable text');
    },
  );

  // The second value is the one that escaping used to defeat: composing the message with
  // JSON.stringify handed the masker a spelling the registry never held (§10).
  it.each(['definitely_invalid', 'C:\\se\\cret-value', 'se\tcret-value'])(
    'masks a declared override %j in a deferred invalid explicit locale diagnostic',
    async (secret) => {
      const path = fixture(
        [
          'schemaVersion: 1',
          'product:',
          '  name: Example',
          '  version: "1.0.0"',
          'inputs:',
          '  openingSecret:',
          '    type: secret',
          'steps: []',
        ],
        { 'invalid-values.yaml': '- invalid\n' },
      );

      let thrown: unknown;
      try {
        await Session.open(path, {
          locale: secret,
          environment: {},
          overrides: { openingSecret: secret },
          values: [join(path, '..', 'invalid-values.yaml')],
        });
      } catch (error) {
        thrown = error;
      }

      expect(thrown).toMatchObject({ code: 'RUNE-001' });
      const message = thrown instanceof Error ? thrown.message : String(thrown);
      expect(message).not.toContain(secret);
      expect(message).not.toContain(JSON.stringify(secret).slice(1, -1));
      expect(message).toContain('invalid locale "***" from --locale');
    },
  );

  it('keeps selected-overlay precedence while preserving values document order', async () => {
    const path = fixture(
      [
        'schemaVersion: 1',
        'product:',
        '  name: Example',
        '  version: "1.0.0"',
        'inputs:',
        '  openingSecret:',
        '    type: secret',
        'steps: []',
      ],
      {
        'locales/de.yaml': 'unknown.overlay.key: Unbekannt\n',
        'first.yaml': '- invalid\n',
        'second.yaml': '- also-invalid\n',
      },
    );
    const first = join(path, '..', 'first.yaml');
    const second = join(path, '..', 'second.yaml');
    const options = { locale: 'de', environment: {}, values: [first, second] } as const;

    await expect(Session.open(path, options)).rejects.toMatchObject({ code: 'RUNE-104' });

    writeFileSync(join(path, '..', 'locales', 'de.yaml'), 'rune.button.next: Weiter\n', 'utf8');
    let thrown: unknown;
    try {
      await Session.open(path, options);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(InputError);
    const error = thrown as InputError;
    expect(error.code).toBe('RUNE-202');
    expect(
      error.issues
        .filter((issue) => issue.code === 'RUNE-202')
        .map((issue) => issue.location?.file),
    ).toEqual([first, second]);
    expect(error.issues).toContainEqual(
      expect.objectContaining({
        code: 'RUNE-201',
        message: expect.stringContaining('openingSecret'),
      }),
    );
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

  it.each([
    { collision: 'input id', secret: 'token' },
    { collision: 'argument path', secret: 'steps[0].run.args[0]' },
    { collision: 'fixed wording', secret: 'OS process listings' },
    { collision: 'JSON-only escape', secret: String.raw`\"token\"` },
  ])(
    'projects a static argv warning against a secret colliding with its $collision',
    async ({ secret }) => {
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

      const warnings = session.warnings();
      expect(warnings).toHaveLength(1);
      expect(Object.isFrozen(warnings)).toBe(true);
      expect(warnings.join('\n')).not.toContain(secret);
      expect(JSON.stringify(warnings)).not.toContain(secret);
    },
  );

  it('publishes a fresh safe warning snapshot only after a successful secret edit', async () => {
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
      { environment: {}, overrides: { token: 'initial-secret-value' } },
    );
    const initial = session.warnings();
    const initialContent = [...initial];

    expect(initial[0]).toContain('secret input "token"');
    expect(initial[0]).toContain('OS process listings');
    expect(session.setValue('token', 'OS process listings')).toEqual([]);

    // A replaced secret stays registered, so only a value that never was one may stay visible.
    const updated = session.warnings();
    expect(updated).not.toBe(initial);
    expect(updated[0]).toContain('secret input "token"');
    expect(updated[0]).not.toContain('OS process listings');
    expect(initial).toEqual(initialContent);

    expect(() => session.setValue('token', false)).toThrow(InputError);
    expect(session.warnings()).toBe(updated);
  });

  it('combines static argv warnings with transactional resolution warnings', async () => {
    const secret = 'session-warning-secret';
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
        '  ignored:',
        '    type: text',
        '    required: false',
        '    when: "${enabled}"',
        '  token:',
        '    type: secret',
        '    required: false',
        'steps:',
        '  - id: install',
        '    run:',
        '      command: node',
        '      args: ["prefix-${token}-${token}"]',
      ]),
      { environment: {}, overrides: { ignored: 'discarded', token: secret } },
    );

    const initial = session.warnings();
    expect(initial).toEqual([
      'steps[0].run.args[0] interpolates secret input "token" into argv, which may be visible in OS process listings — use env: instead',
      'ignored was set from --set, but its condition is false — the value is ignored',
    ]);
    expect(Object.isFrozen(initial)).toBe(true);
    expect(initial.join('\n')).not.toContain(secret);

    expect(session.setValue('enabled', true)).toEqual([{ inputId: 'ignored', enabled: true }]);
    const updated = session.warnings();
    expect(updated).not.toBe(initial);
    expect(updated).toEqual([initial[0]]);

    expect(() => session.setValue('enabled', 'not-a-boolean')).toThrow(InputError);
    expect(session.warnings()).toBe(updated);
  });

  it.each(['constructor', 'toString', 'valueOf', 'hasOwnProperty'])(
    'rejects inherited input id %s without changing the session',
    async (id) => {
      const session = await Session.open(fixture([...BASE, '      args: []']), { environment: {} });
      const plan = session.plan();
      const inputs = session.allInputs();

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
    const plan = session.plan();
    const inputs = session.allInputs();

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
    const plan = session.plan();
    const inputs = session.allInputs();
    const pending = session.pendingInputs();

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

    const failure = failureResults.createFailureResult({
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

  it('keeps completed-plan secrets active at session sinks until a successful edit', async () => {
    const relativeSecret = 'private/../secret-target';
    const replacement = 'private/../replacement-target';
    const path = fixture([
      'schemaVersion: 1',
      'product:',
      '  name: Example',
      '  version: "1.0.0"',
      'inputs:',
      '  workingDirectory:',
      '    type: secret',
      '  originalMirror:',
      '    type: text',
      '  replacementMirror:',
      '    type: text',
      '  choice:',
      '    type: select',
      '    options: [accepted]',
      '    required: false',
      'steps:',
      '  - id: install',
      '    run:',
      '      command: node',
      '      cwd: "${workingDirectory}"',
    ]);
    const derivedSecret = resolve(dirname(path), relativeSecret);
    const replacementDerived = resolve(dirname(path), replacement);
    const session = await Session.open(path, {
      environment: {},
      mode: 'interactive',
      overrides: {
        workingDirectory: relativeSecret,
        originalMirror: derivedSecret,
        replacementMirror: replacementDerived,
      },
    });
    const strings = session.getStrings();
    const resolutionInputs = session.allInputs();
    const resolutionPending = session.pendingInputs();
    expect(resolutionInputs.find((input) => input.id === 'originalMirror')?.value).toBe(
      derivedSecret,
    );
    expect(Object.isFrozen(resolutionInputs)).toBe(true);
    expect(resolutionInputs.every(Object.isFrozen)).toBe(true);

    const plan = session.plan();
    const plannedInputs = session.allInputs();
    const plannedPending = session.pendingInputs();
    expect(plannedInputs).not.toBe(resolutionInputs);
    expect(plannedPending).not.toBe(resolutionPending);
    expect(plannedInputs.find((input) => input.id === 'originalMirror')?.value).toBe('***');
    expect(plannedInputs.find((input) => input.id === 'replacementMirror')?.value).toBe(
      replacementDerived,
    );
    expect(resolutionInputs.find((input) => input.id === 'originalMirror')?.value).toBe(
      derivedSecret,
    );
    expect(session.plan()).toBe(plan);
    expect(session.allInputs()).toBe(plannedInputs);
    expect(session.pendingInputs()).toBe(plannedPending);
    expect(strings.chrome('rune.warning', { message: derivedSecret })).toBe('warning: ***');
    expect(formatSessionTerminalLine(strings, derivedSecret)).toBe('***');

    let rejection: InputError | undefined;
    try {
      session.setValue('choice', derivedSecret);
    } catch (error) {
      expect(error).toBeInstanceOf(InputError);
      rejection = error as InputError;
    }
    expect(rejection).toBeDefined();
    expect(rejection?.message).toContain('***');
    expect(rejection?.message).not.toContain(derivedSecret);
    expect(session.allInputs()).toBe(plannedInputs);
    expect(session.pendingInputs()).toBe(plannedPending);
    expect(session.plan()).toBe(plan);
    expect(formatSessionTerminalLine(strings, derivedSecret)).toBe('***');

    const failure = failureResults.createFailureResult({
      error: rejection!,
      manifestPath: path,
      dryRun: true,
      session,
    });
    expect(failure.error?.message).toContain('***');
    expect(failure.inputs.find((input) => input.id === 'originalMirror')?.value).toBe('***');
    expect(JSON.stringify(failure)).not.toContain(derivedSecret);

    expect(session.setValue('workingDirectory', replacement)).toEqual([]);
    const replacementResolutionInputs = session.allInputs();
    const replacementResolutionPending = session.pendingInputs();
    expect(replacementResolutionInputs).not.toBe(plannedInputs);
    expect(replacementResolutionPending).not.toBe(plannedPending);
    expect(replacementResolutionInputs.find((input) => input.id === 'originalMirror')?.value).toBe(
      derivedSecret,
    );
    expect(
      replacementResolutionInputs.find((input) => input.id === 'replacementMirror')?.value,
    ).toBe(replacementDerived);
    expect(formatSessionTerminalLine(strings, derivedSecret)).toBe(derivedSecret);
    expect(formatSessionTerminalLine(strings, replacementDerived)).toBe(replacementDerived);

    const replacementPlan = session.plan();
    expect(replacementPlan).not.toBe(plan);
    const replacementPlannedInputs = session.allInputs();
    const replacementPlannedPending = session.pendingInputs();
    expect(replacementPlannedInputs).not.toBe(replacementResolutionInputs);
    expect(replacementPlannedPending).not.toBe(replacementResolutionPending);
    expect(replacementPlannedInputs.find((input) => input.id === 'originalMirror')?.value).toBe(
      derivedSecret,
    );
    expect(replacementPlannedInputs.find((input) => input.id === 'replacementMirror')?.value).toBe(
      '***',
    );
    expect(session.plan()).toBe(replacementPlan);
    expect(session.allInputs()).toBe(replacementPlannedInputs);
    expect(session.pendingInputs()).toBe(replacementPlannedPending);
    expect(formatSessionTerminalLine(strings, derivedSecret)).toBe(derivedSecret);
    expect(formatSessionTerminalLine(strings, replacementDerived)).toBe('***');
  });

  it('publishes no plan-masked input snapshot when planning fails', async () => {
    const relativeSecret = 'private/../setup.cmd';
    const path = fixture([
      'schemaVersion: 1',
      'product:',
      '  name: Example',
      '  version: "1.0.0"',
      'inputs:',
      '  workingDirectory:',
      '    type: secret',
      '  mirror:',
      '    type: text',
      '  unrelated:',
      '    type: text',
      '    default: before',
      '  enabled:',
      '    type: boolean',
      '    default: true',
      'steps:',
      '  - id: derive',
      '    run:',
      '      command: node',
      '      cwd: "${workingDirectory}"',
      '  - id: fail',
      '    run:',
      '      command: "${mirror}"',
    ]);
    const derivedSecret = resolve(dirname(path), relativeSecret);
    const session = await Session.open(path, {
      environment: {},
      mode: 'interactive',
      overrides: { workingDirectory: relativeSecret, mirror: derivedSecret },
      platform: 'windows',
    });
    const inputs = session.allInputs();
    const pending = session.pendingInputs();
    const strings = session.getStrings();

    let planningError: ExecutionError | undefined;
    try {
      session.plan();
    } catch (error) {
      expect(error).toBeInstanceOf(ExecutionError);
      planningError = error as ExecutionError;
    }
    expect(planningError).toMatchObject({ code: 'RUNE-405' });
    expect(planningError?.message).toContain('***');
    expect(planningError?.message).not.toContain(derivedSecret);
    expect(session.allInputs()).toBe(inputs);
    expect(session.pendingInputs()).toBe(pending);
    expect(session.allInputs().find((input) => input.id === 'mirror')?.value).toBe(derivedSecret);
    expect(formatSessionTerminalLine(strings, derivedSecret)).toBe(derivedSecret);

    const failure = failureResults.createFailureResult({
      error: planningError!,
      manifestPath: path,
      dryRun: true,
      session,
    });
    expect(failure).toMatchObject({
      status: 'failed',
      error: { code: 'RUNE-405' },
      inputs: [
        { id: 'workingDirectory', value: null, secret: true },
        { id: 'mirror', value: '***', secret: false },
        { id: 'unrelated', value: 'before', secret: false },
        { id: 'enabled', value: true, secret: false },
      ],
    });
    expect(JSON.stringify(failure)).not.toContain(derivedSecret);

    const cancelledFailure = failureResults.createFailureResult({
      error: new CancelledError(),
      manifestPath: path,
      dryRun: true,
      session,
    });
    expect(cancelledFailure).toMatchObject({
      status: 'cancelled',
      error: { code: 'RUNE-601' },
      inputs: [
        { id: 'workingDirectory', value: null, secret: true },
        { id: 'mirror', value: '***', secret: false },
        { id: 'unrelated', value: '***', secret: false },
        { id: 'enabled', value: true, secret: false },
      ],
    });
    expect(JSON.stringify(cancelledFailure)).not.toContain(derivedSecret);

    let rejectedError: InputError | undefined;
    try {
      session.setValue('unknown', 'rejected');
    } catch (error) {
      expect(error).toBeInstanceOf(InputError);
      rejectedError = error as InputError;
    }
    const rejectedFailure = failureResults.createFailureResult({
      error: rejectedError!,
      manifestPath: path,
      dryRun: true,
      session,
    });
    expect(rejectedFailure).toMatchObject({
      status: 'input_error',
      error: { code: 'RUNE-203' },
      inputs: [
        { id: 'workingDirectory', value: null, secret: true },
        { id: 'mirror', value: '***', secret: false },
        { id: 'unrelated', value: '***', secret: false },
        { id: 'enabled', value: true, secret: false },
      ],
    });
    expect(JSON.stringify(rejectedFailure)).not.toContain(derivedSecret);
    expect(session.allInputs()).toBe(inputs);
    expect(session.pendingInputs()).toBe(pending);

    const foreignFailure = failureResults.createFailureResult({
      error: new ExecutionError('RUNE-405', planningError!.message),
      manifestPath: path,
      dryRun: true,
      session,
    });
    expect(foreignFailure).toMatchObject({
      status: 'internal_error',
      error: { code: 'RUNE-500' },
      inputs: [
        { id: 'workingDirectory', value: null, secret: true },
        { id: 'mirror', value: '***', secret: false },
        { id: 'unrelated', value: '***', secret: false },
        { id: 'enabled', value: true, secret: false },
      ],
    });
    expect(JSON.stringify(foreignFailure)).not.toContain(derivedSecret);

    expect(session.setValue('unrelated', 'after')).toEqual([]);
    const staleFailure = failureResults.createFailureResult({
      error: planningError!,
      manifestPath: path,
      dryRun: true,
      session,
    });
    expect(staleFailure).toMatchObject({
      status: 'internal_error',
      error: { code: 'RUNE-500' },
      inputs: [
        { id: 'workingDirectory', value: null, secret: true },
        { id: 'mirror', value: '***', secret: false },
        { id: 'unrelated', value: '***', secret: false },
        { id: 'enabled', value: true, secret: false },
      ],
    });
    expect(JSON.stringify(staleFailure)).not.toContain(derivedSecret);
    expect(() => session.plan()).toThrow(/needs a shell/);
    expect(session.allInputs()).not.toBe(inputs);
    expect(session.pendingInputs()).not.toBe(pending);
  });

  it('preserves ordinary strings before any failed planning attempt', async () => {
    const path = fixture([
      'schemaVersion: 1',
      'product:',
      '  name: Example',
      '  version: "1.0.0"',
      'inputs:',
      '  channel:',
      '    type: text',
      '    default: stable',
      '  enabled:',
      '    type: boolean',
      '    default: true',
      'steps: []',
    ]);
    const session = await Session.open(path, {
      environment: {},
      mode: 'interactive',
    });

    let rejectedError: InputError | undefined;
    try {
      session.setValue('unknown', 'rejected');
    } catch (error) {
      expect(error).toBeInstanceOf(InputError);
      rejectedError = error as InputError;
    }
    const failure = failureResults.createFailureResult({
      error: rejectedError!,
      manifestPath: path,
      dryRun: true,
      session,
    });

    expect(failure).toMatchObject({
      status: 'input_error',
      error: { code: 'RUNE-203' },
      inputs: [
        { id: 'channel', value: 'stable', source: 'default', secret: false },
        { id: 'enabled', value: true, source: 'default', secret: false },
      ],
    });
  });

  it('fails closed when a plan cannot register a derived secret spelling', async () => {
    const relativeSecret = `private/../${'a'.repeat(132_000)}`;
    const path = fixture([
      'schemaVersion: 1',
      'product:',
      '  name: Example',
      '  version: "1.0.0"',
      'inputs:',
      '  workingDirectory:',
      '    type: secret',
      '  mirror:',
      '    type: text',
      'steps:',
      '  - id: derive',
      '    run:',
      '      command: node',
      '      cwd: "${workingDirectory}"',
    ]);
    const derivedSecret = resolve(dirname(path), relativeSecret);
    const session = await Session.open(path, {
      environment: {},
      mode: 'interactive',
      overrides: { workingDirectory: relativeSecret, mirror: derivedSecret },
    });
    const inputs = session.allInputs();
    const pending = session.pendingInputs();
    const strings = session.getStrings();

    let planningError: InputError | undefined;
    try {
      session.plan();
    } catch (error) {
      expect(error).toBeInstanceOf(InputError);
      planningError = error as InputError;
    }
    expect(planningError).toMatchObject({
      code: 'RUNE-202',
      message: 'the total size of secret input values exceeds the masking safety limit',
    });
    expect(session.allInputs()).toBe(inputs);
    expect(session.pendingInputs()).toBe(pending);
    expect(session.allInputs().find((input) => input.id === 'mirror')?.value).toBe(derivedSecret);
    expect(formatSessionTerminalLine(strings, derivedSecret)).toBe(derivedSecret);

    const failure = failureResults.createFailureResult({
      error: planningError!,
      manifestPath: path,
      dryRun: true,
      session,
    });
    expect(failure).toMatchObject({
      status: 'input_error',
      error: {
        code: 'RUNE-202',
        message: 'the total size of secret input values exceeds the masking safety limit',
      },
      inputs: [
        { id: 'workingDirectory', value: null, secret: true },
        { id: 'mirror', value: '***', secret: false },
      ],
    });
    expect(JSON.stringify(failure)).not.toContain(derivedSecret);
  });

  it('preserves failure provenance when a plan and rejected candidate exceed masking capacity', async () => {
    const partLength = Math.floor(MAX_SECRET_REGISTRY_CODE_UNITS / 3) + 100;
    const relativeSecret = `private/../${'a'.repeat(partLength)}`;
    const candidateSecret = 'b'.repeat(partLength);
    const path = fixture([
      'schemaVersion: 1',
      'product:',
      '  name: Example',
      '  version: "1.0.0"',
      'inputs:',
      '  workingDirectory:',
      '    type: secret',
      '  dependent:',
      '    type: text',
      '    required: false',
      '    when: "${workingDirectory} == ${env.TRIGGER}"',
      '    default: "${env.MISSING}"',
      'steps:',
      '  - id: install',
      '    run:',
      '      command: node',
      '      cwd: "${workingDirectory}"',
    ]);
    const session = await Session.open(path, {
      environment: { TRIGGER: candidateSecret },
      mode: 'interactive',
      overrides: { workingDirectory: relativeSecret },
    });
    const plan = session.plan();
    const inputs = session.allInputs();

    let rejection: InputError | undefined;
    try {
      session.setValue('workingDirectory', candidateSecret);
    } catch (error) {
      expect(error).toBeInstanceOf(InputError);
      rejection = error as InputError;
    }

    expect(rejection).toMatchObject({
      code: 'RUNE-202',
      message: 'the total size of secret input values exceeds the masking safety limit',
    });
    expect(session.allInputs()).toBe(inputs);
    expect(session.plan()).toBe(plan);

    const failure = failureResults.createFailureResult({
      error: rejection!,
      manifestPath: path,
      dryRun: false,
      session,
    });
    expect(failure).toMatchObject({
      status: 'input_error',
      error: {
        code: 'RUNE-202',
        message: 'the total size of secret input values exceeds the masking safety limit',
      },
    });
  });

  it('retains a new secret only for a later resolution failure and its result', async () => {
    const secret = 'MISSING_ENV';
    const path = fixture([
      'schemaVersion: 1',
      'product:',
      '  name: Example',
      '  version: "1.0.0"',
      'inputs:',
      '  token:',
      '    type: secret',
      '    required: false',
      '  dependent:',
      '    type: text',
      '    required: false',
      `    when: "\${token} == '${secret}'"`,
      `    default: "\${env.${secret}}"`,
      'steps: []',
    ]);
    const session = await Session.open(path, { environment: {}, mode: 'gui' });
    const plan = session.plan();
    const inputs = session.allInputs();
    const pending = session.pendingInputs();

    let rejection: ResolutionError | undefined;
    try {
      session.setValue('token', secret);
    } catch (error) {
      expect(error).toBeInstanceOf(ResolutionError);
      rejection = error as ResolutionError;
    }

    expect(rejection).toBeDefined();
    const diagnostics = [
      rejection!.message,
      String(rejection),
      rejection!.stack ?? '',
      formatRuneError(rejection!),
      formatIssues(rejection!.issues),
      JSON.stringify(rejection!.issues),
    ];
    let cause = rejection!.cause;
    while (cause instanceof Error) {
      diagnostics.push(cause.message, String(cause), cause.stack ?? '');
      cause = cause.cause;
    }
    for (const diagnostic of diagnostics) {
      expect(diagnostic).not.toContain(secret);
    }
    expect(rejection!.message).toContain('***');

    expect(session.allInputs()).toBe(inputs);
    expect(session.pendingInputs()).toBe(pending);
    expect(session.plan()).toBe(plan);
    expect(formatSessionTerminalLine(session.getStrings(), secret)).toBe(secret);

    const failure = failureResults.createFailureResult({
      error: rejection!,
      manifestPath: path,
      dryRun: false,
      session,
      plan,
    });
    expect(JSON.stringify(failure)).not.toContain(secret);
    expect(failure.error?.message).toContain('***');

    const replacement = 'replacement-secret';
    expect(session.setValue('token', replacement)).toEqual([]);
    expect(session.plan()).not.toBe(plan);
    expect(formatSessionTerminalLine(session.getStrings(), replacement)).toBe('***');
    expect(formatSessionTerminalLine(session.getStrings(), secret)).toBe(secret);
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

  it('keeps a collected rejection durable and authentic when plan adds a missing issue', async () => {
    const candidate = `A"B\\C\ud800\u001bTAIL`;
    const secondCandidate = `D"E\\F\ud800\u001bTAIL`;
    const path = fixture(
      [
        'schemaVersion: 1',
        'product:',
        '  name: Example',
        '  version: "1.0.0"',
        'inputs:',
        '  masker:',
        '    type: secret',
        '    required: false',
        '  choice:',
        '    type: select',
        '    options: [accepted]',
        '    required: false',
        '  choice2:',
        '    type: select',
        '    options: [accepted]',
        '    required: false',
        '  requiredInput:',
        '    type: text',
        'steps: []',
      ],
      {
        'values.yaml': `choice: ${JSON.stringify(candidate)}\nchoice2: ${JSON.stringify(secondCandidate)}\n`,
      },
    );
    const valuesPath = join(path, '..', 'values.yaml');
    const secretLines = [
      `${valuesPath}:1:1: choice (from ${valuesPath}): "A"B\\C\ud800\u001b`,
      `${valuesPath}:2:1: choice2 (from ${valuesPath}): "D"E\\F\ud800\u001b`,
      '***:1:1: ***',
    ];
    const secret = secretLines.join('\n');
    const visibleSecrets = secretLines.map((line) =>
      line
        .replaceAll('\\', '\\\\')
        .replaceAll('"', '\\"')
        .replaceAll('\ud800', '\\ud800')
        .replaceAll('\u001b', '\\u001b'),
    );
    const expectSafe = (text: string): void => {
      for (const protectedText of [...secretLines, ...visibleSecrets]) {
        expect(text).not.toContain(protectedText);
      }
    };
    const session = await Session.open(path, {
      mode: 'interactive',
      environment: {},
      values: [valuesPath],
      overrides: { masker: secret },
    });

    const issue = session.pendingInputs().find((input) => input.id === 'choice')?.rejection?.issue;
    expect(issue).toBeDefined();
    const copies = [
      structuredClone(issue!),
      { ...issue!, location: issue?.location === undefined ? undefined : { ...issue.location } },
      JSON.parse(JSON.stringify(issue)) as RuneIssue,
    ];
    for (const copied of copies) {
      const conventional = `${copied.location?.file}:${copied.location?.line}:${copied.location?.column}: ${copied.message}`;
      expectSafe(formatIssues([copied]));
      expectSafe(conventional);
    }

    let error: InputError | undefined;
    try {
      session.plan();
    } catch (cause) {
      expect(cause).toBeInstanceOf(InputError);
      error = cause as InputError;
    }
    expect(error?.issues).toHaveLength(3);
    const invalidIssues = error?.issues.filter((item) => item.code === 'RUNE-202') ?? [];
    expect(invalidIssues).toHaveLength(2);
    expect(invalidIssues[0]?.message).toBe(invalidIssues[1]?.message);
    expect(error?.location).toBe(error?.issues.find((item) => item.location)?.location);
    expect(error?.message).toContain('\n');
    expect(error?.message).toContain('requiredInput');
    for (const diagnostic of [
      error?.message ?? '',
      String(error),
      error?.stack ?? '',
      formatRuneError(error!),
      formatIssues(error!.issues),
    ]) {
      expectSafe(diagnostic);
    }

    const failure = failureResults.createFailureResult({
      error: error!,
      manifestPath: path,
      dryRun: true,
      session,
    });
    expect(failure.error?.message).toContain('\n');
    expect(failure.error?.message).toContain('requiredInput');
    expect(failure.error?.location).toEqual(error?.location);
    expectSafe(JSON.stringify(failure));

    session.setValue('requiredInput', 'provided');
    session.setValue('choice2', 'accepted');
    let singleError: InputError | undefined;
    try {
      session.plan();
    } catch (cause) {
      singleError = cause as InputError;
    }
    expect(singleError?.issues).toHaveLength(1);
    expect(singleError?.location).toBeUndefined();
    expectSafe(`${singleError?.location?.file ?? ''}: ${singleError?.message ?? ''}`);
    const singleFailure = failureResults.createFailureResult({
      error: singleError!,
      manifestPath: path,
      dryRun: true,
      session,
    });
    expect(singleFailure.error?.location).toBeNull();
    expectSafe(JSON.stringify(singleFailure));
  });

  it('keeps missing-input state and issue mappings through fallback collisions', async () => {
    const ids = ['alpha', 'beta', 'gamma'] as const;
    const path = fixture([
      'schemaVersion: 1',
      'product:',
      '  name: Example',
      '  version: "1.0.0"',
      'inputs:',
      '  rawCollision:',
      '    type: secret',
      '    required: false',
      '  markerCollision:',
      '    type: secret',
      '    required: false',
      '  emptyCollision:',
      '    type: secret',
      '    required: false',
      ...ids.flatMap((id) => [`  ${id}:`, '    type: text']),
      'steps: []',
    ]);
    const messages = ids.map(
      (id) =>
        `input "${id}" is required and has no value — supply it with --set ${id}=... | RUNE_INPUT_${id.toUpperCase()} | values-file key '${id}'`,
    );
    const rawAggregate = messages.map((message) => `${path}:1:1: ${message}`).join('\n');
    const protectedTexts = [rawAggregate, String.raw`***\n\n`, String.raw`\n\n`];
    const session = await Session.open(path, {
      environment: {},
      overrides: {
        rawCollision: protectedTexts[0]!,
        markerCollision: protectedTexts[1]!,
        emptyCollision: protectedTexts[2]!,
      },
    });

    expect(session.pendingInputs().map((input) => input.id)).toEqual(ids);
    let error: InputError | undefined;
    try {
      session.plan();
    } catch (caught) {
      if (caught instanceof InputError) error = caught;
    }

    expect(error).toBeInstanceOf(InputError);
    expect(error?.issues).toHaveLength(ids.length);
    expect(error?.message.split('\n')).toHaveLength(ids.length);
    expect(formatIssues(error!.issues)).toBe(error?.message);
    const jsonContent = JSON.stringify(error?.message).slice(1, -1);
    for (const secret of protectedTexts) {
      expect(error?.message).not.toContain(secret);
      expect(jsonContent).not.toContain(secret);
    }
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
    const plan = session.plan();
    const inputs = session.allInputs();

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

  it('rejects a drive-relative manifest log path at open, natively and in preview', async () => {
    const path = fixture([...BASE, 'execution:', '  logFile: "C:run.log"']);
    const foreign = hostPlatform() === 'windows' ? 'linux' : 'windows';

    await expect(Session.open(path, { environment: {} })).rejects.toMatchObject({
      code: 'RUNE-104',
    });
    await expect(Session.open(path, { environment: {}, platform: foreign })).rejects.toMatchObject({
      code: 'RUNE-104',
    });
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

  it('waits for a rejected observer without changing the event bracket', async () => {
    const session = await openSessionWithRunner(fixture(BASE), { environment: {} }, okRunner);
    let rejectObserver!: (reason?: unknown) => void;
    const held = new Promise<never>((_resolve, reject) => {
      rejectObserver = reject;
    });
    const events: RunEvent[] = [];
    const pending = session.execute((event) => {
      events.push(event);
      return event.kind === 'runStarted' ? held : undefined;
    });
    await vi.waitFor(() => expect(events.map((event) => event.kind)).toEqual(['runStarted']));
    rejectObserver(new Error('observer rejection'));
    expect((await pending).status).toBe('succeeded');
    expect(events.map((event) => event.kind)).toEqual([
      'runStarted',
      'stepStarted',
      'stepFinished',
      'runFinished',
    ]);
  });

  it('awaits terminal observation after log finalization and contains its rejection', async () => {
    const path = fixture(BASE);
    const logFile = join(path, '..', 'logs', 'run.log');
    const session = await openSessionWithRunner(path, { environment: {}, logFile }, okRunner);
    let rejectObserver!: (reason?: unknown) => void;
    const held = new Promise<never>((_resolve, reject) => {
      rejectObserver = reject;
    });
    const events: RunEvent[] = [];
    let settled = false;
    const pending = session
      .execute((event) => {
        events.push(event);
        return event.kind === 'runFinished' ? held : undefined;
      })
      .then((result) => {
        settled = true;
        return result;
      });
    await vi.waitFor(() => expect(events.at(-1)?.kind).toBe('runFinished'));
    expect(readFileSync(logFile, 'utf8')).toContain('run finished: succeeded (exit 0)');
    expect(settled).toBe(false);
    rejectObserver(new Error('terminal observer rejection'));
    expect((await pending).status).toBe('succeeded');
    expect(events.map((event) => event.kind)).toEqual([
      'runStarted',
      'stepStarted',
      'stepFinished',
      'runFinished',
    ]);
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

  it('protects structured plan fields while preserving exact execution bytes and identities', async () => {
    const quoted = '""';
    const commandSeen: Array<{ argv: string[]; cwd: string; env: Record<string, string> }> = [];
    const runner: Runner = {
      run: async (request) => {
        const reveal = (value: (typeof request.command.argv)[number]): string =>
          isSecretString(value) ? revealSecretString(value) : value;
        commandSeen.push({
          argv: request.command.argv.map(reveal),
          cwd: reveal(request.command.cwd),
          env: Object.fromEntries(
            Object.entries(request.command.env).map(([name, value]) => [name, reveal(value)]),
          ),
        });
        return { kind: 'exited', exitCode: 0 };
      },
    };
    const path = fixture([
      'schemaVersion: 1',
      'product:',
      `  name: ${JSON.stringify(quoted)}`,
      '  version: "1.0.0"',
      'inputs:',
      '  token:',
      '    type: secret',
      '  note:',
      '    type: text',
      `    default: ${JSON.stringify(quoted)}`,
      'steps:',
      '  - id: exact-step-identity',
      `    title: ${JSON.stringify(quoted)}`,
      '    run:',
      '      command: node',
      `      args: ${JSON.stringify([quoted])}`,
      `      cwd: ${JSON.stringify(quoted)}`,
      '      env:',
      `        EXACT_ENV_IDENTITY: ${JSON.stringify(quoted)}`,
    ]);
    const session = await openSessionWithRunner(
      path,
      {
        mode: 'non-interactive',
        environment: {},
        overrides: { token: String.raw`\"\"` },
      },
      runner,
    );
    const plan = session.plan();
    const step = plan.steps[0];
    if (step?.state !== 'PENDING') throw new Error('expected pending step');

    expect(plan.resolvedInputs.find((input) => input.id === 'note')?.value).toBe('***');
    expect(plan.resolvedInputs.map((input) => input.id)).toEqual(['token', 'note']);
    expect(step.id).toBe('exact-step-identity');
    expect(step.title).toBe('***');
    expect(step.command.argv[0]).toBe('node');
    expect(isSecretString(step.command.argv[1])).toBe(true);
    expect(isSecretString(step.command.cwd)).toBe(true);
    expect(Object.keys(step.command.env)).toEqual(['EXACT_ENV_IDENTITY']);
    expect(isSecretString(step.command.env.EXACT_ENV_IDENTITY)).toBe(true);

    const events: RunEvent[] = [];
    const result = await session.execute((event) => events.push(event));
    expect(commandSeen).toEqual([
      {
        argv: ['node', quoted],
        cwd: join(path, '..', quoted),
        env: { EXACT_ENV_IDENTITY: quoted },
      },
    ]);
    expect(events.find((event) => event.kind === 'stepStarted')).toMatchObject({
      stepId: 'exact-step-identity',
      title: '***',
    });
    expect(result.product).toMatchObject({ name: quoted });
    expect(result.inputs.find((input) => input.id === 'note')?.value).toBe('***');
    expect(result.steps[0]).toMatchObject({
      id: 'exact-step-identity',
      title: '***',
      command: ['node', '***'],
    });
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
        '  token:',
        '    type: secret',
        '    required: false',
        'steps:',
        '  - id: install',
        '    run:',
        '      command: node',
        '      args: ["${target}", "${token}"]',
      ]),
      { environment: {}, overrides: { token: 'token' } },
      {
        run: async (request) => {
          requests.push(request);
          runnerStarted();
          return await runnerFinished;
        },
      },
    );
    const warnings = session.warnings();
    expect(warnings).toHaveLength(1);
    expect(JSON.stringify(warnings)).not.toContain('token');
    const plan = session.plan();
    const inputs = session.allInputs();

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
    expect(requests[0]?.command.argv.slice(0, 2)).toEqual(['node', 'before']);
    expect(String(requests[0]?.command.argv[2])).toBe('***');

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
    expect(updatedStep.command.argv.slice(0, 2)).toEqual(['node', 'after']);
    expect(String(updatedStep.command.argv[2])).toBe('***');
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

  it('updates a previously returned terminal projector after a successful secret edit', async () => {
    const path = fixture([
      'schemaVersion: 1',
      'product:',
      '  name: Example',
      '  version: "1.0.0"',
      'inputs:',
      '  lateSecret:',
      '    type: secret',
      'steps: []',
      'gui:',
      `  windowTitle: ${JSON.stringify('\u001b')}`,
    ]);
    const session = await Session.open(path, { mode: 'interactive', environment: {} });
    const strings = session.getStrings();
    const renderedSecret = String.raw`\u001b`;

    expect(formatSessionTerminalLine(strings, '\u001b')).toBe(renderedSecret);
    expect(strings.chrome('rune.warning', { message: '\u001b' })).toBe('warning: \u001b');
    expect(session.getThemeConfig()).toEqual({ windowTitle: '\u001b' });

    expect(session.setValue('lateSecret', renderedSecret)).toEqual([]);
    expect(session.getStrings()).toBe(strings);
    expect(strings.chrome('rune.warning', { message: '\u001b' })).toBe('***');
    expect(session.getThemeConfig()).toEqual({ windowTitle: '***' });
    expect(formatSessionTerminalLine(strings, renderedSecret)).toBe('***');
    expect(formatSessionTerminalLine(strings, '\u001b')).toBe('***');
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

  it('anchors every drive-relative theme path outside GUI mode without asset I/O', async () => {
    const path = fixture([
      ...BASE,
      'gui:',
      '  logo: "C:logo.png"',
      '  banner: "C:banner.png"',
      '  theme: "C:theme.css"',
    ]);
    const session = await Session.open(path, { mode: 'non-interactive', environment: {} });

    expect(session.getThemeConfig()).toEqual({
      logo: join(path, '..', 'C:logo.png'),
      banner: join(path, '..', 'C:banner.png'),
      theme: join(path, '..', 'C:theme.css'),
    });
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
    const manifestPath = fixture(BASE);
    const logDirectory = join(manifestPath, '..', 'preview-logs');
    const logFile = join(logDirectory, 'run.log');
    const session = await Session.open(manifestPath, {
      environment: {},
      platform: foreign,
      logFile,
    });

    expect(session.describe().crossPlatformPreview).toBe(true);
    await expect(session.execute()).rejects.toMatchObject({
      code: 'RUNE-500',
      name: InternalError.name,
      message: expect.stringContaining('preview plan'),
    });
    expect(existsSync(logDirectory)).toBe(false);
    expect(existsSync(logFile)).toBe(false);
  });
});
