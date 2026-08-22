import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

/**
 * One vitest configuration for the whole monorepo (docs/architecture.md §14).
 * Workspace packages are resolved to their TypeScript sources so tests never depend on a
 * prior build; the cross-package suites live in tests/.
 */
export default defineConfig({
  resolve: {
    alias: {
      '@rune/engine': fileURLToPath(new URL('./packages/engine/src/index.ts', import.meta.url)),
    },
  },
  test: {
    environment: 'node',
    include: ['packages/*/test/**/*.test.ts', 'tests/**/*.test.ts'],
    passWithNoTests: false,
  },
});
