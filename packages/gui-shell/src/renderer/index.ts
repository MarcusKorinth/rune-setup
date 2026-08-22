/**
 * Renderer of the RUNE GUI shell (docs/architecture.md §9.3/§9.4): a pure renderer —
 * pages Welcome, inputs, Summary, Progress, Result — that reaches the engine only through
 * the IPC bridge and never imports `@rune/engine` (enforced by .dependency-cruiser.cjs).
 *
 * Milestone 0 placeholder — implemented in milestone 3.
 */
export {};
