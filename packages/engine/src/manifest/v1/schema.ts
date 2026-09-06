/**
 * The manifest shape for `schemaVersion: 1` (docs/architecture.md §4.2).
 *
 * These schemas describe *shape only*: every object is strict, so unknown keys are rejected
 * loudly (invariant 12), and nothing here refines across fields. Cross-field semantics live
 * in `rules.ts`, which keeps this module a faithful source for `rune schema` (§4.1).
 */

import { z } from 'zod';

/** The seven input types of the MVP (docs/architecture.md §4.2). */
export const INPUT_TYPES = [
  'text',
  'secret',
  'boolean',
  'select',
  'multiselect',
  'file',
  'directory',
] as const;

export type InputType = (typeof INPUT_TYPES)[number];

/**
 * Identifier shapes. They live in the schema rather than among the semantic rules so that
 * the JSON Schema `rune schema` publishes is exactly as strict as validation — an editor
 * must not accept what the engine rejects.
 */
export const INPUT_ID = /^[A-Za-z_][A-Za-z0-9_]*$/;
export const STEP_ID = /^[a-z][a-z0-9-]*$/;

/** An option of a `select`/`multiselect`: a bare value, or a value with a display label. */
export const optionSpecSchema = z.union([
  z.string(),
  z.strictObject({ value: z.string(), label: z.string() }),
]);

const MAX_TIMEOUT_SECONDS = Math.floor(2_147_483_647 / 1000);

export const commandSpecSchema = z.strictObject({
  command: z.string().min(1),
  args: z.array(z.string()).default([]),
  cwd: z.string().optional(),
  env: z.record(z.string(), z.string()).default({}),
  timeoutSeconds: z.number().int().positive().max(MAX_TIMEOUT_SECONDS).nullable().default(null),
  successExitCodes: z.array(z.number().int()).default([0]),
});

/** Platform-specific commands. `macos` is reserved for a later schema version. */
export const platformRunSchema = z.strictObject({
  windows: commandSpecSchema.optional(),
  linux: commandSpecSchema.optional(),
});

export const runSchema = z.union([commandSpecSchema, platformRunSchema]);

const inputBase = {
  title: z.string().optional(),
  description: z.string().optional(),
  required: z.boolean().default(true),
  when: z.string().optional(),
};

export const textInputSchema = z.strictObject({
  type: z.literal('text'),
  ...inputBase,
  default: z.string().optional(),
  pattern: z.string().optional(),
  patternHint: z.string().optional(),
});

/** `secret` deliberately has neither `default` nor `pattern` (docs/architecture.md §4.2). */
export const secretInputSchema = z.strictObject({ type: z.literal('secret'), ...inputBase });

export const booleanInputSchema = z.strictObject({
  type: z.literal('boolean'),
  ...inputBase,
  default: z.boolean().optional(),
});

export const selectInputSchema = z.strictObject({
  type: z.literal('select'),
  ...inputBase,
  options: z.array(optionSpecSchema).min(1),
  default: z.string().optional(),
});

export const multiselectInputSchema = z.strictObject({
  type: z.literal('multiselect'),
  ...inputBase,
  options: z.array(optionSpecSchema).min(1),
  default: z.array(z.string()).optional(),
});

export const fileInputSchema = z.strictObject({
  type: z.literal('file'),
  ...inputBase,
  default: z.string().optional(),
});

export const directoryInputSchema = z.strictObject({
  type: z.literal('directory'),
  ...inputBase,
  default: z.string().optional(),
});

export const inputSpecSchema = z.discriminatedUnion('type', [
  textInputSchema,
  secretInputSchema,
  booleanInputSchema,
  selectInputSchema,
  multiselectInputSchema,
  fileInputSchema,
  directoryInputSchema,
]);

export const stepSchema = z.strictObject({
  id: z.string().regex(STEP_ID),
  title: z.string().optional(),
  when: z.string().optional(),
  run: runSchema,
});

export const productSchema = z.strictObject({
  name: z.string().min(1),
  version: z.string().min(1),
  description: z.string().optional(),
});

export const executionSchema = z.strictObject({
  failFast: z.boolean().default(true),
  logFile: z.string().min(1).optional(),
});

/** Presentation-only; read by the GUI shell, ignored by the CLI modes (§9.4). */
export const guiSchema = z.strictObject({
  accentColor: z.string().optional(),
  logo: z.string().optional(),
  banner: z.string().optional(),
  theme: z.string().optional(),
  windowTitle: z.string().optional(),
});

export const manifestV1Schema = z.strictObject({
  schemaVersion: z.literal(1),
  product: productSchema,
  inputs: z.record(z.string().regex(INPUT_ID), inputSpecSchema).default({}),
  steps: z.array(stepSchema),
  execution: executionSchema.default({ failFast: true }),
  gui: guiSchema.optional(),
});

export type ManifestV1 = z.infer<typeof manifestV1Schema>;
export type InputSpec = z.infer<typeof inputSpecSchema>;
export type OptionSpec = z.infer<typeof optionSpecSchema>;
export type Step = z.infer<typeof stepSchema>;
export type CommandSpec = z.infer<typeof commandSpecSchema>;
export type PlatformRun = z.infer<typeof platformRunSchema>;
export type RunSpec = z.infer<typeof runSchema>;
export type GuiConfig = z.infer<typeof guiSchema>;
export type ExecutionConfig = z.infer<typeof executionSchema>;

/** True when a `run:` block is a single command rather than a platform mapping. */
export function isCommandSpec(run: RunSpec): run is CommandSpec {
  return 'command' in run;
}

/** The value a `select`/`multiselect` option contributes; labels are display-only. */
export function optionValue(option: OptionSpec): string {
  return typeof option === 'string' ? option : option.value;
}

/** The label a frontend displays for an option; defaults to the value. */
export function optionLabel(option: OptionSpec): string {
  return typeof option === 'string' ? option : option.label;
}

/**
 * The accepted keys per input type. `satisfies Record<InputType, …>` is the whole point: an
 * eighth input type is a compile error here instead of a silent fallback to the `text` keys in
 * `present.ts`, which would suggest the wrong keys for the new type.
 */
const INPUT_KEYS = {
  text: Object.keys(textInputSchema.shape),
  secret: Object.keys(secretInputSchema.shape),
  boolean: Object.keys(booleanInputSchema.shape),
  select: Object.keys(selectInputSchema.shape),
  multiselect: Object.keys(multiselectInputSchema.shape),
  file: Object.keys(fileInputSchema.shape),
  directory: Object.keys(directoryInputSchema.shape),
} as const satisfies Record<InputType, readonly string[]>;

/**
 * The accepted keys of every mapping in the schema, derived from the schemas above so that
 * the "did you mean …?" suggestions in `present.ts` can never drift from what is accepted.
 */
export const KNOWN_KEYS = {
  root: Object.keys(manifestV1Schema.shape),
  product: Object.keys(productSchema.shape),
  execution: Object.keys(executionSchema.shape),
  gui: Object.keys(guiSchema.shape),
  step: Object.keys(stepSchema.shape),
  command: Object.keys(commandSpecSchema.shape),
  platformRun: Object.keys(platformRunSchema.shape),
  option: ['value', 'label'],
  input: INPUT_KEYS,
} as const satisfies Record<string, readonly string[] | Record<string, readonly string[]>>;
