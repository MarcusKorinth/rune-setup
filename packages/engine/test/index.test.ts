import { describe, expect, it } from 'vitest';

import * as engine from '../src/index.js';
import { PlatformError } from '../src/index.js';
import type { ChromeKey, ResultError, RunMode, SessionOptions, StringTable } from '../src/index.js';

const INTERNAL_RUNTIME_EXPORTS = [
  'EXIT_CODE_BY_STATUS',
  'CHROME_CATALOG',
  'formatChrome',
  'discoverOverlays',
  'discoverSelectedOverlay',
  'discoverSelectedOverlayAsync',
  'LOCALES_DIRECTORY',
  'matchOverlay',
  'normalizeLocaleTag',
  'selectLocale',
  'loadOverlay',
  'loadOverlayAsync',
  'loadOverlayText',
  'localizableKeys',
  'overlayManifestFor',
  'resolveStrings',
  'stringTableContextFor',
  'createLogFileSink',
  'checkSemanticsAsync',
  'loadYamlFileAsync',
  'parseManifestAsync',
  'parseValuesFileAsync',
  'snapshotHostBuiltIns',
] as const;

type StringTableIsExported = StringTable extends object ? true : false;
const stringTableTypeIsExported: StringTableIsExported = true;
type SessionOptionsExcludesRunner = 'runner' extends keyof SessionOptions ? false : true;
const sessionOptionsExcludesRunner: SessionOptionsExcludesRunner = true;
type ChromeParameter = Parameters<StringTable['chrome']>[0];
type ChromeParameterIsPublicKey = [ChromeParameter, ChromeKey] extends [ChromeKey, ChromeParameter]
  ? true
  : false;
type KnownChromeKeyIsAccepted = 'rune.button.next' extends ChromeParameter ? true : false;
type UnknownChromeKeyIsRejected = 'rune.button.unknown' extends ChromeParameter ? false : true;
const chromeParameterIsPublicKey: ChromeParameterIsPublicKey = true;
const knownChromeKeyIsAccepted: KnownChromeKeyIsAccepted = true;
const unknownChromeKeyIsRejected: UnknownChromeKeyIsRejected = true;
const compileTimeReadonlyAccessorContract = (strings: StringTable): void => {
  // @ts-expect-error StringTable accessors are readonly public properties.
  strings.chrome = () => '';
  // @ts-expect-error StringTable accessors are readonly public properties.
  strings.inputTitle = () => '';
  // @ts-expect-error StringTable accessors are readonly public properties.
  strings.inputDescription = () => undefined;
  // @ts-expect-error StringTable accessors are readonly public properties.
  strings.patternHint = () => undefined;
  // @ts-expect-error StringTable accessors are readonly public properties.
  strings.optionLabel = () => '';
  // @ts-expect-error StringTable accessors are readonly public properties.
  strings.stepTitle = () => '';
  // @ts-expect-error StringTable accessors are readonly public properties.
  strings.productDescription = () => undefined;
  // @ts-expect-error StringTable accessors are readonly public properties.
  strings.windowTitle = () => undefined;
};
// @ts-expect-error input resolution internals are not package-root API
import type { Resolution as ForbiddenResolution } from '../src/index.js';
// @ts-expect-error input resolver options are not package-root API
import type { ResolveInputsOptions as ForbiddenResolveInputsOptions } from '../src/index.js';
// @ts-expect-error opaque secret capabilities are not package-root API
import type { SecretString as ForbiddenSecretString } from '../src/index.js';
// @ts-expect-error low-level planning options are not package-root API
import type { PlanOptions as ForbiddenPlanOptions } from '../src/index.js';
// @ts-expect-error low-level execution options are not package-root API
import type { ExecuteOptions as ForbiddenExecuteOptions } from '../src/index.js';
// @ts-expect-error runner implementations are not package-root API
import type { Runner as ForbiddenRunner } from '../src/index.js';
// @ts-expect-error runner outcomes are not package-root API
import type { SpawnOutcome as ForbiddenSpawnOutcome } from '../src/index.js';
// @ts-expect-error runner requests are not package-root API
import type { SpawnRequest as ForbiddenSpawnRequest } from '../src/index.js';
// @ts-expect-error runner start-failure reasons are not package-root API
import type { StartFailureReason as ForbiddenStartFailureReason } from '../src/index.js';
// @ts-expect-error host built-in snapshots are not package-root API
import type { HostBuiltInSnapshot as ForbiddenHostBuiltInSnapshot } from '../src/index.js';

type ForbiddenRootTypes = readonly [
  ForbiddenResolution,
  ForbiddenResolveInputsOptions,
  ForbiddenSecretString,
  ForbiddenPlanOptions,
  ForbiddenExecuteOptions,
  ForbiddenRunner,
  ForbiddenSpawnOutcome,
  ForbiddenSpawnRequest,
  ForbiddenStartFailureReason,
  ForbiddenHostBuiltInSnapshot,
];

