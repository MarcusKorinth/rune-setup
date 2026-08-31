import { describe, expect, it } from 'vitest';

import { PLATFORMS } from '../../src/engine/context.js';
import { VALUE_SOURCES } from '../../src/engine/inputs.js';
import { STEP_STATES } from '../../src/engine/state.js';
import { resultJsonSchema } from '../../src/index.js';
import {
  EXIT_CODE_BY_STATUS,
  RUN_MODES,
  RUN_STATUSES,
  type ResultInput,
  type ResultStep,
  type RunResult,
} from '../../src/results/model.js';
import { resultV1Schema } from '../../src/results/schema.js';
import { serializeResult } from '../../src/results/writer.js';

const RESULT_ID = '123e4567-e89b-42d3-a456-426614174000';
const SHA256 = 'a'.repeat(64);

const _checkResultInputCorrelation = (): void => {
  const secret: ResultInput = {
    id: 'secret',
    value: null,
    source: 'set',
    secret: true,
    enabled: true,
  };
  const nonSecret: ResultInput = {
    id: 'text',
    value: 'visible',
    source: 'set',
    secret: false,
    enabled: true,
  };
  const disabledWithoutValue: ResultInput = {
    id: 'disabledWithoutValue',
    value: '',
    source: null,
    secret: false,
    enabled: false,
  };
  const disabledWithIgnoredValue: ResultInput = {
    id: 'disabledWithIgnoredValue',
    value: '',
    source: 'values',
    secret: false,
    enabled: false,
    ignored: 'input disabled',
  };
  // @ts-expect-error secret result inputs must never contain plaintext
  const plaintextSecret: ResultInput = { ...secret, value: 'plaintext' };
  // @ts-expect-error non-secret result inputs must always contain a value
  const nullNonSecret: ResultInput = { ...nonSecret, value: null };
  const enabledIgnored = {
    id: 'enabledIgnored',
    value: 'visible',
    source: 'set',
    secret: false,
    enabled: true,
    ignored: 'input disabled',
  } as const;
  // @ts-expect-error enabled inputs cannot record discarded input provenance
  const invalidEnabledIgnored: ResultInput = enabledIgnored;
  const disabledWithSource = {
    id: 'disabledWithSource',
    value: '',
    source: 'set',
    secret: false,
    enabled: false,
  } as const;
  // @ts-expect-error disabled inputs without a discarded value have no source
  const invalidDisabledWithSource: ResultInput = disabledWithSource;
  const ignoredDefault = {
    id: 'ignoredDefault',
    value: '',
    source: 'default',
    secret: false,
    enabled: false,
    ignored: 'input disabled',
  } as const;
  // @ts-expect-error a discarded disabled input cannot claim a manifest default
  const invalidIgnoredDefault: ResultInput = ignoredDefault;
  void disabledWithoutValue;
  void disabledWithIgnoredValue;
  void plaintextSecret;
  void nullNonSecret;
  void invalidEnabledIgnored;
  void invalidDisabledWithSource;
  void invalidIgnoredDefault;
};

const _checkResultStepCorrelation = (): void => {
  const identity = {
    id: 'step',
    title: 'Step',
    durationMs: 0,
  } as const;
  const valid: readonly ResultStep[] = [
    { ...identity, state: 'PENDING', exitCode: null, command: ['tool'], skipReason: null },
    {
      ...identity,
      state: 'SKIPPED',
      exitCode: null,
      command: null,
      skipReason: '',
    },
    { ...identity, state: 'SUCCEEDED', exitCode: 0, command: ['tool'], skipReason: null },
    { ...identity, state: 'FAILED', exitCode: null, command: ['tool'], skipReason: null },
    {
      ...identity,
      state: 'FAILED',
      exitCode: 1,
      command: ['tool'],
      skipReason: null,
      outputTail: [{ stream: 'stderr', line: 'failure' }],
    },
    { ...identity, state: 'CANCELLED', exitCode: null, command: ['tool'], skipReason: null },
    { ...identity, state: 'NOT_RUN', exitCode: null, command: ['tool'], skipReason: null },
  ];
  const runningFields = {
    ...identity,
    state: 'RUNNING',
    exitCode: null,
    command: ['tool'],
    skipReason: null,
  } as const;
  // @ts-expect-error RUNNING is an internal lifecycle state, never a result step state
  const running: ResultStep = runningFields;
  // @ts-expect-error outputTail is exclusive to FAILED result steps
  const succeededWithOutput: ResultStep = {
    ...identity,
    state: 'SUCCEEDED',
    exitCode: 0,
    command: ['tool'],
    skipReason: null,
    outputTail: [],
  };
  // @ts-expect-error PENDING result steps always retain their command
  const pendingWithoutCommand: ResultStep = {
    ...identity,
    state: 'PENDING',
    exitCode: null,
    command: null,
    skipReason: null,
  };
  // @ts-expect-error SKIPPED result steps have no command and require a reason
  const skippedWithCommand: ResultStep = {
    ...identity,
    state: 'SKIPPED',
    exitCode: null,
    command: ['tool'],
    skipReason: null,
  };
  // @ts-expect-error SUCCEEDED result steps require an exit code
  const succeededWithoutExitCode: ResultStep = {
    ...identity,
    state: 'SUCCEEDED',
    exitCode: null,
    command: ['tool'],
    skipReason: null,
  };
  // @ts-expect-error FAILED result steps cannot carry a skip reason
  const failedWithSkipReason: ResultStep = {
    ...identity,
    state: 'FAILED',
    exitCode: null,
    command: ['tool'],
    skipReason: 'not run',
  };
  // @ts-expect-error CANCELLED result steps never carry an exit code
  const cancelledWithExitCode: ResultStep = {
    ...identity,
    state: 'CANCELLED',
    exitCode: 1,
    command: ['tool'],
    skipReason: null,
  };
  // @ts-expect-error NOT_RUN result steps always retain their command
  const notRunWithoutCommand: ResultStep = {
    ...identity,
    state: 'NOT_RUN',
    exitCode: null,
    command: null,
    skipReason: null,
  };
  void valid;
  void running;
  void succeededWithOutput;
  void pendingWithoutCommand;
  void skippedWithCommand;
  void succeededWithoutExitCode;
  void failedWithSkipReason;
  void cancelledWithExitCode;
  void notRunWithoutCommand;
};

