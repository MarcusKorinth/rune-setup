import { describe, expect, it } from 'vitest';

import * as engine from '../src/index.js';
import { PlatformError, RUNE_VERSION } from '../src/index.js';

describe('@rune/engine public API', () => {
  it('exposes a semver version', () => {
    expect(RUNE_VERSION).toMatch(/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/);
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
