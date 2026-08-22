/**
 * Electron main process of the RUNE GUI shell (docs/architecture.md §9.4): hosts
 * `@rune/engine` in-process, owns the Session, registers the IPC handlers, creates the
 * window, and exits with the engine's exit code.
 *
 * Milestone 0 placeholder — the shell is built in milestone 3; Electron is not a
 * dependency yet. This file only establishes the package and its import boundaries.
 */
export {};