interface SchemaNode {
  readonly type?: string;
  readonly const?: unknown;
  readonly enum?: readonly unknown[];
  readonly minimum?: number;
  readonly pattern?: string;
  readonly properties?: Readonly<Record<string, SchemaNode>>;
  readonly items?: SchemaNode;
  readonly anyOf?: readonly SchemaNode[];
  readonly oneOf?: readonly SchemaNode[];
  readonly required?: readonly string[];
  readonly additionalProperties?: boolean;
}

function result(overrides: Partial<RunResult> = {}): RunResult {
  return {
    resultSchemaVersion: 1,
    id: RESULT_ID,
    status: 'succeeded',
    exitCode: 0,
    mode: 'non-interactive',
    dryRun: false,
    error: null,
    crossPlatformPreview: false,
    platform: 'linux',
    locale: 'en',
    startedAt: '2026-01-01T00:00:00.000Z',
    finishedAt: '2026-01-01T00:00:01.000Z',
    durationMs: 1000.5,
    runeVersion: '0.1.0',
    product: { name: 'Schema test', version: '1.0.0' },
    manifest: { path: '/project/installer.yaml', sha256: SHA256, schemaVersion: 1 },
    stepsTotal: 1,
    stepsExecuted: 1,
    stepsSucceeded: 1,
    stepsFailed: 0,
    stepsCancelled: 0,
    stepsSkipped: 0,
    stepsNotRun: 0,
    nothingExecuted: false,
    inputs: [
      { id: 'text', value: 'value', source: 'default', secret: false, enabled: true },
      { id: 'flag', value: true, source: 'values', secret: false, enabled: true },
      { id: 'many', value: ['a', 'b'], source: 'environment', secret: false, enabled: true },
      { id: 'secret', value: null, source: 'set', secret: true, enabled: true },
      {
        id: 'disabled',
        value: '',
        source: 'answer',
        secret: false,
        enabled: false,
        ignored: 'input disabled',
      },
    ],
    steps: [
      {
        id: 'successful-step',
        title: 'Successful step',
        state: 'SUCCEEDED',
        exitCode: 0,
        durationMs: 12.5,
        command: ['tool', '--secret=***'],
        skipReason: null,
      },
    ],
    ...overrides,
  } as RunResult;
}

function resultWithSingleStepState(state: ResultStep['state']): RunResult {
  const executed = state === 'SUCCEEDED' || state === 'FAILED' || state === 'CANCELLED';
  const outcome =
    state === 'PENDING'
      ? { status: 'planned' as const, exitCode: 0 as const, dryRun: true as const, error: null }
      : state === 'FAILED'
        ? { status: 'failed' as const, exitCode: 1 as const, dryRun: false as const, error: null }
        : state === 'CANCELLED' || state === 'NOT_RUN'
          ? {
              status: 'cancelled' as const,
              exitCode: 6 as const,
              dryRun: false as const,
              error: { code: 'RUNE-601' as const, message: 'cancelled', location: null },
            }
          : {
              status: 'succeeded' as const,
              exitCode: 0 as const,
              dryRun: false as const,
              error: null,
            };
  return result({
    ...outcome,
    stepsExecuted: executed ? 1 : 0,
    stepsSucceeded: state === 'SUCCEEDED' ? 1 : 0,
    stepsFailed: state === 'FAILED' ? 1 : 0,
    stepsCancelled: state === 'CANCELLED' ? 1 : 0,
    stepsSkipped: state === 'SKIPPED' ? 1 : 0,
    stepsNotRun: state === 'NOT_RUN' || state === 'PENDING' ? 1 : 0,
    nothingExecuted: !executed,
    steps: [resultStepForState(state)],
  } as Partial<RunResult>);
}

function resultStepForState(state: ResultStep['state']): ResultStep {
  const identity = { id: 'state-step', title: 'State step', durationMs: 0 } as const;
  switch (state) {
    case 'PENDING':
      return { ...identity, state, exitCode: null, command: ['tool'], skipReason: null };
    case 'SKIPPED':
      return { ...identity, state, exitCode: null, command: null, skipReason: 'condition false' };
    case 'SUCCEEDED':
      return { ...identity, state, exitCode: 0, command: ['tool'], skipReason: null };
    case 'FAILED':
      return { ...identity, state, exitCode: null, command: ['tool'], skipReason: null };
    case 'CANCELLED':
    case 'NOT_RUN':
      return { ...identity, state, exitCode: null, command: ['tool'], skipReason: null };
  }
}

