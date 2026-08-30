import { RUNE_VERSION } from '@rune/engine';

/**
 * Version of the CLI package — what `rune` reports about itself. `@rune/cli` and
 * `@rune/engine` are versioned independently, so the banner (and later `rune --version`)
 * must not borrow the engine's number. Pinned to `packages/cli/package.json` by
 * `tests/package-versions.test.ts`.
 */
export const RUNE_CLI_VERSION = '0.0.0';

/** Minimal I/O seam so the CLI can be exercised in tests without touching process streams. */
export interface CliIo {
  /** Diagnostics go to stderr; stdout is reserved for requested machine output (§10). */
  stderr(line: string): void;
}

const processIo: CliIo = {
  stderr: (line) => {
    process.stderr.write(`${line}\n`);
  },
};

/**
 * Entry point of the `rune` command line (docs/architecture.md §4.1).
 *
 * Milestone 1 is in progress: this package remains a skeleton and its commands are not
 * implemented yet.
 * Returns the process exit code — `main.ts` is the only place that applies it.
 */
export function run(_argv: readonly string[], io: CliIo = processIo): number {
  io.stderr(
    `rune ${RUNE_CLI_VERSION} (engine ${RUNE_VERSION}) — milestone 1 in progress; commands are not implemented yet`,
  );
  return 0;
}
