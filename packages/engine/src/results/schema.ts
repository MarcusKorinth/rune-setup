/**
 * The JSON Schema of the result file (`rune schema --result`, docs/architecture.md §4.1).
 *
 * A zod mirror of the model in `model.ts`, so the schema is generated the same way the
 * manifest schema is and cannot drift silently: the mirror is pinned against the model by
 * type assignability below and by tests that validate results from the real producers.
 */

import { z } from 'zod';

import { VALUE_SOURCES } from '../engine/inputs.js';
import type { RunResult } from './model.js';

const nonNegativeIntegerSchema = z.number().int().min(0);
const nonNegativeDurationSchema = z.number().int().min(0);
const commandSchema = z.array(z.string()).min(1);

const outputLineSchema = z.strictObject({
  stream: z.enum(['stdout', 'stderr']),
  line: z.string(),
});

const resultInputSchema = z
  .strictObject({
    id: z.string(),
    value: z.union([z.string(), z.boolean(), z.array(z.string()), z.null()]),
    source: z.union([z.enum(VALUE_SOURCES), z.null()]),
    secret: z.boolean(),
    enabled: z.boolean(),
    ignored: z.union([z.string(), z.null()]),
  })
  .superRefine((input, context) => {
    if (input.secret && input.value !== null) {
      context.addIssue({
        code: 'custom',
        path: ['value'],
        message: 'secret input values must be null',
      });
    }
    if (input.ignored !== null && input.enabled) {
      context.addIssue({
        code: 'custom',
        path: ['enabled'],
        message: 'ignored inputs must be disabled',
      });
    }
    if (input.ignored !== null && input.source === null) {
      context.addIssue({
        code: 'custom',
        path: ['source'],
        message: 'ignored inputs must retain their source',
      });
    }
  });

const resultStepBaseShape = {
  id: z.string(),
  title: z.string(),
};

const resultStepSchema = z.discriminatedUnion('state', [
  z.strictObject({
    ...resultStepBaseShape,
    state: z.literal('PENDING'),
    exitCode: z.null(),
    durationMs: z.literal(0),
    command: commandSchema,
    skipReason: z.null(),
    outputTail: z.null(),
  }),
  z.strictObject({
    ...resultStepBaseShape,
    state: z.literal('SKIPPED'),
    exitCode: z.null(),
    durationMs: z.literal(0),
    command: z.null(),
    skipReason: z.string().min(1),
    outputTail: z.null(),
  }),
  z.strictObject({
    ...resultStepBaseShape,
    state: z.literal('SUCCEEDED'),
    exitCode: z.number().int(),
    durationMs: nonNegativeDurationSchema,
    command: commandSchema,
    skipReason: z.null(),
    outputTail: z.null(),
  }),
  z.strictObject({
    ...resultStepBaseShape,
    state: z.literal('FAILED'),
    exitCode: z.union([z.number().int(), z.null()]),
    durationMs: nonNegativeDurationSchema,
    command: commandSchema,
    skipReason: z.null(),
    outputTail: z.array(outputLineSchema).max(50),
  }),
  z.strictObject({
    ...resultStepBaseShape,
    state: z.literal('CANCELLED'),
    exitCode: z.null(),
    durationMs: nonNegativeDurationSchema,
    command: commandSchema,
    skipReason: z.null(),
    outputTail: z.null(),
  }),
  z.strictObject({
    ...resultStepBaseShape,
    state: z.literal('NOT_RUN'),
    exitCode: z.null(),
    durationMs: z.literal(0),
    command: commandSchema,
    skipReason: z.null(),
    outputTail: z.null(),
  }),
]);

const resultManifestSchema = z.union([
  z.strictObject({
    path: z.string(),
    sha256: z.string().regex(/^[0-9a-f]{64}$/u),
    schemaVersion: z.literal(1),
  }),
  z.strictObject({
    path: z.string(),
    sha256: z.null(),
    schemaVersion: z.null(),
  }),
]);

const runResultBaseShape = {
  resultSchemaVersion: z.literal(1),
  id: z.uuid(),
  mode: z.enum(['gui', 'interactive', 'non-interactive']),
  platform: z.enum(['windows', 'linux']),
  locale: z.union([z.string(), z.null()]),
  startedAt: z.iso.datetime(),
  finishedAt: z.iso.datetime(),
  durationMs: nonNegativeDurationSchema,
  runeVersion: z.string(),
  product: z.strictObject({ name: z.string(), version: z.string() }),
  manifest: resultManifestSchema,
  stepsTotal: nonNegativeIntegerSchema,
  stepsExecuted: nonNegativeIntegerSchema,
  stepsSucceeded: nonNegativeIntegerSchema,
  stepsFailed: nonNegativeIntegerSchema,
  stepsCancelled: nonNegativeIntegerSchema.max(1),
  stepsSkipped: nonNegativeIntegerSchema,
  stepsNotRun: nonNegativeIntegerSchema,
  nothingExecuted: z.boolean(),
  inputs: z.array(resultInputSchema),
  steps: z.array(resultStepSchema),
};

