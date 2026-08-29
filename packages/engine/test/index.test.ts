import { describe, expect, it } from 'vitest';

import * as engine from '../src/index.js';
import type { Resolution, ResolveInputsOptions, SecretString } from '../src/index.js';

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

  it('does not export secret constructors or registries', () => {
    expect(engine).not.toHaveProperty('SecretString');
    expect(engine).not.toHaveProperty('SecretRegistry');
  });
});
