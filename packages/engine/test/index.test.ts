import { describe, expect, it } from 'vitest';

import * as engine from '../src/index.js';
import { PlatformError, RUNE_VERSION } from '../src/index.js';
import type { RunMode } from '../src/index.js';
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
];

function assertNoLowLevelRootTypes(_types: ForbiddenRootTypes): void {}

void assertNoLowLevelRootTypes;

const FORBIDDEN_RUNTIME_EXPORTS = [
  'buildPlan',
  'describePlan',
  'executeRun',
  'OUTPUT_TAIL_LINES',
  'SpawnRunner',
  'MAX_OUTPUT_LINE_BYTES',
  'OVERSIZED_OUTPUT_LINE_PLACEHOLDER',
  'spawnRunnerTestSeam',
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

describe('@rune/engine public API', () => {
  it('exposes a semver version', () => {
    expect(RUNE_VERSION).toMatch(/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/);
  });

  it('exports the execution-plan schema version', () => {
    expect(engine.PLAN_SCHEMA_VERSION).toBe(1);
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
