import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

/**
 * One vitest configuration for the whole monorepo (docs/architecture.md §14).
 * Workspace packages are resolved to their TypeScript sources so tests never depend on a
 * prior build; the cross-package suites live in tests/.
 *
 * The mapping itself is not repeated here: tsconfig.paths.json is the single source of truth
 * shared with tsconfig.test.json and the dependency-cruiser gate, so the three consumers of
 * "workspace package → sources" cannot drift apart.
 */
const { compilerOptions } = JSON.parse(
  readFileSync(new URL('./tsconfig.paths.json', import.meta.url), 'utf8'),
) as { compilerOptions: { paths: Record<string, [string, ...string[]]> } };

const escapeForRegExp = (value: string): string => value.replace(/[\\^$.*+?()[\]{}|]/g, '\\$&');

const alias = Object.entries(compilerOptions.paths).map(([specifier, [target]]) => ({
  // Anchored: a plain string key would alias by prefix and silently mangle future subpaths.
  find: new RegExp(`^${escapeForRegExp(specifier)}$`),
  replacement: fileURLToPath(new URL(target, import.meta.url)),
}));

export default defineConfig({
  resolve: { alias },
  test: {
    environment: 'node',
    include: ['packages/*/test/**/*.test.ts', 'tests/**/*.test.ts'],
    passWithNoTests: false,
    // Several integration tests spawn real Node children; Windows CI contention can exceed Vitest's 5s default.
    testTimeout: 15_000,
  },
});
