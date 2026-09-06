/**
 * `@rune/engine` — public API surface.
 *
 * Everything exported from this module is public API (docs/architecture.md §3); the CLI
 * and the GUI shell's main process import the engine only through it.
 */

export { RUNE_VERSION } from './version.js';

export {
  CancelledError,
  ConditionError,
  ExecutionError,
  exitCodeFor,
  formatIssues,
  formatRuneError,
  InputError,
  InternalError,
  INTERNAL_EXIT_CODE,
  ManifestError,
  PlatformError,
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
  validateManifest,
} from './manifest/index.js';
export type {
  Manifest,
  ParseManifestOptions,
  ValidateManifestOptions,
  ValidationReport,
} from './manifest/index.js';

export { BUILT_IN_NAMES, BUILT_IN_VARIABLES, PRODUCT_FIELDS } from './engine/context.js';
export type { Platform, ValueType } from './engine/context.js';

export { PLAN_SCHEMA_VERSION } from './engine/plan.js';
export type {
  ExecutionPlan,
  PlannedStep,
  PlanExecutionOptions,
  PlanInput,
  ResolvedCommand,
} from './engine/plan.js';

export { sameSinkPath } from './engine/paths.js';

export { RESULT_LOG_COLLISION_MESSAGE, Session } from './engine/session.js';
export type {
  EffectiveLogFile,
  InputStateChanged,
  SessionOptions,
  ThemeConfig,
} from './engine/session.js';
export type { InputRejection, InputState, InputViewSpec, ValueSource } from './engine/inputs.js';

export { createCompletedRunFailureResult, createFailureResult } from './engine/executor.js';
export type { FailureResultOptions, FailureResultSession } from './engine/executor.js';

export { CancelToken } from './engine/cancel.js';
export type {
  EngineObserver,
  RunEvent,
  RunFinished,
  RunStarted,
  StepFinished,
  StepOutput,
  StepStarted,
} from './engine/events.js';

export type { StepState } from './engine/state.js';

export { RESULT_SCHEMA_VERSION } from './results/model.js';
export type {
  ResultInput,
  ResultError,
  ResultErrorCode,
  ResultManifest,
  ResultOutputLine,
  ResultStep,
  RunResult,
  RunMode,
  RunStatus,
} from './results/model.js';
export { resultJsonSchema } from './results/schema.js';
export { serializeResult, writeResult } from './results/writer.js';
export type { WriteResultOptions } from './results/writer.js';

export type { StringTable } from './i18n/strings.js';
export { formatSessionTerminalLine } from './i18n/strings.js';
export type { ChromeKey } from './i18n/catalog.js';

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
export type { EnvironmentUse } from './manifest/v1/rules.js';
