/**
 * The CLI's I/O seam and control-flow helpers — a leaf module, so the commands and the
 * program wiring can share them without a cycle.
 */

/** Minimal I/O seam so the CLI can be exercised in tests without touching process streams. */
export interface CliIo {
  /** Requested machine output only (§10): result JSON, plans, reports, schemas. */
  stdout(line: string): void;
  /** Progress, prompts, diagnostics, warnings. */
  stderr(line: string): void;
}

/** Thrown by commands that finished with a known exit code that is not an error to report. */
export class ExitWithCode extends Error {
  constructor(readonly code: number) {
    super(`exit ${code}`);
  }
}
