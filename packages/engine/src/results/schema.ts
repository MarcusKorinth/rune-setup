/** The public JSON Schema contract of a result file (docs/architecture.md §10). */

import { z } from 'zod';

import { PLATFORMS } from '../engine/context.js';
import { VALUE_SOURCES } from '../engine/inputs.js';
import { EXIT_CODE_BY_STATUS, RESULT_SCHEMA_VERSION, RUN_MODES, type RunResult } from './model.js';

const nonnegativeInteger = z.number().int().nonnegative();

const resultInputIdentity = {
  id: z.string(),
};

const resultInputValueSchemas = [
  z.strictObject({
    ...resultInputIdentity,
    source: z.enum(VALUE_SOURCES).nullable(),
    enabled: z.literal(true),
    secret: z.literal(true),
    value: z.null(),
  }),
  z.strictObject({
    ...resultInputIdentity,
    source: z.enum(VALUE_SOURCES).nullable(),
    enabled: z.literal(true),
    secret: z.literal(false),
    value: z.union([z.string(), z.boolean(), z.array(z.string())]),
  }),
  z.strictObject({
    ...resultInputIdentity,
    source: z.null(),
    enabled: z.literal(false),
    secret: z.literal(true),
    value: z.null(),
  }),
  z.strictObject({
    ...resultInputIdentity,
    source: z.null(),
    enabled: z.literal(false),
    secret: z.literal(false),
    value: z.union([z.string(), z.boolean(), z.array(z.string())]),
  }),
  z.strictObject({
    ...resultInputIdentity,
    source: z.enum(['values', 'environment', 'set', 'answer']),
    enabled: z.literal(false),
    ignored: z.literal('input disabled'),
    secret: z.literal(true),
    value: z.null(),
  }),
  z.strictObject({
    ...resultInputIdentity,
    source: z.enum(['values', 'environment', 'set', 'answer']),
    enabled: z.literal(false),
    ignored: z.literal('input disabled'),
    secret: z.literal(false),
    value: z.union([z.string(), z.boolean(), z.array(z.string())]),
  }),
] as const;

const resultInputSchema = z.union(resultInputValueSchemas);

const resultOutputLineSchema = z.strictObject({
  stream: z.enum(['stdout', 'stderr']),
  line: z.string(),
});

const resultStepIdentity = {
  id: z.string(),
  title: z.string(),
  durationMs: z.number().nonnegative(),
};

const resultStepSchema = z.discriminatedUnion('state', [
  z.strictObject({
    ...resultStepIdentity,
    state: z.literal('PENDING'),
    exitCode: z.null(),
    command: z.array(z.string()),
    skipReason: z.null(),
  }),
  z.strictObject({
    ...resultStepIdentity,
    state: z.literal('SKIPPED'),
    exitCode: z.null(),
    command: z.null(),
    skipReason: z.string(),
  }),
  z.strictObject({
    ...resultStepIdentity,
    state: z.literal('SUCCEEDED'),
    exitCode: z.number().int(),
    command: z.array(z.string()),
    skipReason: z.null(),
  }),
  z.strictObject({
    ...resultStepIdentity,
    state: z.literal('FAILED'),
    exitCode: z.number().int().nullable(),
    command: z.array(z.string()),
    skipReason: z.null(),
    outputTail: z.array(resultOutputLineSchema).max(50).optional(),
  }),
  z.strictObject({
    ...resultStepIdentity,
    state: z.literal('CANCELLED'),
    exitCode: z.null(),
    command: z.array(z.string()),
    skipReason: z.null(),
  }),
  z.strictObject({
    ...resultStepIdentity,
    state: z.literal('NOT_RUN'),
    exitCode: z.null(),
    command: z.array(z.string()),
    skipReason: z.null(),
  }),
]);

const resultManifestSchema = z.strictObject({
  path: z.string(),
  sha256: z
    .string()
    .regex(/^[0-9a-f]{64}$/)
    .nullable(),
  schemaVersion: z.number().int().nullable(),
});

const resultProductSchema = z.strictObject({
  name: z.string(),
  version: z.string(),
});

/**
 * Shape source for `resultSchemaVersion: 1`. It is deliberately separate from the readonly
 * facade types in model.ts: readonly has no JSON representation. The compile-time checks below
 * pin the two structural views in both directions.
 */
const resultShape = {
  resultSchemaVersion: z.literal(RESULT_SCHEMA_VERSION),
  id: z.uuid(),
  mode: z.enum(RUN_MODES),
  crossPlatformPreview: z.boolean(),
  platform: z.enum(PLATFORMS),
  locale: z.string(),
  startedAt: z.iso.datetime(),
  finishedAt: z.iso.datetime(),
  durationMs: z.number().nonnegative(),
  runeVersion: z.string(),
  product: resultProductSchema.nullable(),
  manifest: resultManifestSchema,
  stepsTotal: nonnegativeInteger,
  stepsExecuted: nonnegativeInteger,
  stepsSucceeded: nonnegativeInteger,
  stepsFailed: nonnegativeInteger,
  stepsCancelled: nonnegativeInteger,
  stepsSkipped: nonnegativeInteger,
  stepsNotRun: nonnegativeInteger,
  nothingExecuted: z.boolean(),
  inputs: z.array(resultInputSchema),
  steps: z.array(resultStepSchema),
};

