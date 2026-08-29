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
  validateManifest,
} from './manifest/index.js';
export type { Manifest, ParseManifestOptions, ValidationReport } from './manifest/index.js';

export {
  BUILT_IN_NAMES,
  BUILT_IN_VARIABLES,
  createRuntimeContext,
  hostPlatform,
  PRODUCT_FIELDS,
} from './engine/context.js';
export type {
  Platform,
  RuntimeContext,
  RuntimeContextOptions,
  ValueType,
} from './engine/context.js';

export { parseValuesFile, resolveInputs, VALUE_SOURCES } from './engine/inputs.js';
export type {
  InputState,
  Resolution,
  ResolveInputsOptions,
  ValuesDocument,
  ValueSource,
} from './engine/inputs.js';

export { isSecretString, MASK, SecretRegistry, SecretString } from './engine/secrets.js';

export { inputTypes, InputTypeRegistry } from './inputs/registry.js';
export type { Coercion, InputTypeHandler, InputValue } from './inputs/base.js';

export { buildPlan } from './engine/plan.js';
export type { ExecutionPlan, PlannedStep, PlanOptions, ResolvedCommand } from './engine/plan.js';

export { Session } from './engine/session.js';
export type { InputStateChanged, SessionOptions, ThemeConfig } from './engine/session.js';

export {
  describeCancelled,
  describePlan,
  executeRun,
  OUTPUT_TAIL_LINES,
} from './engine/executor.js';
export type { ExecuteOptions } from './engine/executor.js';

export { CancelToken } from './engine/cancel.js';
export type { EngineObserver, RunEvent } from './engine/events.js';

export { isLegalTransition, isTerminal, STEP_STATES } from './engine/state.js';
export type { StepState } from './engine/state.js';

export { SpawnRunner } from './runners/spawnRunner.js';
export type { Runner, SpawnOutcome, SpawnRequest } from './runners/base.js';

export { EXIT_CODE_BY_STATUS, RESULT_SCHEMA_VERSION } from './results/model.js';
export type { ResultInput, ResultStep, RunMode, RunResult, RunStatus } from './results/model.js';
export { serializeResult, writeResult } from './results/writer.js';
export { resultJsonSchema } from './results/schema.js';
export { failureResult, statusForExitCode } from './results/failure.js';
export type { FailureResultOptions } from './results/failure.js';
export { createLogFileSink } from './logs/logFile.js';
export type { LogFileSink } from './logs/logFile.js';

export { CHROME_CATALOG, formatChrome } from './i18n/catalog.js';
export {
  discoverOverlays,
  LOCALES_DIRECTORY,
  matchOverlay,
  normalizeLocaleTag,
  selectLocale,
} from './i18n/locale.js';
export type { DiscoveredOverlay, LocaleSelectionOptions } from './i18n/locale.js';
export { loadOverlay, loadOverlayText, localizableKeys } from './i18n/overlay.js';
export type { LocaleOverlay } from './i18n/overlay.js';
export { resolveStrings } from './i18n/strings.js';
export type { ResolveStringsOptions, StringTable } from './i18n/strings.js';

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
