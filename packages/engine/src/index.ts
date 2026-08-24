/**
 * `@rune/engine` — public API surface.
 *
 * Everything exported from this module is public API (docs/architecture.md §3); the CLI
 * and the GUI shell's main process import the engine only through it.
 */

/**
 * Version of the engine package. Pinned to `packages/engine/package.json` by
 * `tests/package-versions.test.ts`, so a release bump cannot land here half-done.
 */
export const RUNE_VERSION = '0.0.0';

export {
  CancelledError,
  ConditionError,
  ExecutionError,
  exitCodeFor,
  formatIssues,
  InputError,
  InternalError,
  INTERNAL_EXIT_CODE,
  ManifestError,
  ResolutionError,
  RuneError,
  UsageError,
} from './errors.js';
export type {
  ConditionCode,
  ExecutionCode,
  InputCode,
  Location,
  ManifestCode,
  ResolutionCode,
  RuneCode,
  RuneErrorOptions,
  RuneIssue,
  UsageCode,
} from './errors.js';

export {
  manifestJsonSchema,
  parseManifest,
  parseManifestText,
  SUPPORTED_SCHEMA_VERSIONS,
} from './manifest/index.js';
export type { Manifest, ParseManifestOptions } from './manifest/index.js';

export { MAX_DOCUMENT_BYTES } from './manifest/loader.js';

export { formatLocation, formatPath } from './manifest/source.js';
export type { PathSegment } from './manifest/source.js';

export { INPUT_TYPES, isCommandSpec, optionLabel, optionValue } from './manifest/v1/schema.js';
export type {
  CommandSpec,
  ExecutionConfig,
  GuiConfig,
  InputSpec,
  InputType,
  OptionSpec,
  PlatformRun,
  RunSpec,
  Step,
} from './manifest/v1/schema.js';

export { environmentName } from './manifest/v1/rules.js';