function resultForStatus(status: RunResult['status']): RunResult {
  if (status === 'planned') {
    return resultWithSingleStepState('PENDING');
  }
  if (status === 'failed') {
    return resultWithSingleStepState('FAILED');
  }
  if (status === 'succeeded') {
    return result();
  }
  const error =
    status === 'config_error'
      ? { code: 'RUNE-103' as const, message: 'invalid manifest', location: null }
      : status === 'input_error'
        ? { code: 'RUNE-202' as const, message: 'invalid input', location: null }
        : status === 'resolution_error'
          ? { code: 'RUNE-301' as const, message: 'undefined variable', location: null }
          : status === 'cancelled'
            ? { code: 'RUNE-601' as const, message: 'cancelled', location: null }
            : { code: 'RUNE-500' as const, message: 'internal error', location: null };
  const overrides = {
    status,
    exitCode: EXIT_CODE_BY_STATUS[status],
    dryRun: false,
    error,
  } as Partial<RunResult>;
  return status === 'config_error' || status === 'input_error' || status === 'resolution_error'
    ? zeroStepResult(overrides)
    : result(overrides);
}

function zeroStepResult(overrides: Partial<RunResult> = {}): RunResult {
  return result({
    stepsTotal: 0,
    stepsExecuted: 0,
    stepsSucceeded: 0,
    stepsFailed: 0,
    stepsCancelled: 0,
    stepsSkipped: 0,
    stepsNotRun: 0,
    nothingExecuted: true,
    steps: [],
    ...overrides,
  });
}

function planFailure(dryRun: boolean, code: 'RUNE-401' | 'RUNE-404' | 'RUNE-405'): RunResult {
  return zeroStepResult({
    status: 'failed',
    exitCode: 1,
    dryRun,
    error: { code, message: 'planning failed', location: null },
  } as Partial<RunResult>);
}