function assertNoLowLevelRootTypes(_types: ForbiddenRootTypes): void {}

void assertNoLowLevelRootTypes;

const compileTimeSessionRunnerContract = (manifestPath: string): void => {
  // @ts-expect-error runner injection is not part of public SessionOptions.
  const options: SessionOptions = { runner: undefined };
  // @ts-expect-error Session.open does not accept a public runner dependency.
  void engine.Session.open(manifestPath, { runner: { run: async () => undefined } });
  void options;
};

void compileTimeSessionRunnerContract;

const FORBIDDEN_RUNTIME_EXPORTS = [
  'buildPlan',
  'describePlan',
  'executeRun',
  'OUTPUT_TAIL_LINES',
  'SpawnRunner',
  'MAX_OUTPUT_LINE_BYTES',
  'OVERSIZED_OUTPUT_LINE_PLACEHOLDER',
  'spawnRunnerTestSeam',
  'createSessionOptionsForTesting',
  'isLegalTransition',
  'isTerminal',
  'STEP_STATES',
  'serializeResult',
] as const;

const PUBLIC_RUN_MODES = [
  'gui',
  'interactive',
  'non-interactive',
] as const satisfies readonly RunMode[];

void PUBLIC_RUN_MODES;

const PUBLIC_RESULT_ERROR: ResultError<'RUNE-104'> = {
  code: 'RUNE-104',
  message: 'invalid manifest semantics',
  location: { file: 'installer.yaml', line: 1, column: 1 },
};
const PUBLIC_LOG_RESULT_ERROR: ResultError<'RUNE-406'> = {
  code: 'RUNE-406',
  message: 'cannot finalize the operational log',
  location: null,
};
// @ts-expect-error usage errors are never part of a configured-run result
const FORBIDDEN_RESULT_ERROR: ResultError<'RUNE-001'> = {
  code: 'RUNE-001',
  message: 'usage error',
  location: null,
};

void PUBLIC_RESULT_ERROR;
void PUBLIC_LOG_RESULT_ERROR;
void FORBIDDEN_RESULT_ERROR;

describe('@rune/engine public API', () => {
  it('exposes a semver version', () => {
    expect(engine.RUNE_VERSION).toMatch(/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/);
  });

  it('does not expose internal runtime helpers', () => {
    for (const name of INTERNAL_RUNTIME_EXPORTS) {
      expect(engine).not.toHaveProperty(name);
    }
  });

  it('keeps i18n contracts as type-only exports', () => {
    expect(stringTableTypeIsExported).toBe(true);
    expect(chromeParameterIsPublicKey).toBe(true);
    expect(knownChromeKeyIsAccepted).toBe(true);
    expect(unknownChromeKeyIsRejected).toBe(true);
    expect(compileTimeReadonlyAccessorContract).toBeTypeOf('function');
    expect(engine).not.toHaveProperty('StringTable');
    expect(engine).not.toHaveProperty('ChromeKey');
  });

  it('exports the execution-plan schema version', () => {
    expect(engine.PLAN_SCHEMA_VERSION).toBe(1);
  });

  it('exports the Session facade and engine-owned failure-result construction', () => {
    expect(engine.Session).toBeTypeOf('function');
    expect(engine.createFailureResult).toBeTypeOf('function');
    expect(sessionOptionsExcludesRunner).toBe(true);
  });

  it.each(FORBIDDEN_RUNTIME_EXPORTS)('does not expose low-level runtime export %s', (name) => {
    expect(Object.hasOwn(engine, name)).toBe(false);
  });

  it('does not export secret constructors or registries', () => {
    expect(engine).not.toHaveProperty('SecretString');
    expect(engine).not.toHaveProperty('SecretRegistry');
  });

  it('exposes errors without exposing engine internals', () => {
    expect(PlatformError).toBeTypeOf('function');

    expect(engine).not.toHaveProperty('createRuntimeContext');
    expect(engine).not.toHaveProperty('hostPlatform');
    expect(engine).not.toHaveProperty('parseValuesFile');
    expect(engine).not.toHaveProperty('resolveInputs');
    expect(engine).not.toHaveProperty('VALUE_SOURCES');
    expect(engine).not.toHaveProperty('isSecretString');
    expect(engine).not.toHaveProperty('MASK');
    expect(engine).not.toHaveProperty('SecretRegistry');
    expect(engine).not.toHaveProperty('SecretString');
    expect(engine).not.toHaveProperty('inputTypes');
    expect(engine).not.toHaveProperty('InputTypeRegistry');
  });
});
