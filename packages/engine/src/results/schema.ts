/** The public JSON Schema contract of a result file (docs/architecture.md §10). */

import { z } from 'zod';

import { PLATFORMS } from '../engine/context.js';
import { VALUE_SOURCES } from '../engine/inputs.js';
import { STEP_STATES } from '../engine/state.js';
import { EXIT_CODE_BY_STATUS, RESULT_SCHEMA_VERSION, RUN_MODES, type RunResult } from './model.js';

const nonnegativeInteger = z.number().int().nonnegative();

const resultInputShape = {
  id: z.string(),
  source: z.enum(VALUE_SOURCES).nullable(),
  enabled: z.boolean(),
  ignored: z.literal('input disabled').optional(),
};

const resultInputSchema = z.discriminatedUnion('secret', [
  z.strictObject({
    ...resultInputShape,
    secret: z.literal(true),
    value: z.null(),
  }),
  z.strictObject({
    ...resultInputShape,
    secret: z.literal(false),
    value: z.union([z.string(), z.boolean(), z.array(z.string())]),
  }),
]);

const resultOutputLineSchema = z.strictObject({
  stream: z.enum(['stdout', 'stderr']),
  line: z.string(),
});

const resultStepSchema = z.strictObject({
  id: z.string(),
  title: z.string(),
  state: z.enum(STEP_STATES),
  exitCode: z.number().int().nullable(),
  durationMs: z.number().nonnegative(),
  command: z.array(z.string()).nullable(),
  skipReason: z.string().nullable(),
  outputTail: z.array(resultOutputLineSchema).max(50).optional(),
});

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

export const resultV1Schema = z.discriminatedUnion('status', [
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
