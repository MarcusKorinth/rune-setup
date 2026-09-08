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
  // Vite's default transform skips .cts, but the GUI shell's preload is deliberately
  // CommonJS (a sandboxed Electron preload cannot be an ES module) and its unit test
  // imports the source.
  oxc: { include: /\.(m|c)?ts$/ },
  test: {
    environment: 'node',
    include: ['packages/*/test/**/*.test.ts', 'tests/**/*.test.ts'],
    passWithNoTests: false,
    // Several integration tests spawn real Node children; Windows CI contention can exceed Vitest's 5s default.
    testTimeout: 15_000,
    coverage: {
      provider: 'v8',
      // Include unimported runtime files too. Child processes and native Electron
      // tests run outside this collector; their execution is not credited here.
      include: ['packages/*/src/**/*.{ts,cts}'],
      exclude: ['**/*.d.ts'],
      reporter: ['text', 'json', 'json-summary', 'html'],
      reportOnFailure: true,
      thresholds: {
        // Floors are the lower Windows/Linux baseline rounded down. The global
        // report includes the renderer, even though only native tests execute it.
        statements: 87,
        branches: 84,
        functions: 92,
        lines: 87,
        'packages/engine/src/**/*.ts': {
          statements: 94,
          branches: 90,
          functions: 96,
          lines: 95,
        },
        'packages/cli/src/**/*.ts': {
          statements: 94,
          branches: 90,
          functions: 90,
          lines: 96,
        },
        'packages/gui-shell/src/main/**/*.ts': {
          statements: 97,
          branches: 91,
          functions: 99,
          lines: 97,
        },
        'packages/gui-shell/src/preload/**/*.{ts,cts}': {
          statements: 92,
          branches: 94,
          functions: 100,
          lines: 95,
        },
      },
    },
  },
});
