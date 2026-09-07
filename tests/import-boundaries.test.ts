import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { cruise, type ICruiseResult } from 'dependency-cruiser';
import extractDepcruiseConfig from 'dependency-cruiser/config-utl/extract-depcruise-config';
import extractTSConfig from 'dependency-cruiser/config-utl/extract-ts-config';
import { describe, expect, it } from 'vitest';

// Dependency-Cruiser analyzes the workspace graph and can exceed the unit-test default under CI load.
const INTEGRATION_TIMEOUT_MS = 30_000;

function slowIt(name: string, run: () => Promise<void>): void {
  it(name, run, INTEGRATION_TIMEOUT_MS);
}

/**
 * Guards the import-boundary gate of docs/architecture.md §14 against going vacuous:
 * dependency-cruiser must see every `import ... from '@rune/*'` resolved to that package's
 * sources. An unmapped package name resolves into its `dist/` output instead, which
 * `options.exclude` drops — and a dropped edge makes rules such as
 * engine-never-imports-frontends pass without ever being applied.
 */

/** Repository-root-relative path, independent of the process working directory. */
const repoPath = (relativePath: string): string =>
  fileURLToPath(new URL(relativePath, import.meta.url));

const readJson = (relativePath: string): unknown =>
  JSON.parse(readFileSync(repoPath(relativePath), 'utf8'));

describe('import boundaries (dependency-cruiser gate)', () => {
  it('maps every workspace package name to that package sources', () => {
    const { compilerOptions } = readJson('../tsconfig.paths.json') as {
      compilerOptions: { paths: Record<string, string[]> };
    };
    const packageDirs = readdirSync(repoPath('../packages'), { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);

    expect(packageDirs.length, 'packages/ must contain at least one workspace').toBeGreaterThan(0);

    for (const dir of packageDirs) {
      const { name } = readJson(`../packages/${dir}/package.json`) as { name: string };
      const target = compilerOptions.paths[name]?.[0];

      expect(target, `${name} must be mapped in tsconfig.paths.json`).toBeDefined();
      expect(target, `${name} must be mapped to packages/${dir}/src/`).toMatch(
        `packages/${dir}/src/`,
      );
    }
  });

  slowIt('resolves workspace imports of @rune/engine to the engine sources', async () => {
    const config = await extractDepcruiseConfig(repoPath('../.dependency-cruiser.cjs'));
    const tsConfig = extractTSConfig(repoPath('../tsconfig.depcruise.json'));
    // Same composition the depcruise CLI performs: the config's `options` become the cruise
    // options (incl. tsConfig → tsconfig paths), the config itself is the rule set.
    const { output } = await cruise(
      ['packages', 'tests'],
      { ...config.options, ruleSet: config, validate: true, outputType: 'json' },
      undefined,
      { tsConfig },
    );
    const result: ICruiseResult = typeof output === 'string' ? JSON.parse(output) : output;

    // Naming the offending rule and edge here saves a manual `npm run depcruise` on failure.
    const violations = result.summary.violations.map(
      (violation) => `${violation.rule.name}: ${violation.from} → ${violation.to}`,
    );
    expect(violations, 'the current tree must be free of boundary violations').toEqual([]);

    const cli = result.modules.find((m) => m.source === 'packages/cli/src/cli.ts');
    expect(cli, 'packages/cli/src/cli.ts must be part of the cruise').toBeDefined();
    expect(cli?.dependencies.map((d) => d.resolved)).toContain('packages/engine/src/index.ts');
    expect(cli?.dependencies.some((d) => d.couldNotResolve)).toBe(false);
  });
});
