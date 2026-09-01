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

const potentiallyUnvalidatedResultManifestSchema = z.strictObject({
  path: z.string(),
  sha256: z
    .string()
    .regex(/^[0-9a-f]{64}$/)
    .nullable(),
  schemaVersion: z.number().int().nullable(),
});

const validatedResultManifestSchema = z.strictObject({
  path: z.string(),
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
  schemaVersion: z.number().int(),
});

const resultProductSchema = z.strictObject({
  name: z.string(),
  version: z.string(),
});

const resultLocationSchema = z.strictObject({
  file: z.string(),
  line: z.number().int().min(1),
  column: z.number().int().min(1),
});

const resultErrorSchema = <Code extends string>(code: z.ZodType<Code>) =>
  z.strictObject({
    code,
    message: z.string(),
    location: resultLocationSchema.nullable(),
  });

const planResultErrorSchema = resultErrorSchema(z.enum(['RUNE-401', 'RUNE-404', 'RUNE-405']));
const logResultErrorSchema = resultErrorSchema(z.literal('RUNE-406'));
const manifestResultErrorSchema = resultErrorSchema(
  z.enum(['RUNE-101', 'RUNE-102', 'RUNE-103', 'RUNE-104']),
);
const inputResultErrorSchema = resultErrorSchema(z.enum(['RUNE-201', 'RUNE-202', 'RUNE-203']));
const resolutionResultErrorSchema = resultErrorSchema(
  z.enum(['RUNE-301', 'RUNE-302', 'RUNE-311', 'RUNE-312']),
);

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
  locale: z.string().nullable(),
  startedAt: z.iso.datetime(),
  finishedAt: z.iso.datetime(),
  durationMs: z.number().nonnegative(),
  runeVersion: z.string(),
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

const validatedResultShape = {
  ...resultShape,
  product: resultProductSchema,
  manifest: validatedResultManifestSchema,
};

const potentiallyUnvalidatedResultShape = {
  ...resultShape,
  product: resultProductSchema.nullable(),
  manifest: potentiallyUnvalidatedResultManifestSchema,
};

const resultV1ShapeSchema = z.union([
  z.strictObject({
    ...validatedResultShape,
    status: z.literal('succeeded'),
    exitCode: z.literal(EXIT_CODE_BY_STATUS.succeeded),
    dryRun: z.literal(false),
    error: z.null(),
  }),
  z.strictObject({
    ...validatedResultShape,
    status: z.literal('planned'),
    exitCode: z.literal(EXIT_CODE_BY_STATUS.planned),
    dryRun: z.literal(true),
    error: z.null(),
  }),
  z.strictObject({
    ...validatedResultShape,
    status: z.literal('failed'),
    exitCode: z.literal(EXIT_CODE_BY_STATUS.failed),
    dryRun: z.literal(false),
    error: z.null(),
  }),
  z.strictObject({
    ...validatedResultShape,
    status: z.literal('failed'),
    exitCode: z.literal(EXIT_CODE_BY_STATUS.failed),
    dryRun: z.boolean(),
    error: planResultErrorSchema,
  }),
  z.strictObject({
    ...validatedResultShape,
    status: z.literal('failed'),
    exitCode: z.literal(EXIT_CODE_BY_STATUS.failed),
    dryRun: z.literal(false),
    error: logResultErrorSchema,
  }),
  z.strictObject({
    ...validatedResultShape,
    status: z.literal('cancelled'),
    exitCode: z.literal(EXIT_CODE_BY_STATUS.cancelled),
    dryRun: z.boolean(),
    error: resultErrorSchema(z.literal('RUNE-601')),
  }),
  z.strictObject({
    ...potentiallyUnvalidatedResultShape,
    status: z.literal('config_error'),
    exitCode: z.literal(EXIT_CODE_BY_STATUS.config_error),
    dryRun: z.boolean(),
    error: manifestResultErrorSchema,
  }),
  z.strictObject({
    ...validatedResultShape,
    status: z.literal('input_error'),
    exitCode: z.literal(EXIT_CODE_BY_STATUS.input_error),
    dryRun: z.boolean(),
    error: inputResultErrorSchema,
  }),
  z.strictObject({
    ...validatedResultShape,
    status: z.literal('resolution_error'),
    exitCode: z.literal(EXIT_CODE_BY_STATUS.resolution_error),
    dryRun: z.boolean(),
    error: resolutionResultErrorSchema,
  }),
  z.strictObject({
    ...potentiallyUnvalidatedResultShape,
    status: z.literal('internal_error'),
    exitCode: z.literal(EXIT_CODE_BY_STATUS.internal_error),
    dryRun: z.boolean(),
    error: resultErrorSchema(z.literal('RUNE-500')),
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

  let executionBlocked = false;
  for (const [index, step] of result.steps.entries()) {
    if (
      executionBlocked &&
      (step.state === 'SUCCEEDED' || step.state === 'FAILED' || step.state === 'CANCELLED')
    ) {
      context.addIssue({
        code: 'custom',
        path: ['steps', index, 'state'],
        message: 'executed steps must not follow a CANCELLED or NOT_RUN step',
      });
    }
    if (step.state === 'CANCELLED' || step.state === 'NOT_RUN') {
      executionBlocked = true;
    }
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
  if (result.status === 'cancelled' && expectedCounters.stepsFailed > 0) {
    context.addIssue({
      code: 'custom',
      path: ['status'],
      message: 'cancelled results must not contain FAILED steps',
    });
  }
  if (
    result.status === 'cancelled' &&
    result.stepsExecuted > 0 &&
    !result.steps.some((step) => step.state === 'CANCELLED' || step.state === 'NOT_RUN')
  ) {
    context.addIssue({
      code: 'custom',
      path: ['status'],
      message: 'executed cancelled results must contain a CANCELLED or NOT_RUN step',
    });
  }

  if (
    (result.status === 'config_error' ||
      result.status === 'input_error' ||
      result.status === 'resolution_error') &&
    result.steps.length !== 0
  ) {
    context.addIssue({
      code: 'custom',
      path: ['steps'],
      message: 'pre-execution error results must not contain steps',
    });
  }

  const invalidStateIndex = result.steps.findIndex((step) => {
    if (result.status === 'planned') {
      return step.state !== 'PENDING' && step.state !== 'SKIPPED';
    }
    if (result.status === 'succeeded') {
      return step.state !== 'SUCCEEDED' && step.state !== 'SKIPPED';
    }
    if (result.dryRun) {
      return step.state !== 'PENDING' && step.state !== 'SKIPPED';
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
            : result.dryRun
              ? 'dry-run results may contain only PENDING or SKIPPED steps'
              : 'PENDING steps are permitted only in dry-run results',
    });
  }

  if (result.status === 'failed') {
    if (result.error === null) {
      if (result.dryRun || expectedCounters.stepsFailed === 0) {
        context.addIssue({
          code: 'custom',
          path: ['status'],
          message: 'runtime failed results require a FAILED step and dryRun false',
        });
      }
    } else if (result.error.code !== 'RUNE-406' && result.steps.length !== 0) {
      context.addIssue({
        code: 'custom',
        path: ['steps'],
        message: 'plan-time failed results must not contain steps',
      });
    }
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
