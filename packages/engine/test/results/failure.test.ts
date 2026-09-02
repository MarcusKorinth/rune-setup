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
  it('preserves a completed plan as SKIPPED/NOT_RUN and deeply freezes valid output', async () => {
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
      status: 'failed',
      exitCode: 1,
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
    expect(() =>
      createFailureResult({
        error: new ExecutionError('RUNE-405', 'command requires a shell'),
        manifestPath: runnablePath,
        dryRun: false,
        session: runnableSession,
        plan,
      }),
    ).toThrow(/pre-execution failure result cannot carry a completed plan/);
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
