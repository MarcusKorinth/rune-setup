/**
 * The JSON Schema of the result file (`rune schema --result`, docs/architecture.md §4.1).
 *
 * A zod mirror of the model in `model.ts`, so the schema is generated the same way the
 * manifest schema is and cannot drift silently: the mirror is pinned against the model by
 * type assignability below and by a test that validates a real run's result against it.
 */

import { z } from 'zod';

import { STEP_STATES } from '../engine/state.js';
import { VALUE_SOURCES } from '../engine/inputs.js';
import type { RunResult } from './model.js';

const outputLineSchema = z.strictObject({
  stream: z.string(),
  line: z.string(),
});

const resultInputSchema = z.strictObject({
  id: z.string(),
  value: z.union([z.string(), z.boolean(), z.array(z.string()), z.null()]),
  source: z.union([z.enum(VALUE_SOURCES), z.null()]),
  secret: z.boolean(),
  enabled: z.boolean(),
  ignored: z.union([z.string(), z.null()]),
});

const resultStepSchema = z.strictObject({
  id: z.string(),
  title: z.string(),
  state: z.enum(STEP_STATES),
  exitCode: z.union([z.number().int(), z.null()]),
  durationMs: z.number(),
  command: z.union([z.array(z.string()), z.null()]),
  skipReason: z.union([z.string(), z.null()]),
  outputTail: z.union([z.array(outputLineSchema), z.null()]),
});

export const runResultSchema = z.strictObject({
  resultSchemaVersion: z.literal(1),
  id: z.string(),
  status: z.enum([
    'succeeded',
    'planned',
    'failed',
    'cancelled',
    'config_error',
    'input_error',
    'resolution_error',
    'internal_error',
  ]),
  exitCode: z.number().int(),
  mode: z.enum(['gui', 'interactive', 'non-interactive']),
  dryRun: z.boolean(),
  crossPlatformPreview: z.boolean(),
  platform: z.string(),
  locale: z.union([z.string(), z.null()]),
  startedAt: z.string(),
  finishedAt: z.string(),
  durationMs: z.number(),
  runeVersion: z.string(),
  product: z.strictObject({ name: z.string(), version: z.string() }),
  manifest: z.strictObject({
    path: z.string(),
    sha256: z.union([z.string(), z.null()]),
    schemaVersion: z.union([z.number().int(), z.null()]),
  }),
  stepsTotal: z.number().int(),
  stepsExecuted: z.number().int(),
  stepsSucceeded: z.number().int(),
  stepsFailed: z.number().int(),
  stepsCancelled: z.number().int(),
  stepsSkipped: z.number().int(),
  stepsNotRun: z.number().int(),
  nothingExecuted: z.boolean(),
  inputs: z.array(resultInputSchema),
  steps: z.array(resultStepSchema),
});

// The one-way pin: everything the mirror accepts is a valid RunResult. The reverse
// direction (readonly model arrays into the mirror's mutable inference) is covered by the
// behavioural test that parses a real run's result.
type Mirrored = z.infer<typeof runResultSchema>;
const pin = (value: Mirrored): RunResult => value;
void pin;

/** The JSON Schema of `resultSchemaVersion: 1`, generated at call time like `rune schema`. */
export function resultJsonSchema(): Record<string, unknown> {
  return z.toJSONSchema(runResultSchema) as Record<string, unknown>;
}
