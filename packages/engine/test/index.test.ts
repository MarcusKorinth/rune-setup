import { describe, expect, it } from 'vitest';

import { PLAN_SCHEMA_VERSION, RUNE_VERSION } from '../src/index.js';

describe('@rune/engine public API', () => {
  it('exposes a semver version', () => {
    expect(RUNE_VERSION).toMatch(/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/);
  });

  it('exports the execution-plan schema version', () => {
    expect(PLAN_SCHEMA_VERSION).toBe(1);
  });
});