const statusVariants = [
  z.strictObject({
    ...runResultBaseShape,
    status: z.literal('planned'),
    exitCode: z.literal(0),
    dryRun: z.literal(true),
    crossPlatformPreview: z.boolean(),
  }),
  z.strictObject({
    ...runResultBaseShape,
    status: z.literal('succeeded'),
    exitCode: z.literal(0),
    dryRun: z.literal(false),
    crossPlatformPreview: z.literal(false),
  }),
  z.strictObject({
    ...runResultBaseShape,
    status: z.literal('failed'),
    exitCode: z.literal(1),
    dryRun: z.literal(false),
    crossPlatformPreview: z.literal(false),
  }),
  ...(
    [
      ['config_error', 3],
      ['input_error', 4],
      ['resolution_error', 5],
      ['cancelled', 6],
      ['internal_error', 70],
    ] as const
  ).map(([status, exitCode]) =>
    z.strictObject({
      ...runResultBaseShape,
      status: z.literal(status),
      exitCode: z.literal(exitCode),
      // These failures can happen before either a real run or a dry-run has started.
      dryRun: z.boolean(),
      crossPlatformPreview: z.boolean(),
    }),
  ),
] as const;

export const runResultSchema = z
  .discriminatedUnion('status', statusVariants)
  .superRefine((result, context) => {
    const issue = (path: PropertyKey[], message: string): void => {
      context.addIssue({ code: 'custom', path, message });
    };

    if (result.crossPlatformPreview && !result.dryRun) {
      issue(['crossPlatformPreview'], 'cross-platform preview requires dryRun to be true');
    }
    if (!result.dryRun && result.steps.some((step) => step.state === 'PENDING')) {
      issue(['steps'], 'PENDING steps are valid only in dry-run results');
    }
    if (
      result.dryRun &&
      result.steps.some((step) => step.state !== 'PENDING' && step.state !== 'SKIPPED')
    ) {
      issue(['steps'], 'dry-run results may contain only PENDING or SKIPPED steps');
    }

    const count = (state: (typeof result.steps)[number]['state']): number =>
      result.steps.filter((step) => step.state === state).length;
    const succeeded = count('SUCCEEDED');
    const failed = count('FAILED');
    const cancelled = count('CANCELLED');
    const skipped = count('SKIPPED');
    const notRun = count('NOT_RUN') + count('PENDING');
    const executed = succeeded + failed + cancelled;

    const expectedCounters = [
      ['stepsSucceeded', result.stepsSucceeded, succeeded],
      ['stepsFailed', result.stepsFailed, failed],
      ['stepsCancelled', result.stepsCancelled, cancelled],
      ['stepsSkipped', result.stepsSkipped, skipped],
      ['stepsNotRun', result.stepsNotRun, notRun],
      ['stepsExecuted', result.stepsExecuted, executed],
    ] as const;
    for (const [field, actual, expected] of expectedCounters) {
      if (actual !== expected) {
        issue([field], `${field} must equal the count derived from steps`);
      }
    }

    const states = new Set(result.steps.map((step) => step.state));
    if (
      result.status === 'succeeded' &&
      (states.has('FAILED') ||
        states.has('CANCELLED') ||
        states.has('NOT_RUN') ||
        states.has('PENDING'))
    ) {
      issue(['status'], 'succeeded results may contain only SUCCEEDED or SKIPPED steps');
    }
    if (result.status === 'failed') {
      if (!states.has('FAILED')) {
        issue(['status'], 'failed results must contain at least one FAILED step');
      }
      if (states.has('CANCELLED') || states.has('PENDING')) {
        issue(['status'], 'failed results may not contain CANCELLED or PENDING steps');
      }
    }
    if (result.status === 'cancelled' && states.has('PENDING')) {
      issue(['status'], 'cancelled results may not contain PENDING steps');
    }

    if (result.stepsTotal !== result.stepsExecuted + result.stepsSkipped + result.stepsNotRun) {
      issue(['stepsTotal'], 'stepsTotal must equal stepsExecuted + stepsSkipped + stepsNotRun');
    }
    if (
      result.stepsExecuted !==
      result.stepsSucceeded + result.stepsFailed + result.stepsCancelled
    ) {
      issue(
        ['stepsExecuted'],
        'stepsExecuted must equal stepsSucceeded + stepsFailed + stepsCancelled',
      );
    }
    if (result.stepsTotal !== result.steps.length) {
      issue(['stepsTotal'], 'stepsTotal must equal steps.length');
    }
    if (result.nothingExecuted !== (result.stepsExecuted === 0)) {
      issue(['nothingExecuted'], 'nothingExecuted must be true exactly when stepsExecuted is 0');
    }
  });

// The one-way pin: everything the mirror accepts is a valid RunResult. The reverse
// direction (readonly model arrays into the mirror's mutable inference) is covered by the
// behavioural tests that parse results from every producer.
type Mirrored = z.infer<typeof runResultSchema>;
const pin = (value: Mirrored): RunResult => value;
void pin;

/** The JSON Schema of `resultSchemaVersion: 1`, generated at call time like `rune schema`. */
export function resultJsonSchema(): Record<string, unknown> {
  return z.toJSONSchema(runResultSchema) as Record<string, unknown>;
}
