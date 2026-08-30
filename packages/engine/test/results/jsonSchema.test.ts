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
  // @ts-expect-error secret result inputs must never contain plaintext
  const plaintextSecret: ResultInput = { ...secret, value: 'plaintext' };
  // @ts-expect-error non-secret result inputs must always contain a value
  const nullNonSecret: ResultInput = { ...nonSecret, value: null };
  void plaintextSecret;
  void nullNonSecret;
};

const _checkResultStepCorrelation = (): void => {
  const body = {
    id: 'step',
    title: 'Step',
    exitCode: null,
    durationMs: 0,
    command: null,
    skipReason: null,
  } as const;
  const valid: readonly ResultStep[] = [
    { ...body, state: 'PENDING' },
    { ...body, state: 'SKIPPED' },
    { ...body, state: 'SUCCEEDED' },
    { ...body, state: 'FAILED' },
    { ...body, state: 'FAILED', outputTail: [{ stream: 'stderr', line: 'failure' }] },
    { ...body, state: 'CANCELLED' },
    { ...body, state: 'NOT_RUN' },
  ];
  // @ts-expect-error RUNNING is an internal lifecycle state, never a result step state
  const running: ResultStep = { ...body, state: 'RUNNING' };
  // @ts-expect-error outputTail is exclusive to FAILED result steps
  const succeededWithOutput: ResultStep = { ...body, state: 'SUCCEEDED', outputTail: [] };
  void valid;
  void running;
  void succeededWithOutput;
};

interface SchemaNode {
  readonly type?: string;
  readonly const?: unknown;
  readonly properties?: Readonly<Record<string, SchemaNode>>;
  readonly items?: SchemaNode;
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
      ? { status: 'planned' as const, exitCode: 0 as const, dryRun: true as const }
      : state === 'FAILED'
        ? { status: 'failed' as const, exitCode: 1 as const, dryRun: false as const }
        : state === 'CANCELLED' || state === 'NOT_RUN'
          ? { status: 'cancelled' as const, exitCode: 6 as const, dryRun: false as const }
          : { status: 'succeeded' as const, exitCode: 0 as const, dryRun: false as const };
  return result({
    ...outcome,
    stepsExecuted: executed ? 1 : 0,
    stepsSucceeded: state === 'SUCCEEDED' ? 1 : 0,
    stepsFailed: state === 'FAILED' ? 1 : 0,
    stepsCancelled: state === 'CANCELLED' ? 1 : 0,
    stepsSkipped: state === 'SKIPPED' ? 1 : 0,
    stepsNotRun: state === 'NOT_RUN' || state === 'PENDING' ? 1 : 0,
    nothingExecuted: !executed,
    steps: [
      {
        id: 'state-step',
        title: 'State step',
        state,
        exitCode: null,
        durationMs: 0,
        command: null,
        skipReason: state === 'SKIPPED' ? 'condition false' : null,
      } as ResultStep,
    ],
  } as Partial<RunResult>);
}

function resultForStatus(status: RunResult['status']): RunResult {
  if (status === 'planned') {
    return resultWithSingleStepState('PENDING');
  }
  if (status === 'failed') {
    return resultWithSingleStepState('FAILED');
  }
  return result({
    status,
    exitCode: EXIT_CODE_BY_STATUS[status],
    dryRun: false,
  } as Partial<RunResult>);
}

describe('resultJsonSchema', () => {
  it('is the strict version-1 JSON Schema exported from the package root', () => {
    const schema = resultJsonSchema();
    const branches = schema['oneOf'] as readonly SchemaNode[];

    expect(schema['$schema']).toMatch(/json-schema\.org/);
    expect(branches).toHaveLength(RUN_STATUSES.length);
    for (const branch of branches) {
      expect(branch.type).toBe('object');
      expect(branch.additionalProperties).toBe(false);
      expect(branch.properties?.['resultSchemaVersion']).toMatchObject({ const: 1 });
      expect(branch.required).toEqual(
        expect.arrayContaining(['status', 'exitCode', 'dryRun', 'mode', 'locale']),
      );
    }

    expect(
      Object.fromEntries(
        branches.map((branch) => [
          branch.properties?.['status']?.const,
          {
            exitCode: branch.properties?.['exitCode']?.const,
            dryRun: branch.properties?.['dryRun']?.const,
          },
        ]),
      ),
    ).toEqual({
      succeeded: { exitCode: 0, dryRun: false },
      planned: { exitCode: 0, dryRun: true },
      failed: { exitCode: 1, dryRun: undefined },
      config_error: { exitCode: 3, dryRun: undefined },
      input_error: { exitCode: 4, dryRun: undefined },
      resolution_error: { exitCode: 5, dryRun: undefined },
      cancelled: { exitCode: 6, dryRun: undefined },
      internal_error: { exitCode: 70, dryRun: undefined },
    });

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
      for (const dryRun of [false, true]) {
        expect(
          resultV1Schema.safeParse({
            ...resultForStatus(status),
            dryRun,
          }).success,
        ).toBe(true);
      }
    }

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

  it('accepts nullable pre-validation metadata', () => {
    expect(
      resultV1Schema.safeParse(
        result({
          product: null,
          manifest: { path: 'installer.yaml', sha256: null, schemaVersion: null },
          stepsTotal: 0,
          stepsExecuted: 0,
          stepsSucceeded: 0,
          nothingExecuted: true,
          inputs: [],
          steps: [],
        }),
      ).success,
    ).toBe(true);
  });

  it('requires mode and locale and rejects unknown properties at every object level', () => {
    const { mode: _mode, ...withoutMode } = result();
    const { locale: _locale, ...withoutLocale } = result();

    expect(resultV1Schema.safeParse(withoutMode).success).toBe(false);
    expect(resultV1Schema.safeParse(withoutLocale).success).toBe(false);
    expect(resultV1Schema.safeParse({ ...result(), unknown: true }).success).toBe(false);
    expect(
      resultV1Schema.safeParse(
        result({ manifest: { ...result().manifest, unknown: true } as RunResult['manifest'] }),
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

  it('allows a cancelled result to retain an earlier failure and a not-run step', () => {
    const failed = resultWithSingleStepState('FAILED').steps[0]!;
    const notRun = resultWithSingleStepState('NOT_RUN').steps[0]!;

    expect(
      resultV1Schema.safeParse(
        result({
          status: 'cancelled',
          exitCode: 6,
          stepsTotal: 2,
          stepsExecuted: 1,
          stepsSucceeded: 0,
          stepsFailed: 1,
          stepsNotRun: 1,
          steps: [failed, notRun],
        }),
      ).success,
    ).toBe(true);
  });

  it('allows terminal step states on session error results', () => {
    const steps = [
      resultWithSingleStepState('SUCCEEDED').steps[0]!,
      resultWithSingleStepState('FAILED').steps[0]!,
      resultWithSingleStepState('CANCELLED').steps[0]!,
      resultWithSingleStepState('SKIPPED').steps[0]!,
      resultWithSingleStepState('NOT_RUN').steps[0]!,
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

    for (const status of [
      'config_error',
      'input_error',
      'resolution_error',
      'internal_error',
    ] as const) {
      expect(
        resultV1Schema.safeParse({
          ...base,
          status,
          exitCode: EXIT_CODE_BY_STATUS[status],
        }).success,
      ).toBe(true);
    }
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
