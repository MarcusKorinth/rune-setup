/**
 * Import-boundary rules from docs/architecture.md §3 (dependency directions) and §14
 * ("Import-boundary test"). Run with `npm run depcruise`.
 *
 * @type {import('dependency-cruiser').IConfiguration}
 */
module.exports = {
  forbidden: [
    {
      name: 'engine-never-imports-frontends',
      comment:
        'docs/architecture.md §3 / invariant 11: @rune/engine never depends on cli or gui-shell',
      severity: 'error',
      from: { path: '^packages/engine/' },
      to: { path: '^packages/(cli|gui-shell)/' },
    },
    {
      name: 'cli-uses-engine-public-api-only',
      comment:
        'docs/architecture.md §3: the CLI imports the engine only through its public API (package entry)',
      severity: 'error',
      from: { path: '^packages/cli/' },
      to: { path: '^packages/engine/src/', pathNot: '^packages/engine/src/index\\.ts$' },
    },
    {
      name: 'shell-uses-engine-public-api-only',
      comment:
        'docs/architecture.md §9.4: the shell main process imports the engine like the CLI does',
      severity: 'error',
      from: { path: '^packages/gui-shell/' },
      to: { path: '^packages/engine/src/', pathNot: '^packages/engine/src/index\\.ts$' },
    },
    {
      name: 'renderer-never-imports-engine',
      comment: 'docs/architecture.md §9.4: the renderer is a pure renderer behind the IPC bridge',
      severity: 'error',
      from: { path: '^packages/gui-shell/src/renderer/' },
      to: { path: '^packages/engine/' },
    },
    {
      name: 'not-to-unresolvable',
      comment: 'a silently dropped edge must never make a boundary rule vacuous',
      severity: 'error',
      from: {},
      to: { couldNotResolve: true },
    },
    {
      name: 'no-circular',
      severity: 'error',
      from: {},
      to: { circular: true },
    },
  ],
  options: {
    doNotFollow: { path: ['node_modules'] },
    exclude: { path: ['node_modules', '/dist/'] },
    tsPreCompilationDeps: true,
    // Resolve workspace packages to their sources so bare imports such as '@rune/engine'
    // are real edges for the rules above (they would otherwise resolve to dist/ or be dropped).
    tsConfig: { fileName: 'tsconfig.depcruise.json' },
    enhancedResolveOptions: {
      exportsFields: ['exports'],
      conditionNames: ['import', 'require', 'node', 'default', 'types'],
      extensions: ['.ts', '.js', '.cjs', '.mjs', '.json'],
    },
    reporterOptions: {
      text: { highlightFocused: true },
    },
  },
};
