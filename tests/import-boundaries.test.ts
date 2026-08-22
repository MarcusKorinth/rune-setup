import { cruise, type ICruiseResult } from 'dependency-cruiser';
import extractDepcruiseConfig from 'dependency-cruiser/config-utl/extract-depcruise-config';
import extractTSConfig from 'dependency-cruiser/config-utl/extract-ts-config';
import { describe, expect, it } from 'vitest';

/**
 * Guards the import-boundary gate of docs/architecture.md §14 against going vacuous:
 * dependency-cruiser must see `import ... from '@rune/engine'` resolved to the engine
 * sources (not dropped as unresolvable or excluded as dist output), otherwise rules such as
 * renderer-never-imports-engine would pass without ever being applied.
 */
describe('import boundaries (dependency-cruiser gate)', () => {
  it('resolves workspace imports of @rune/engine to the engine sources', async () => {
    const config = await extractDepcruiseConfig('./.dependency-cruiser.cjs');
    const tsConfig = extractTSConfig('./tsconfig.depcruise.json');
    // Same composition the depcruise CLI performs: the config's `options` become the cruise
    // options (incl. tsConfig → tsconfig paths), the config itself is the rule set.
    const { output, exitCode } = await cruise(
      ['packages', 'tests'],
      { ...config.options, ruleSet: config, validate: true, outputType: 'json' },
      undefined,
      { tsConfig },
    );
    const result: ICruiseResult = typeof output === 'string' ? JSON.parse(output) : output;

    expect(exitCode, 'the current tree must be free of boundary violations').toBe(0);

    const cli = result.modules.find((m) => m.source === 'packages/cli/src/cli.ts');
    expect(cli, 'packages/cli/src/cli.ts must be part of the cruise').toBeDefined();
    expect(cli?.dependencies.map((d) => d.resolved)).toContain('packages/engine/src/index.ts');
    expect(cli?.dependencies.some((d) => d.couldNotResolve)).toBe(false);
  });
});
