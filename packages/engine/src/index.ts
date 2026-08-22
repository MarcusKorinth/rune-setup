/**
 * `@rune/engine` — public API surface.
 *
 * Everything exported from this module is public API (docs/architecture.md §3); the CLI
 * and the GUI shell's main process import the engine only through it.
 *
 * Milestone 0 skeleton: the package exists so that the monorepo, the import boundaries and
 * the CI pipeline are real before the engine lands (docs/roadmap.md, milestone 1).
 */

/** Version of the engine package. Kept in sync with package.json by the release process. */
export const RUNE_VERSION = '0.0.0';