const resultV1ShapeSchema = z.discriminatedUnion('status', [
  z.strictObject({
    ...resultShape,
    status: z.literal('succeeded'),
    exitCode: z.literal(EXIT_CODE_BY_STATUS.succeeded),
    dryRun: z.literal(false),
  }),
  z.strictObject({
    ...resultShape,
    status: z.literal('planned'),
    exitCode: z.literal(EXIT_CODE_BY_STATUS.planned),
    dryRun: z.literal(true),
  }),
  z.strictObject({
    ...resultShape,
    status: z.literal('failed'),
    exitCode: z.literal(EXIT_CODE_BY_STATUS.failed),
    dryRun: z.boolean(),
  }),
  z.strictObject({
    ...resultShape,
    status: z.literal('cancelled'),
    exitCode: z.literal(EXIT_CODE_BY_STATUS.cancelled),
    dryRun: z.boolean(),
  }),
  z.strictObject({
    ...resultShape,
    status: z.literal('config_error'),
    exitCode: z.literal(EXIT_CODE_BY_STATUS.config_error),
    dryRun: z.boolean(),
  }),
  z.strictObject({
    ...resultShape,
    status: z.literal('input_error'),
    exitCode: z.literal(EXIT_CODE_BY_STATUS.input_error),
    dryRun: z.boolean(),
  }),
  z.strictObject({
    ...resultShape,
    status: z.literal('resolution_error'),
    exitCode: z.literal(EXIT_CODE_BY_STATUS.resolution_error),
    dryRun: z.boolean(),
  }),
  z.strictObject({
    ...resultShape,
    status: z.literal('internal_error'),
    exitCode: z.literal(EXIT_CODE_BY_STATUS.internal_error),
    dryRun: z.boolean(),
  }),
]);

export const resultV1Schema = resultV1ShapeSchema.superRefine((result, context) => {
  if (result.crossPlatformPreview && !result.dryRun) {
    context.addIssue({
      code: 'custom',
      path: ['crossPlatformPreview'],
      message: 'crossPlatformPreview requires dryRun',
    });
  }

  const inputIds = new Set<string>();
  for (const [index, input] of result.inputs.entries()) {
    if (inputIds.has(input.id)) {
      context.addIssue({
        code: 'custom',
        path: ['inputs', index, 'id'],
        message: 'input ids must be unique',
      });
    }
    inputIds.add(input.id);
  }

  const stepIds = new Set<string>();
  for (const [index, step] of result.steps.entries()) {
    if (stepIds.has(step.id)) {
      context.addIssue({
        code: 'custom',
        path: ['steps', index, 'id'],
        message: 'step ids must be unique',
      });
    }
    stepIds.add(step.id);
  }

  const count = (state: RunResult['steps'][number]['state']): number =>
    result.steps.filter((step) => step.state === state).length;
  const expectedCounters = {
    stepsTotal: result.steps.length,
    stepsSucceeded: count('SUCCEEDED'),
    stepsFailed: count('FAILED'),
    stepsCancelled: count('CANCELLED'),
    stepsSkipped: count('SKIPPED'),
    stepsNotRun: count('NOT_RUN') + count('PENDING'),
  } as const;
  const stepsExecuted =
    expectedCounters.stepsSucceeded +
    expectedCounters.stepsFailed +
    expectedCounters.stepsCancelled;

  for (const [counter, expected] of Object.entries(expectedCounters)) {
    if (result[counter as keyof typeof expectedCounters] !== expected) {
      context.addIssue({
        code: 'custom',
        path: [counter],
        message: `${counter} does not match the result steps`,
      });
    }
  }
  if (result.stepsExecuted !== stepsExecuted) {
    context.addIssue({
      code: 'custom',
      path: ['stepsExecuted'],
      message: 'stepsExecuted does not match the result steps',
    });
  }
  if (result.nothingExecuted !== (stepsExecuted === 0)) {
    context.addIssue({
      code: 'custom',
      path: ['nothingExecuted'],
      message: 'nothingExecuted does not match stepsExecuted',
    });
  }
  if (expectedCounters.stepsCancelled > 1) {
    context.addIssue({
      code: 'custom',
      path: ['stepsCancelled'],
      message: 'stepsCancelled must not exceed one',
    });
  }

  const invalidStateIndex = result.steps.findIndex((step) => {
    if (result.status === 'planned') {
      return step.state !== 'PENDING' && step.state !== 'SKIPPED';
    }
    if (result.status === 'succeeded') {
      return step.state !== 'SUCCEEDED' && step.state !== 'SKIPPED';
    }
    return step.state === 'PENDING';
  });
  if (invalidStateIndex !== -1) {
    context.addIssue({
      code: 'custom',
      path: ['steps', invalidStateIndex, 'state'],
      message:
        result.status === 'planned'
          ? 'planned results may contain only PENDING or SKIPPED steps'
          : result.status === 'succeeded'
            ? 'succeeded results may contain only SUCCEEDED or SKIPPED steps'
            : 'PENDING steps are permitted only in planned results',
    });
  }

  if (result.status === 'failed' && expectedCounters.stepsFailed === 0) {
    context.addIssue({
      code: 'custom',
      path: ['status'],
      message: 'failed results must contain at least one FAILED step',
    });
  }
});

type Mutable<T> = T extends readonly (infer Item)[]
  ? Mutable<Item>[]
  : T extends object
    ? {
        -readonly [Key in keyof T]:
          Mutable<T[Key]> | (Record<never, never> extends Pick<T, Key> ? undefined : never);
      }
    : T;
type Assert<Condition extends true> = Condition;
type _SchemaMatchesModel = Assert<
  z.output<typeof resultV1Schema> extends Mutable<RunResult> ? true : false
>;
type _ModelMatchesSchema = Assert<
  Mutable<RunResult> extends z.output<typeof resultV1Schema> ? true : false
>;

/** The JSON Schema emitted by `rune schema --result`. */
export function resultJsonSchema(): Record<string, unknown> {
  return z.toJSONSchema(resultV1Schema, { io: 'output' }) as Record<string, unknown>;
}
