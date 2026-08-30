import { describe, expect, it } from 'vitest';

import * as engine from '../src/index.js';
import type { Resolution, ResolveInputsOptions, SecretString } from '../src/index.js';
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
] as const;

function assertOpaqueSecretType(secret: SecretString): void {
  // @ts-expect-error plaintext reveal is not public
  secret.reveal();
  // @ts-expect-error plaintext matching is not public
  secret.matches(/secret/);
  // @ts-expect-error plaintext equality is not public
  secret.equals('secret');
  // @ts-expect-error plaintext membership is not public
  secret.isIncludedIn(['secret']);
  // @ts-expect-error registry access is not public
  secret.registerForMasking(undefined);
  // @ts-expect-error secret path transformation is not public
  secret.resolvePathFrom('/project');
  // @ts-expect-error secret length is not public
  void secret.length;
}

void assertOpaqueSecretType;

function assertNoPublicRegistry(options: ResolveInputsOptions, resolution: Resolution): void {
  // @ts-expect-error callers cannot inject a masking registry
  void options.secrets;
  // @ts-expect-error resolutions do not expose their masking registry
  void resolution.secrets;
}

void assertNoPublicRegistry;

describe('@rune/engine public API', () => {
  it('exposes a semver version', () => {
    expect(engine.RUNE_VERSION).toMatch(/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/);
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
});
