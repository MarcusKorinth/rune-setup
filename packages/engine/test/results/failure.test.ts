import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { createFailureResult } from '../../src/engine/executor.js';
import { hostPlatform } from '../../src/engine/context.js';
import {
  CancelledError,
  ConditionError,
  ExecutionError,
  InputError,
  InternalError,
  ManifestError,
  ResolutionError,
} from '../../src/errors.js';
import { Session } from '../../src/engine/session.js';
import { manifestDescriptorFor } from '../../src/manifest/index.js';
import { resultV1Schema } from '../../src/results/schema.js';

const SECRET = 'factory-secret-value';

function fixture(lines: readonly string[]): string {
  const directory = mkdtempSync(join(tmpdir(), 'rune-failure-result-'));
  const path = join(directory, 'installer.yaml');
  writeFileSync(path, [...lines, ''].join('\n'), 'utf8');
  return path;
}

describe('createFailureResult', () => {
  it('projects an external error generically while preserving a completed plan', async () => {
    const path = fixture([
      'schemaVersion: 1',
      'product:',
      '  name: Example',
      '  version: "1.0.0"',
      'inputs:',
      '  enabled:',
      '    type: boolean',
      '    default: false',
      '  ignoredInput:',
      '    type: text',
      '    when: "${enabled}"',
      '  token:',
      '    type: secret',
      '  mirror:',
      '    type: text',
      'steps:',
      '  - id: skipped',
      '    when: "${enabled}"',
      '    run:',
      '      command: never-runs',
      '  - id: pending',
      '    run:',
      '      command: deploy',
      `      args: ["--token=\${token}", "prefix-${SECRET}", "\${mirror}"]`,
    ]);
    const session = await Session.open(path, {
      environment: {},
      overrides: { ignoredInput: 'discarded', token: SECRET, mirror: `mirror-${SECRET}` },
    });
    const plan = session.plan();

    const result = createFailureResult({
      error: new ExecutionError('RUNE-406', 'the log sink failed'),
      manifestPath: path,
      dryRun: false,
      session,
      plan,
    });

    expect(() => resultV1Schema.parse(result)).not.toThrow();
    expect(result).toMatchObject({
      status: 'internal_error',
      exitCode: 70,
      stepsTotal: 2,
      stepsExecuted: 0,
      stepsSkipped: 1,
      stepsNotRun: 1,
      nothingExecuted: true,
      steps: [
        { id: 'skipped', state: 'SKIPPED', command: null },
        {
          id: 'pending',
          state: 'NOT_RUN',
          command: ['deploy', '***', '***', '***'],
        },
      ],
    });
    expect(result.inputs).toMatchObject([
      { id: 'enabled', value: false, source: 'default', secret: false, enabled: true },
      {
        id: 'ignoredInput',
        value: '',
        source: 'set',
        secret: false,
        enabled: false,
        ignored: 'input disabled',
      },
      { id: 'token', value: null, source: 'set', secret: true, enabled: true },
      { id: 'mirror', value: 'mirror-***', source: 'set', secret: false, enabled: true },
    ]);
    expect(JSON.stringify(result)).not.toContain(SECRET);
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.inputs)).toBe(true);
    expect(Object.isFrozen(result.inputs[0])).toBe(true);
    expect(Object.isFrozen(result.steps)).toBe(true);
    expect(Object.isFrozen(result.steps[1])).toBe(true);
    expect(Object.isFrozen(result.steps[1]?.command)).toBe(true);
    expect(() => (result.inputs as unknown[]).pop()).toThrow(TypeError);
    expect(() => (result.steps[1]?.command as string[]).push(SECRET)).toThrow(TypeError);
  });

  it('keeps resolved session identity and inputs when planning itself fails', async () => {
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
      `    default: ${SECRET}`,
      'steps: []',
    ]);
    const foreign = hostPlatform() === 'windows' ? 'linux' : 'windows';
    const session = await Session.open(path, {
      environment: {},
      overrides: { token: SECRET },
      mode: 'interactive',
      locale: 'de-DE',
      platform: foreign,
    });

    const result = createFailureResult({
      error: new ResolutionError('RUNE-301', 'missing environment value'),
      manifestPath: path,
      dryRun: true,
      session,
    });

    expect(() => resultV1Schema.parse(result)).not.toThrow();
    expect(result.manifest).toMatchObject({
      path,
      sha256: manifestDescriptorFor(session.manifest).sha256,
      schemaVersion: 1,
    });
    expect(result.product).toEqual({ name: 'Example', version: '1.0.0' });
    expect(result).toMatchObject({
      mode: 'interactive',
      platform: foreign,
      crossPlatformPreview: true,
      locale: 'de-DE',
    });
    expect(result.inputs).toMatchObject([
      { id: 'token', value: null, secret: true },
      { id: 'mirror', value: '***', secret: false },
    ]);
    expect(result.steps).toEqual([]);
    expect(JSON.stringify(result)).not.toContain(SECRET);
  });

  it('omits unresolved secret sentinels from an input-error result', async () => {
    const path = fixture([
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
      '  disabledEmpty:',
      '    type: secret',
      '    when: "${enabled}"',
      'steps: []',
    ]);
    const session = await Session.open(path, {
      mode: 'gui',
      environment: {},
      overrides: {
        requiredEmpty: '',
        optionalEmpty: '',
        disabledEmpty: '',
      },
    });
    let planningError: InputError | undefined;

    try {
      session.plan();
    } catch (error) {
      expect(error).toBeInstanceOf(InputError);
      planningError = error as InputError;
    }

    expect(planningError?.code).toBe('RUNE-201');
    expect(planningError?.issues).toHaveLength(2);
    expect(planningError?.issues.map((issue) => issue.message)).toEqual(
      expect.arrayContaining([
        expect.stringContaining('requiredMissing'),
        expect.stringContaining('requiredEmpty'),
      ]),
    );
    const result = createFailureResult({
      error: planningError!,
      manifestPath: path,
      dryRun: false,
      session,
    });

    expect(() => resultV1Schema.parse(result)).not.toThrow();
    expect(result).toMatchObject({ status: 'input_error', exitCode: 4, steps: [] });
    expect(result.inputs).toEqual([
      { id: 'enabled', value: false, source: 'default', secret: false, enabled: true },
      { id: 'optionalEmpty', value: null, source: 'set', secret: true, enabled: true },
      {
        id: 'disabledEmpty',
        value: null,
        source: 'set',
        secret: true,
        enabled: false,
        ignored: 'input disabled',
      },
    ]);
  });

  it('gives hit, miss, and embedded external candidates the same generic error', async () => {
    const path = fixture([
      'schemaVersion: 1',
      'product:',
      '  name: Example',
      '  version: "1.0.0"',
      'inputs:',
      '  token:',
      '    type: secret',
      'steps: []',
    ]);
    const session = await Session.open(path, { environment: {}, mode: 'interactive' });
    session.setValue('token', SECRET);

    const candidates = [SECRET, 'definitely-not-a-secret', `prefix-${SECRET}-suffix`];
    const errors = candidates.map(
      (candidate) =>
        createFailureResult({
          error: new InternalError(candidate, {
            location: { file: candidate, line: 1, column: 1 },
            cause: new Error(candidate),
          }),
          manifestPath: path,
          dryRun: false,
          session,
        }).error,
    );

    expect(errors[0]).toEqual(errors[1]);
    expect(errors[1]).toEqual(errors[2]);
    expect(errors[0]).toMatchObject({ code: 'RUNE-500', location: null });
    for (const candidate of candidates) {
      expect(JSON.stringify(errors)).not.toContain(candidate);
    }
  });

  it('uses the frozen projection of an authentic Session error after mutation', async () => {
    const secretCommand = `${SECRET}.cmd`;
    const path = fixture([
      'schemaVersion: 1',
      'product:',
      '  name: Example',
      '  version: "1.0.0"',
      'inputs:',
      '  token:',
      '    type: secret',
      'steps:',
      '  - id: legacy',
      '    run:',
      '      command: "${token}"',
    ]);
    const session = await Session.open(path, {
      environment: {},
      overrides: { token: secretCommand },
      platform: 'windows',
    });
    let authenticError: ExecutionError | undefined;
    try {
      session.plan();
    } catch (error) {
      authenticError = error as ExecutionError;
    }
    expect(authenticError).toBeInstanceOf(ExecutionError);

    Object.assign(authenticError as unknown as Record<string, unknown>, {
      code: 'RUNE-500',
      message: `mutated ${SECRET}`,
      location: { file: SECRET, line: 9, column: 9 },
    });
    const result = createFailureResult({
      error: authenticError!,
      manifestPath: path,
      dryRun: true,
      session,
    });

    expect(result).toMatchObject({
      status: 'failed',
      exitCode: 1,
      error: { code: 'RUNE-405', location: null },
    });
    expect(result.error?.message).toContain('***');
    expect(JSON.stringify(result)).not.toContain(SECRET);
  });

  it('does not authenticate an error against a different Session', async () => {
    const path = fixture([
      'schemaVersion: 1',
      'product:',
      '  name: Example',
      '  version: "1.0.0"',
      'steps:',
      '  - id: legacy',
      '    run:',
      '      command: setup.cmd',
    ]);
    const first = await Session.open(path, { environment: {}, platform: 'windows' });
    const second = await Session.open(path, { environment: {}, platform: 'windows' });
    let firstError: ExecutionError | undefined;
    try {
      first.plan();
    } catch (error) {
      firstError = error as ExecutionError;
    }

    const result = createFailureResult({
      error: firstError!,
      manifestPath: path,
      dryRun: true,
      session: second,
    });
    expect(result).toMatchObject({
      status: 'internal_error',
      exitCode: 70,
      error: { code: 'RUNE-500', location: null },
    });
  });

  it('does not authenticate a stale error after a successful Session edit', async () => {
    const path = fixture([
      'schemaVersion: 1',
      'product:',
      '  name: Example',
      '  version: "1.0.0"',
      'inputs:',
      '  enabled:',
      '    type: boolean',
      '    default: false',
      'steps:',
      '  - id: legacy',
      '    run:',
      '      command: setup.cmd',
    ]);
    const session = await Session.open(path, {
      environment: {},
      mode: 'interactive',
      platform: 'windows',
    });
    let staleError: ExecutionError | undefined;
    try {
      session.plan();
    } catch (error) {
      staleError = error as ExecutionError;
    }
    session.setValue('enabled', true);

    const result = createFailureResult({
      error: staleError!,
      manifestPath: path,
      dryRun: true,
      session,
    });
    expect(result).toMatchObject({
      status: 'internal_error',
      exitCode: 70,
      error: { code: 'RUNE-500', location: null },
      inputs: [{ id: 'enabled', value: true, source: 'answer' }],
    });
  });

  it('retains an authentic error after a rejected Session edit', async () => {
    const path = fixture([
      'schemaVersion: 1',
      'product:',
      '  name: Example',
      '  version: "1.0.0"',
      'inputs:',
      '  enabled:',
      '    type: boolean',
      '    default: false',
      'steps:',
      '  - id: legacy',
      '    run:',
      '      command: setup.cmd',
    ]);
    const session = await Session.open(path, {
      environment: {},
      mode: 'interactive',
      platform: 'windows',
    });
    let retainedError: ExecutionError | undefined;
    try {
      session.plan();
    } catch (error) {
      retainedError = error as ExecutionError;
    }
    expect(() => session.setValue('enabled', 'not-a-boolean')).toThrow(InputError);

    const result = createFailureResult({
      error: retainedError!,
      manifestPath: path,
      dryRun: true,
      session,
    });
    expect(result).toMatchObject({
      status: 'failed',
      exitCode: 1,
      error: { code: 'RUNE-405', location: null },
      inputs: [{ id: 'enabled', value: false, source: 'default' }],
    });
  });

  it('reads an error getter once before provenance and projection', async () => {
    const path = fixture([
      'schemaVersion: 1',
      'product:',
      '  name: Example',
      '  version: "1.0.0"',
      'steps:',
      '  - id: legacy',
      '    run:',
      '      command: setup.cmd',
    ]);
    const session = await Session.open(path, { environment: {}, platform: 'windows' });
    let authenticError: ExecutionError | undefined;
    try {
      session.plan();
    } catch (error) {
      authenticError = error as ExecutionError;
    }
    let errorReads = 0;

    const result = createFailureResult({
      get error() {
        errorReads += 1;
        return errorReads === 1 ? authenticError! : new InternalError(SECRET);
      },
      manifestPath: path,
      dryRun: true,
      session,
    });

    expect(errorReads).toBe(1);
    expect(result).toMatchObject({ status: 'failed', error: { code: 'RUNE-405' } });
  });

  it.each([
    ['proxy', (session: Session) => new Proxy(session, {})],
    ['foreign structural object', (session: Session) => Object.create(session) as Session],
  ])('rejects a non-authentic %s context without invoking it', async (_name, wrap) => {
    const path = fixture([
      'schemaVersion: 1',
      'product:',
      '  name: Example',
      '  version: "1.0.0"',
      'steps: []',
    ]);
    const session = await Session.open(path, { environment: {} });

    expect(() =>
      createFailureResult({
        error: new InternalError('failure'),
        manifestPath: path,
        dryRun: false,
        session: wrap(session),
      }),
    ).toThrow('a failure result requires an authentic opened Session');
  });

  it('keeps planned commands PENDING in a dry-run failure result', async () => {
    const path = fixture([
      'schemaVersion: 1',
      'product:',
      '  name: Example',
      '  version: "1.0.0"',
      'steps:',
      '  - id: pending',
      '    run:',
      '      command: deploy',
    ]);
    const session = await Session.open(path, { environment: {} });
    const plan = session.plan();

    const result = createFailureResult({
      error: new InternalError('dry-run rendering failed'),
      manifestPath: path,
      dryRun: true,
      session,
      plan,
    });

    expect(() => resultV1Schema.parse(result)).not.toThrow();
    expect(result).toMatchObject({
      dryRun: true,
      stepsExecuted: 0,
      stepsNotRun: 1,
      nothingExecuted: true,
      steps: [{ id: 'pending', state: 'PENDING', command: ['deploy'] }],
    });
  });

  it('rejects an authentic plan that belongs to another Session', async () => {
    const path = fixture([
      'schemaVersion: 1',
      'product:',
      '  name: Example',
      '  version: "1.0.0"',
      'steps: []',
    ]);
    const session = await Session.open(path, { environment: {} });
    const foreignSession = await Session.open(path, { environment: {} });
    const foreignPlan = foreignSession.plan();

    expect(() =>
      createFailureResult({
        error: new InternalError('failure'),
        manifestPath: path,
        dryRun: false,
        session,
        plan: foreignPlan,
      }),
    ).toThrow('a failure result requires the current plan of its opened Session');
  });

  it('rejects a stale plan after a successful Session edit', async () => {
    const path = fixture([
      'schemaVersion: 1',
      'product:',
      '  name: Example',
      '  version: "1.0.0"',
      'inputs:',
      '  enabled:',
      '    type: boolean',
      '    default: false',
      'steps: []',
    ]);
    const session = await Session.open(path, { environment: {}, mode: 'interactive' });
    const stalePlan = session.plan();
    session.setValue('enabled', true);

    expect(() =>
      createFailureResult({
        error: new InternalError('failure'),
        manifestPath: path,
        dryRun: false,
        session,
        plan: stalePlan,
      }),
    ).toThrow('a failure result requires the current plan of its opened Session');
  });

  it('reads a current plan getter once and keeps that plan consistent', async () => {
    const path = fixture([
      'schemaVersion: 1',
      'product:',
      '  name: Current',
      '  version: "1.0.0"',
      'steps:',
      '  - id: current',
      '    run:',
      '      command: current-command',
    ]);
    const foreignPath = fixture([
      'schemaVersion: 1',
      'product:',
      '  name: Foreign',
      '  version: "2.0.0"',
      'steps:',
      '  - id: foreign',
      '    run:',
      '      command: foreign-command',
    ]);
    const session = await Session.open(path, { environment: {} });
    const foreignSession = await Session.open(foreignPath, { environment: {} });
    const currentPlan = session.plan();
    const foreignPlan = foreignSession.plan();
    let planReads = 0;

    const result = createFailureResult({
      error: new InternalError('failure'),
      manifestPath: path,
      dryRun: false,
      session,
      get plan() {
        planReads += 1;
        return planReads === 1 ? currentPlan : foreignPlan;
      },
    });

    expect(planReads).toBe(1);
    expect(result.product).toEqual({ name: 'Current', version: '1.0.0' });
    expect(result.manifest.path).toBe(path);
    expect(result.steps).toMatchObject([{ id: 'current', command: ['current-command'] }]);
  });

  it('rejects a getter that switches plans around the Session binding check', async () => {
    const path = fixture([
      'schemaVersion: 1',
      'product:',
      '  name: Current',
      '  version: "1.0.0"',
      'steps: []',
    ]);
    const foreignPath = fixture([
      'schemaVersion: 1',
      'product:',
      '  name: Foreign',
      '  version: "2.0.0"',
      'steps:',
      '  - id: foreign',
      '    run:',
      '      command: foreign-command',
    ]);
    const session = await Session.open(path, { environment: {} });
    const foreignSession = await Session.open(foreignPath, { environment: {} });
    const currentPlan = session.plan();
    const foreignPlan = foreignSession.plan();
    let planReads = 0;

    expect(() =>
      createFailureResult({
        error: new InternalError('failure'),
        manifestPath: path,
        dryRun: false,
        session,
        get plan() {
          planReads += 1;
          if (planReads <= 2 || planReads > 6) {
            return foreignPlan;
          }
          return currentPlan;
        },
      }),
    ).toThrow('a failure result requires the current plan of its opened Session');
    expect(planReads).toBe(1);
  });

  it('rejects a changing plan getter before looking up its execution context', async () => {
    const path = fixture([
      'schemaVersion: 1',
      'product:',
      '  name: Current',
      '  version: "1.0.0"',
      'steps: []',
    ]);
    const session = await Session.open(path, { environment: {} });
    session.plan();
    let planReads = 0;
    const unauthenticPlan = {} as ReturnType<Session['plan']>;

    expect(() =>
      createFailureResult({
        error: new InternalError('failure'),
        manifestPath: path,
        dryRun: false,
        session,
        get plan() {
          planReads += 1;
          return unauthenticPlan;
        },
      }),
    ).toThrow('a failure result requires the current plan of its opened Session');
    expect(planReads).toBe(1);
  });

  it('retains the current plan after a rejected Session edit', async () => {
    const path = fixture([
      'schemaVersion: 1',
      'product:',
      '  name: Example',
      '  version: "1.0.0"',
      'inputs:',
      '  enabled:',
      '    type: boolean',
      '    default: false',
      'steps: []',
    ]);
    const session = await Session.open(path, { environment: {}, mode: 'interactive' });
    const plan = session.plan();
    expect(() => session.setValue('enabled', 'not-a-boolean')).toThrow(InputError);

    const result = createFailureResult({
      error: new InternalError('failure'),
      manifestPath: path,
      dryRun: false,
      session,
      plan,
    });

    expect(result.status).toBe('internal_error');
    expect(result.inputs).toMatchObject([
      { id: 'enabled', value: false, source: 'default', enabled: true },
    ]);
  });

  it('represents a plan-time execution error without inventing a failed step', async () => {
    const path = fixture([
      'schemaVersion: 1',
      'product:',
      '  name: Example',
      '  version: "1.0.0"',
      'inputs:',
      '  channel:',
      '    type: text',
      '    default: stable',
      'steps:',
      '  - id: legacy',
      '    run:',
      '      command: setup.cmd',
    ]);
    const session = await Session.open(path, { environment: {}, platform: 'windows' });
    let planningError: ExecutionError | undefined;
    try {
      session.plan();
    } catch (error) {
      expect(error).toBeInstanceOf(ExecutionError);
      planningError = error as ExecutionError;
    }
    expect(planningError).toBeDefined();

    const result = createFailureResult({
      error: planningError!,
      manifestPath: path,
      dryRun: true,
      session,
    });

    expect(() => resultV1Schema.parse(result)).not.toThrow();
    expect(result).toMatchObject({
      status: 'failed',
      exitCode: 1,
      product: { name: 'Example', version: '1.0.0' },
      manifest: {
        path,
        sha256: manifestDescriptorFor(session.manifest).sha256,
        schemaVersion: 1,
      },
      stepsTotal: 0,
      stepsExecuted: 0,
      nothingExecuted: true,
      inputs: [{ id: 'channel', value: 'stable', source: 'default' }],
      steps: [],
    });

    const runnablePath = fixture([
      'schemaVersion: 1',
      'product:',
      '  name: Example',
      '  version: "1.0.0"',
      'steps:',
      '  - id: runnable',
      '    run:',
      '      command: node',
    ]);
    const runnableSession = await Session.open(runnablePath, { environment: {} });
    const plan = runnableSession.plan();
    const externalResult = createFailureResult({
      error: new ExecutionError('RUNE-405', 'command requires a shell'),
      manifestPath: runnablePath,
      dryRun: false,
      session: runnableSession,
      plan,
    });
    expect(externalResult).toMatchObject({ status: 'internal_error', exitCode: 70 });
    expect(externalResult.steps).toMatchObject([{ id: 'runnable', state: 'NOT_RUN' }]);
  });

  it.each([
    {
      name: 'manifest',
      error: new ManifestError('RUNE-103', 'manifest invalid'),
      status: 'config_error',
      exitCode: 3,
    },
    {
      name: 'internal',
      error: new InternalError('failure before validation'),
      status: 'internal_error',
      exitCode: 70,
    },
  ])(
    'uses honest empty identity for a context-free $name failure',
    ({ error, status, exitCode }) => {
      const result = createFailureResult({
        error,
        manifestPath: 'broken.yaml',
        dryRun: false,
        platform: hostPlatform(),
      });

      expect(() => resultV1Schema.parse(result)).not.toThrow();
      expect(result).toMatchObject({
        status,
        exitCode,
        product: null,
        manifest: { path: 'broken.yaml', sha256: null, schemaVersion: null },
        inputs: [],
        steps: [],
      });
      expect(Object.isFrozen(result.manifest)).toBe(true);
      expect(result.product).toBeNull();
    },
  );

  it.each([
    ['input error', new InputError('RUNE-201', 'input missing')],
    ['resolution error', new ResolutionError('RUNE-301', 'value unresolved')],
    ['condition error', new ConditionError('RUNE-311', 'condition invalid')],
    ['cancellation', new CancelledError()],
    ['RUNE-401 execution error', new ExecutionError('RUNE-401', 'step failed')],
    ['RUNE-404 execution error', new ExecutionError('RUNE-404', 'cwd invalid')],
    ['RUNE-405 execution error', new ExecutionError('RUNE-405', 'shell required')],
    ['RUNE-406 execution error', new ExecutionError('RUNE-406', 'log unavailable')],
  ])('refuses a context-free %s without validated identity', (_name, error) => {
    expect(() =>
      createFailureResult({
        error,
        manifestPath: 'installer.yaml',
        dryRun: false,
        platform: hostPlatform(),
      }),
    ).toThrow('a post-validation failure result requires opened-session context');
  });
});
