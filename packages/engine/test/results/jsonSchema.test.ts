import { describe, expect, it } from 'vitest';

import { PLATFORMS } from '../../src/engine/context.js';
import { VALUE_SOURCES } from '../../src/engine/inputs.js';
import { STEP_STATES } from '../../src/engine/state.js';
import { resultJsonSchema } from '../../src/index.js';
import {
  EXIT_CODE_BY_STATUS,
  RUN_MODES,
  RUN_STATUSES,
  type RunResult,
} from '../../src/results/model.js';
import { resultV1Schema } from '../../src/results/schema.js';
import { serializeResult } from '../../src/results/writer.js';

const RESULT_ID = '123e4567-e89b-42d3-a456-426614174000';
const SHA256 = 'a'.repeat(64);

interface SchemaNode {
  readonly type?: string;
  readonly const?: unknown;
  readonly properties?: Readonly<Record<string, SchemaNode>>;
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

  it('covers every public status, mode, platform, input source, and step state', () => {
    for (const status of RUN_STATUSES) {
      const dryRun = status === 'planned';
      expect(
        resultV1Schema.safeParse({
          ...result(),
          status,
          exitCode: EXIT_CODE_BY_STATUS[status],
          dryRun,
        }).success,
      ).toBe(true);
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
      expect(
        resultV1Schema.safeParse(result({ steps: [{ ...result().steps[0]!, state }] })).success,
      ).toBe(true);
    }
  });

  it('rejects every wrong status/exit-code combination and the wrong exit-0 dry-run modes', () => {
    const exitCodes = [...new Set([...Object.values(EXIT_CODE_BY_STATUS), 2])];

    for (const status of RUN_STATUSES) {
      for (const exitCode of exitCodes) {
        if (exitCode !== EXIT_CODE_BY_STATUS[status]) {
          expect(
            resultV1Schema.safeParse({
              ...result(),
              status,
              exitCode,
              dryRun: status === 'planned',
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
            ...result(),
            status,
            exitCode: EXIT_CODE_BY_STATUS[status],
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
          inputs: [{ ...result().inputs[0]!, unknown: true } as RunResult['inputs'][number]],
        }),
      ).success,
    ).toBe(false);
    expect(
      resultV1Schema.safeParse(
        result({
          steps: [{ ...result().steps[0]!, unknown: true } as RunResult['steps'][number]],
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
            },
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
});