describe('resultJsonSchema', () => {
  it('is the strict version-1 JSON Schema exported from the package root', () => {
    const schema = resultJsonSchema();
    const branches = schema['anyOf'] as readonly SchemaNode[];

    expect(schema['$schema']).toMatch(/json-schema\.org/);
    expect(branches).toHaveLength(RUN_STATUSES.length + 1);
    for (const branch of branches) {
      expect(branch.type).toBe('object');
      expect(branch.additionalProperties).toBe(false);
      expect(branch.properties?.['resultSchemaVersion']).toMatchObject({ const: 1 });
      expect(branch.required).toEqual(
        expect.arrayContaining(['status', 'exitCode', 'dryRun', 'error', 'mode', 'locale']),
      );
    }

    const branchesFor = (status: RunResult['status']): readonly SchemaNode[] =>
      branches.filter((branch) => branch.properties?.['status']?.const === status);
    expect(
      Object.fromEntries(RUN_STATUSES.map((status) => [status, branchesFor(status).length])),
    ).toEqual({
      succeeded: 1,
      planned: 1,
      failed: 2,
      config_error: 1,
      input_error: 1,
      resolution_error: 1,
      cancelled: 1,
      internal_error: 1,
    });

    const branchFor = (status: Exclude<RunResult['status'], 'failed'>): SchemaNode =>
      branchesFor(status)[0]!;
    expect(branchFor('succeeded').properties).toMatchObject({
      exitCode: { const: 0 },
      dryRun: { const: false },
      error: { type: 'null' },
    });
    expect(branchFor('planned').properties).toMatchObject({
      exitCode: { const: 0 },
      dryRun: { const: true },
      error: { type: 'null' },
    });
    const runtimeFailed = branchesFor('failed').find(
      (branch) => branch.properties?.['error']?.type === 'null',
    )!;
    const planFailed = branchesFor('failed').find(
      (branch) => branch.properties?.['error']?.type === 'object',
    )!;
    expect(runtimeFailed.properties).toMatchObject({
      exitCode: { const: 1 },
      dryRun: { const: false },
      error: { type: 'null' },
    });
    expect(planFailed.properties?.['error']?.properties?.['code']?.enum).toEqual([
      'RUNE-401',
      'RUNE-404',
      'RUNE-405',
    ]);
    expect(branchFor('config_error').properties?.['error']?.properties?.['code']?.enum).toEqual([
      'RUNE-101',
      'RUNE-102',
      'RUNE-103',
      'RUNE-104',
    ]);
    expect(branchFor('input_error').properties?.['error']?.properties?.['code']?.enum).toEqual([
      'RUNE-201',
      'RUNE-202',
      'RUNE-203',
    ]);
    expect(branchFor('resolution_error').properties?.['error']?.properties?.['code']?.enum).toEqual(
      ['RUNE-301', 'RUNE-302', 'RUNE-311', 'RUNE-312'],
    );
    expect(branchFor('cancelled').properties?.['error']?.properties?.['code']?.const).toBe(
      'RUNE-601',
    );
    expect(branchFor('internal_error').properties?.['error']?.properties?.['code']?.const).toBe(
      'RUNE-500',
    );

    for (const status of [
      'succeeded',
      'planned',
      'cancelled',
      'input_error',
      'resolution_error',
    ] as const) {
      expect(branchFor(status).properties?.['product']?.type).toBe('object');
      expect(branchFor(status).properties?.['manifest']?.properties).toMatchObject({
        sha256: { type: 'string', pattern: '^[0-9a-f]{64}$' },
        schemaVersion: { type: 'integer' },
      });
    }
    for (const failedBranch of branchesFor('failed')) {
      expect(failedBranch.properties?.['product']?.type).toBe('object');
      expect(failedBranch.properties?.['manifest']?.properties).toMatchObject({
        sha256: { type: 'string', pattern: '^[0-9a-f]{64}$' },
        schemaVersion: { type: 'integer' },
      });
    }
    for (const status of ['config_error', 'internal_error'] as const) {
      expect(branchFor(status).properties?.['product']?.anyOf?.map(({ type }) => type)).toEqual(
        expect.arrayContaining(['object', 'null']),
      );
      expect(
        branchFor(status).properties?.['manifest']?.properties?.['sha256']?.anyOf?.map(
          ({ type }) => type,
        ),
      ).toEqual(expect.arrayContaining(['string', 'null']));
      expect(
        branchFor(status).properties?.['manifest']?.properties?.['schemaVersion']?.anyOf?.map(
          ({ type }) => type,
        ),
      ).toEqual(expect.arrayContaining(['integer', 'null']));
    }
    for (const errorBranch of [
      planFailed,
      branchFor('config_error'),
      branchFor('input_error'),
      branchFor('resolution_error'),
      branchFor('cancelled'),
      branchFor('internal_error'),
    ]) {
      const errorSchema = errorBranch.properties?.['error'];
      expect(errorSchema).toMatchObject({
        type: 'object',
        additionalProperties: false,
        required: expect.arrayContaining(['code', 'message', 'location']),
      });
      const locationObject = errorSchema?.properties?.['location']?.anyOf?.find(
        (candidate) => candidate.type === 'object',
      );
      expect(locationObject).toMatchObject({
        additionalProperties: false,
        required: expect.arrayContaining(['file', 'line', 'column']),
        properties: {
          line: { type: 'integer', minimum: 1 },
          column: { type: 'integer', minimum: 1 },
        },
      });
    }

    expect(JSON.stringify(schema)).not.toContain('RUNNING');

    const stepBranches = branches[0]?.properties?.['steps']?.items?.oneOf;
    expect(stepBranches).toHaveLength(6);
    for (const stepBranch of stepBranches ?? []) {
      const state = stepBranch.properties?.['state']?.const;
      if (state === 'FAILED') {
        expect(stepBranch.properties).toHaveProperty('outputTail');
      } else {
        expect(stepBranch.properties).not.toHaveProperty('outputTail');
      }
    }

    const stepBranchByState = new Map(
      (stepBranches ?? []).map((branch) => [branch.properties?.['state']?.const, branch] as const),
    );
    expect(stepBranchByState.get('PENDING')?.properties).toMatchObject({
      command: { type: 'array' },
      skipReason: { type: 'null' },
      exitCode: { type: 'null' },
    });
    expect(stepBranchByState.get('SKIPPED')?.properties).toMatchObject({
      command: { type: 'null' },
      skipReason: { type: 'string' },
      exitCode: { type: 'null' },
    });
    expect(stepBranchByState.get('SUCCEEDED')?.properties).toMatchObject({
      command: { type: 'array' },
      skipReason: { type: 'null' },
      exitCode: { type: 'integer' },
    });
    for (const state of ['CANCELLED', 'NOT_RUN'] as const) {
      expect(stepBranchByState.get(state)?.properties).toMatchObject({
        command: { type: 'array' },
        skipReason: { type: 'null' },
        exitCode: { type: 'null' },
      });
    }
    expect(
      stepBranchByState
        .get('FAILED')
        ?.properties?.['exitCode']?.anyOf?.map((branch) => branch.type),
    ).toEqual(expect.arrayContaining(['integer', 'null']));
  });

  it('accepts representative succeeded, planned, failed, and cancelled result shapes', () => {
    const variants: readonly RunResult[] = [
      result(),
      result({
        status: 'planned',
        exitCode: 0,
        dryRun: true,
        durationMs: 0,
        stepsExecuted: 0,
        stepsSucceeded: 0,
        stepsNotRun: 1,
        nothingExecuted: true,
        steps: [
          {
            id: 'planned-step',
            title: 'Planned step',
            state: 'PENDING',
            exitCode: null,
            durationMs: 0,
            command: ['tool'],
            skipReason: null,
          },
        ],
      }),
      result({
        status: 'failed',
        exitCode: 1,
        stepsSucceeded: 0,
        stepsFailed: 1,
        steps: [
          {
            id: 'failed-step',
            title: 'Failed step',
            state: 'FAILED',
            exitCode: 1,
            durationMs: 12.5,
            command: ['tool'],
            skipReason: null,
            outputTail: [
              { stream: 'stdout', line: 'before failure' },
              { stream: 'stderr', line: 'failure' },
            ],
          },
        ],
      }),
      result({
        status: 'cancelled',
        exitCode: 6,
        error: { code: 'RUNE-601', message: 'cancelled', location: null },
        stepsSucceeded: 0,
        stepsCancelled: 1,
        steps: [
          {
            id: 'cancelled-step',
            title: 'Cancelled step',
            state: 'CANCELLED',
            exitCode: null,
            durationMs: 1,
            command: ['tool'],
            skipReason: null,
          },
        ],
      }),
    ];

    for (const variant of variants) {
      expect(resultV1Schema.safeParse(variant).success).toBe(true);
    }
  });

  it('accepts the correlated public fields for every result step state', () => {
    for (const state of [
      'PENDING',
      'SKIPPED',
      'SUCCEEDED',
      'FAILED',
      'CANCELLED',
      'NOT_RUN',
    ] as const) {
      expect(resultV1Schema.safeParse(resultWithSingleStepState(state)).success).toBe(true);
    }
  });

  it('rejects contradictory command, skip reason, and exit code classes for every state', () => {
    const contradictions = {
      PENDING: [{ command: null }, { skipReason: 'not run' }, { exitCode: 0 }],
      SKIPPED: [{ command: ['tool'] }, { skipReason: null }, { exitCode: 0 }],
      SUCCEEDED: [{ command: null }, { skipReason: 'not run' }, { exitCode: null }],
      FAILED: [{ command: null }, { skipReason: 'not run' }, { exitCode: 1.5 }],
      CANCELLED: [{ command: null }, { skipReason: 'not run' }, { exitCode: 0 }],
      NOT_RUN: [{ command: null }, { skipReason: 'not run' }, { exitCode: 0 }],
    } as const;

    for (const state of [
      'PENDING',
      'SKIPPED',
      'SUCCEEDED',
      'FAILED',
      'CANCELLED',
      'NOT_RUN',
    ] as const) {
      const base = resultWithSingleStepState(state);
      for (const contradictoryFields of contradictions[state]) {
        expect(
          resultV1Schema.safeParse({
            ...base,
            steps: [{ ...base.steps[0]!, ...contradictoryFields }],
          }).success,
        ).toBe(false);
      }
    }
  });

  it('accepts the JSON shape written by the result writer', () => {
    const serialized = JSON.parse(serializeResult(result())) as unknown;

    expect(resultV1Schema.safeParse(serialized).success).toBe(true);
  });

  it('enforces the secret discriminator and value correlation', () => {
    const base = result();
    const input = {
      id: 'input',
      source: 'set',
      enabled: true,
    } as const;

    for (const valid of [
      { ...input, secret: true, value: null },
      { ...input, secret: false, value: 'text' },
      { ...input, secret: false, value: true },
      { ...input, secret: false, value: ['one', 'two'] },
    ]) {
      expect(resultV1Schema.safeParse({ ...base, inputs: [valid] }).success).toBe(true);
    }

    for (const invalid of [
      { ...input, secret: true, value: 'plaintext' },
      { ...input, secret: false, value: null },
    ]) {
      expect(resultV1Schema.safeParse({ ...base, inputs: [invalid] }).success).toBe(false);
    }
  });

  it('enforces disabled-input provenance correlations', () => {
    const base = result();
    const input = { id: 'input', secret: false, value: '' } as const;

    for (const valid of [
      { ...input, enabled: true, source: null },
      ...VALUE_SOURCES.map((source) => ({ ...input, enabled: true, source })),
      { ...input, enabled: false, source: null },
      ...(['values', 'environment', 'set', 'answer'] as const).map((source) => ({
        ...input,
        enabled: false,
        source,
        ignored: 'input disabled' as const,
      })),
    ]) {
      expect(resultV1Schema.safeParse({ ...base, inputs: [valid] }).success).toBe(true);
    }

    for (const invalid of [
      { ...input, enabled: true, source: 'set', ignored: 'input disabled' },
      { ...input, enabled: false, source: 'set' },
      { ...input, enabled: false, source: null, ignored: 'input disabled' },
      { ...input, enabled: false, source: 'default', ignored: 'input disabled' },
    ]) {
      expect(resultV1Schema.safeParse({ ...base, inputs: [invalid] }).success).toBe(false);
    }
  });

  it('rejects duplicate input ids at the later id path', () => {
    const base = result();
    const parsed = resultV1Schema.safeParse(
      result({ inputs: [...base.inputs, { ...base.inputs[0]! }] }),
    );

    expect(parsed.success).toBe(false);
    if (!parsed.success) {
      expect(parsed.error.issues).toContainEqual(
        expect.objectContaining({ path: ['inputs', base.inputs.length, 'id'] }),
      );
    }
  });

  it('rejects duplicate step ids at the later id path', () => {
    const base = result();
    const parsed = resultV1Schema.safeParse(
      result({
        stepsTotal: 2,
        stepsExecuted: 2,
        stepsSucceeded: 2,
        steps: [...base.steps, { ...base.steps[0]! }],
      }),
    );

    expect(parsed.success).toBe(false);
    if (!parsed.success) {
      expect(parsed.error.issues).toContainEqual(
        expect.objectContaining({ path: ['steps', base.steps.length, 'id'] }),
      );
    }
  });

  it('allows an input id to match a step id', () => {
    const base = result();

    expect(
      resultV1Schema.safeParse(
        result({
          inputs: [{ ...base.inputs[0]!, id: base.steps[0]!.id }, ...base.inputs.slice(1)],
        }),
      ).success,
    ).toBe(true);
  });

  it('covers every public status, mode, platform, input source, and step state', () => {
    for (const status of RUN_STATUSES) {
      expect(resultV1Schema.safeParse(resultForStatus(status)).success).toBe(true);
    }

    for (const mode of RUN_MODES) {
      expect(resultV1Schema.safeParse(result({ mode })).success).toBe(true);
    }
    for (const platform of PLATFORMS) {
      expect(resultV1Schema.safeParse(result({ platform })).success).toBe(true);
    }
    for (const source of [...VALUE_SOURCES, null]) {
      expect(
        resultV1Schema.safeParse(
          result({
            inputs: [{ id: 'input', value: '', source, secret: false, enabled: true }],
          }),
        ).success,
      ).toBe(true);
    }
    for (const state of STEP_STATES) {
      if (state === 'RUNNING') {
        expect(
          resultV1Schema.safeParse({
            ...result(),
            steps: [{ ...result().steps[0]!, state }],
          }).success,
        ).toBe(false);
      } else {
        expect(resultV1Schema.safeParse(resultWithSingleStepState(state)).success).toBe(true);
      }
    }
  });

  it('rejects every wrong status/exit-code combination and the wrong exit-0 dry-run modes', () => {
    const exitCodes = [...new Set([...Object.values(EXIT_CODE_BY_STATUS), 2])];

    for (const status of RUN_STATUSES) {
      for (const exitCode of exitCodes) {
        if (exitCode !== EXIT_CODE_BY_STATUS[status]) {
          expect(
            resultV1Schema.safeParse({
              ...resultForStatus(status),
              exitCode,
            }).success,
          ).toBe(false);
        }
      }
    }

    for (const status of RUN_STATUSES.filter(
      (candidate) => candidate !== 'succeeded' && candidate !== 'planned',
    )) {
      expect(resultV1Schema.safeParse(resultForStatus(status)).success).toBe(true);
    }

    expect(
      resultV1Schema.safeParse({
        ...resultForStatus('failed'),
        dryRun: true,
      }).success,
    ).toBe(false);

    expect(
      resultV1Schema.safeParse({
        ...result(),
        status: 'succeeded',
        exitCode: 0,
        dryRun: true,
      }).success,
    ).toBe(false);
    expect(
      resultV1Schema.safeParse({
        ...result(),
        status: 'planned',
        exitCode: 0,
        dryRun: false,
      }).success,
    ).toBe(false);
  });

  it('requires cross-platform previews to be dry runs', () => {
    const contradictory = resultV1Schema.safeParse(
      result({ crossPlatformPreview: true, dryRun: false }),
    );

    expect(contradictory.success).toBe(false);
    if (!contradictory.success) {
      expect(contradictory.error.issues).toContainEqual(
        expect.objectContaining({ path: ['crossPlatformPreview'] }),
      );
    }
    expect(
      resultV1Schema.safeParse(
        result({
          status: 'config_error',
          exitCode: EXIT_CODE_BY_STATUS.config_error,
          dryRun: true,
          error: { code: 'RUNE-103', message: 'invalid manifest', location: null },
          crossPlatformPreview: false,
          stepsTotal: 0,
          stepsExecuted: 0,
          stepsSucceeded: 0,
          nothingExecuted: true,
          steps: [],
        }),
      ).success,
    ).toBe(true);
    expect(
      resultV1Schema.safeParse({
        ...resultWithSingleStepState('PENDING'),
        crossPlatformPreview: true,
      }).success,
    ).toBe(true);
  });

  it('correlates validated metadata with every post-validation status form', () => {
    const postValidationResults = [
      resultForStatus('succeeded'),
      resultForStatus('planned'),
      resultForStatus('failed'),
      planFailure(false, 'RUNE-401'),
      planFailure(true, 'RUNE-404'),
      resultForStatus('cancelled'),
      resultForStatus('input_error'),
      resultForStatus('resolution_error'),
    ];

    for (const postValidationResult of postValidationResults) {
      expect(resultV1Schema.safeParse(postValidationResult).success).toBe(true);
      for (const invalidMetadata of [
        { product: null },
        { manifest: { ...postValidationResult.manifest, sha256: null } },
        { manifest: { ...postValidationResult.manifest, sha256: 'A'.repeat(64) } },
        { manifest: { ...postValidationResult.manifest, sha256: 'a'.repeat(63) } },
        { manifest: { ...postValidationResult.manifest, schemaVersion: null } },
        { manifest: { ...postValidationResult.manifest, schemaVersion: 1.5 } },
      ]) {
        expect(
          resultV1Schema.safeParse({ ...postValidationResult, ...invalidMetadata }).success,
        ).toBe(false);
      }
    }
  });

  it('accepts nullable metadata only for config and internal errors', () => {
    for (const status of ['config_error', 'internal_error'] as const) {
      const base = {
        ...resultForStatus(status),
        product: null,
        manifest: { path: 'installer.yaml', sha256: null, schemaVersion: null },
      } as const;

      expect(resultV1Schema.safeParse(base).success).toBe(true);
      expect(
        resultV1Schema.safeParse({
          ...base,
          product: { name: 'Known product', version: '1.0.0' },
          manifest: { ...base.manifest, sha256: SHA256, schemaVersion: 1 },
        }).success,
      ).toBe(true);
    }
  });

  it('requires mode and locale and rejects unknown properties at every object level', () => {
    const { mode: _mode, ...withoutMode } = result();
    const { locale: _locale, ...withoutLocale } = result();

    expect(resultV1Schema.safeParse(withoutMode).success).toBe(false);
    expect(resultV1Schema.safeParse(withoutLocale).success).toBe(false);
    expect(resultV1Schema.safeParse({ ...result(), unknown: true }).success).toBe(false);
    expect(
      resultV1Schema.safeParse(
        result({
          manifest: {
            ...result().manifest,
            unknown: true,
          } as unknown as RunResult['manifest'],
        }),
      ).success,
    ).toBe(false);
    expect(
      resultV1Schema.safeParse(
        result({
          inputs: [
            { ...result().inputs[0]!, unknown: true } as unknown as RunResult['inputs'][number],
          ],
        }),
      ).success,
    ).toBe(false);
    expect(
      resultV1Schema.safeParse(
        result({
          steps: [
            { ...result().steps[0]!, unknown: true } as unknown as RunResult['steps'][number],
          ],
        }),
      ).success,
    ).toBe(false);
    expect(
      resultV1Schema.safeParse(
        result({
          steps: [
            {
              ...result().steps[0]!,
              outputTail: [
                {
                  stream: 'stdout',
                  line: 'line',
                  unknown: true,
                } as NonNullable<RunResult['steps'][number]['outputTail']>[number],
              ],
            } as unknown as RunResult['steps'][number],
          ],
        }),
      ).success,
    ).toBe(false);
  });

  it('enforces integers for counters and nonnegative durations and counters', () => {
    expect(resultV1Schema.safeParse(result({ stepsTotal: 1.5 })).success).toBe(false);
    expect(resultV1Schema.safeParse(result({ stepsExecuted: -1 })).success).toBe(false);
    expect(resultV1Schema.safeParse(result({ durationMs: -1 })).success).toBe(false);
    expect(
      resultV1Schema.safeParse(result({ steps: [{ ...result().steps[0]!, durationMs: -1 }] }))
        .success,
    ).toBe(false);
  });

  it('rejects counters that do not correspond to the actual step list', () => {
    const mismatches: readonly Partial<RunResult>[] = [
      { stepsTotal: 0 },
      { stepsExecuted: 0 },
      { stepsSucceeded: 0 },
      { stepsFailed: 1 },
      { stepsCancelled: 1 },
      { stepsSkipped: 1 },
      { stepsNotRun: 1 },
    ];

    for (const mismatch of mismatches) {
      expect(resultV1Schema.safeParse(result(mismatch)).success).toBe(false);
    }
  });

  it('rejects contradictory nothingExecuted values and more than one cancelled step', () => {
    expect(resultV1Schema.safeParse(result({ nothingExecuted: true })).success).toBe(false);
    expect(
      resultV1Schema.safeParse(
        result({
          stepsTotal: 0,
          stepsExecuted: 0,
          stepsSucceeded: 0,
          nothingExecuted: false,
          steps: [],
        }),
      ).success,
    ).toBe(false);

    const cancelled = resultWithSingleStepState('CANCELLED').steps[0]!;
    expect(
      resultV1Schema.safeParse(
        result({
          status: 'cancelled',
          exitCode: 6,
          error: { code: 'RUNE-601', message: 'cancelled', location: null },
          stepsTotal: 2,
          stepsExecuted: 2,
          stepsSucceeded: 0,
          stepsCancelled: 2,
          steps: [cancelled, { ...cancelled, id: 'second-cancelled-step' }],
        }),
      ).success,
    ).toBe(false);
  });

  it('correlates PENDING steps with planned results', () => {
    const pending = resultWithSingleStepState('PENDING');
    expect(
      resultV1Schema.safeParse({ ...pending, status: 'succeeded', dryRun: false }).success,
    ).toBe(false);
    expect(
      resultV1Schema.safeParse({
        ...result(),
        status: 'planned',
        dryRun: true,
      }).success,
    ).toBe(false);
  });

  it('accepts only succeeded or skipped steps for succeeded results', () => {
    for (const state of ['FAILED', 'CANCELLED', 'NOT_RUN'] as const) {
      expect(
        resultV1Schema.safeParse({
          ...resultWithSingleStepState(state),
          status: 'succeeded',
          exitCode: 0,
          dryRun: false,
        }).success,
      ).toBe(false);
    }

    expect(
      resultV1Schema.safeParse(
        result({
          stepsTotal: 0,
          stepsExecuted: 0,
          stepsSucceeded: 0,
          nothingExecuted: true,
          steps: [],
        }),
      ).success,
    ).toBe(true);
    expect(resultV1Schema.safeParse(resultWithSingleStepState('SKIPPED')).success).toBe(true);
  });

  it('requires a failed result to contain at least one failed step', () => {
    expect(
      resultV1Schema.safeParse({
        ...result(),
        status: 'failed',
        exitCode: 1,
      }).success,
    ).toBe(false);
  });

  it('accepts exactly the zero-step plan-time failed form for real and dry runs', () => {
    for (const dryRun of [false, true]) {
      for (const code of ['RUNE-401', 'RUNE-404', 'RUNE-405'] as const) {
        expect(resultV1Schema.safeParse(planFailure(dryRun, code)).success).toBe(true);
      }
    }

    const partialPlan = resultWithSingleStepState('PENDING');
    expect(
      resultV1Schema.safeParse({
        ...partialPlan,
        status: 'failed',
        exitCode: 1,
        error: { code: 'RUNE-401', message: 'planning failed', location: null },
      }).success,
    ).toBe(false);
    expect(
      resultV1Schema.safeParse({ ...planFailure(true, 'RUNE-404'), stepsExecuted: 1 }).success,
    ).toBe(false);
    expect(
      resultV1Schema.safeParse({ ...planFailure(false, 'RUNE-405'), nothingExecuted: false })
        .success,
    ).toBe(false);
  });

  it('rejects executed terminal states in every dry-run result', () => {
    for (const state of ['SUCCEEDED', 'FAILED', 'CANCELLED'] as const) {
      const base = resultWithSingleStepState(state);
      expect(
        resultV1Schema.safeParse({
          ...base,
          status: 'internal_error',
          exitCode: 70,
          dryRun: true,
          error: { code: 'RUNE-500', message: 'internal error', location: null },
        }).success,
      ).toBe(false);
    }
  });

  it('accepts cancellation dry runs with pending or skipped steps', () => {
    const pending = resultWithSingleStepState('PENDING');
    const skipped = resultWithSingleStepState('SKIPPED');
    const variants = [
      {
        ...pending,
        status: 'cancelled',
        exitCode: 6,
        error: { code: 'RUNE-601', message: 'cancelled', location: null },
      },
      {
        ...skipped,
        status: 'cancelled',
        exitCode: 6,
        dryRun: true,
        error: { code: 'RUNE-601', message: 'cancelled', location: null },
      },
    ];

    for (const variant of variants) {
      expect(resultV1Schema.safeParse(variant).success).toBe(true);
    }
  });

  it('requires a strict status-specific top-level error with a 1-based location', () => {
    const valid = resultForStatus('config_error');
    const { error: _error, ...withoutError } = valid;
    expect(resultV1Schema.safeParse(withoutError).success).toBe(false);

    for (const invalidError of [
      null,
      { code: 'RUNE-001', message: 'usage', location: null },
      { code: 'RUNE-002', message: 'platform', location: null },
      { code: 'RUNE-201', message: 'wrong status', location: null },
      {
        code: 'RUNE-103',
        message: 'located',
        location: { file: 'installer.yaml', line: 0, column: 1 },
      },
      {
        code: 'RUNE-103',
        message: 'located',
        location: { file: 'installer.yaml', line: 1, column: 0 },
      },
      {
        code: 'RUNE-103',
        message: 'located',
        location: { file: 'installer.yaml', line: 1, column: 1, unknown: true },
      },
      { code: 'RUNE-103', message: 'extra', location: null, issues: [] },
    ]) {
      expect(resultV1Schema.safeParse({ ...valid, error: invalidError }).success).toBe(false);
    }

    expect(
      resultV1Schema.safeParse({
        ...valid,
        error: {
          code: 'RUNE-104',
          message: 'located',
          location: { file: 'installer.yaml', line: 1, column: 1 },
        },
      }).success,
    ).toBe(true);
    for (const code of ['RUNE-402', 'RUNE-403', 'RUNE-500', 'RUNE-601'] as const) {
      expect(
        resultV1Schema.safeParse({
          ...planFailure(true, 'RUNE-401'),
          error: { code, message: 'wrong plan error', location: null },
        }).success,
      ).toBe(false);
    }
  });

  it('rejects a cancelled result that contains a failed step', () => {
    const failed = resultWithSingleStepState('FAILED').steps[0]!;
    const notRun = { ...resultWithSingleStepState('NOT_RUN').steps[0]!, id: 'not-run-step' };

    expect(
      resultV1Schema.safeParse(
        result({
          status: 'cancelled',
          exitCode: 6,
          error: { code: 'RUNE-601', message: 'cancelled', location: null },
          stepsTotal: 2,
          stepsExecuted: 1,
          stepsSucceeded: 0,
          stepsFailed: 1,
          stepsNotRun: 1,
          steps: [failed, notRun],
        }),
      ).success,
    ).toBe(false);
  });

  it('accepts a failed result with failed and later cancelled steps', () => {
    const failed = resultWithSingleStepState('FAILED').steps[0]!;
    const cancelled = {
      ...resultWithSingleStepState('CANCELLED').steps[0]!,
      id: 'cancelled-step',
    };

    expect(
      resultV1Schema.safeParse(
        result({
          status: 'failed',
          exitCode: 1,
          error: null,
          stepsTotal: 2,
          stepsExecuted: 2,
          stepsSucceeded: 0,
          stepsFailed: 1,
          stepsCancelled: 1,
          steps: [failed, cancelled],
        }),
      ).success,
    ).toBe(true);
  });

  it('rejects steps for pre-execution errors and allows them for internal errors', () => {
    const steps = [
      { ...resultWithSingleStepState('SUCCEEDED').steps[0]!, id: 'succeeded-step' },
      { ...resultWithSingleStepState('FAILED').steps[0]!, id: 'failed-step' },
      { ...resultWithSingleStepState('CANCELLED').steps[0]!, id: 'cancelled-step' },
      { ...resultWithSingleStepState('SKIPPED').steps[0]!, id: 'skipped-step' },
      { ...resultWithSingleStepState('NOT_RUN').steps[0]!, id: 'not-run-step' },
    ];
    const base = result({
      stepsTotal: 5,
      stepsExecuted: 3,
      stepsSucceeded: 1,
      stepsFailed: 1,
      stepsCancelled: 1,
      stepsSkipped: 1,
      stepsNotRun: 1,
      steps,
    });

    const pending = resultWithSingleStepState('PENDING');
    for (const status of ['config_error', 'input_error', 'resolution_error'] as const) {
      const statusResult = resultForStatus(status);
      expect(
        resultV1Schema.safeParse({
          ...base,
          status,
          exitCode: EXIT_CODE_BY_STATUS[status],
          error: statusResult.error,
        }).success,
      ).toBe(false);
      expect(
        resultV1Schema.safeParse({
          ...pending,
          status,
          exitCode: EXIT_CODE_BY_STATUS[status],
          error: statusResult.error,
        }).success,
      ).toBe(false);
    }

    const internalError = resultForStatus('internal_error');
    expect(
      resultV1Schema.safeParse({
        ...base,
        status: 'internal_error',
        exitCode: EXIT_CODE_BY_STATUS.internal_error,
        error: internalError.error,
      }).success,
    ).toBe(true);
  });

  it('rejects the formerly accepted RUNNING, non-failed tail, and impossible-counter shapes', () => {
    const base = result();
    const contradictions = [
      {
        ...base,
        steps: [{ ...base.steps[0]!, state: 'RUNNING' }],
      },
      {
        ...base,
        steps: [{ ...base.steps[0]!, outputTail: [] }],
      },
      {
        ...base,
        stepsTotal: 0,
        stepsExecuted: 99,
        nothingExecuted: true,
      },
    ];

    for (const contradiction of contradictions) {
      expect(resultV1Schema.safeParse(contradiction).success).toBe(false);
    }
    expect(resultV1Schema.safeParse(resultWithSingleStepState('FAILED')).success).toBe(true);
  });

  it('rejects outputTail on every non-failed state', () => {
    for (const state of ['PENDING', 'SKIPPED', 'SUCCEEDED', 'CANCELLED', 'NOT_RUN'] as const) {
      const base = resultWithSingleStepState(state);
      expect(
        resultV1Schema.safeParse({
          ...base,
          steps: [{ ...base.steps[0]!, outputTail: [] }],
        }).success,
      ).toBe(false);
    }
  });
});
