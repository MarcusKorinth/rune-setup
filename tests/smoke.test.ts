import { describe, expect, it } from 'vitest';

import { RUNE_VERSION } from '@rune/engine';

/**
 * Cross-package suites live here (docs/architecture.md §14: mode-parity contract suite,
 * exit-code reachability, masking). This smoke test checks that workspace packages
 * resolve to their sources.
 */
describe('cross-package smoke', () => {
  it('resolves the engine public API through the workspace', () => {
    expect(typeof RUNE_VERSION).toBe('string');
  });
});
