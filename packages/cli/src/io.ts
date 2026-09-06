/**
 * The CLI's I/O seam and control-flow helpers — a leaf module, so the commands and the
 * program wiring can share them without a cycle.
 */

import {
  formatRuneError,
  formatSessionTerminalLine,
  type CancelToken,
  type RuneError,
  type StringTable,
} from '@rune/engine';

/** Minimal I/O seam so the CLI can be exercised in tests without touching process streams. */
export interface CliIo {
  /** Requested machine output only (§10): result JSON, plans, reports, schemas. */
  stdout(line: string): void;
  /** Progress, prompts, diagnostics, warnings. */
  stderr(line: string): void;
}

/** Optional process control supplied by the executable host. */
export interface CliControl {
  readonly cancel?: CancelToken;
  readonly onInterrupt?: () => void;
}

/** Mirrors the engine log sink's visible control escaping for one composed human line. */
export function escapeTerminalText(text: string): string {
  let escaped = '';
  for (const character of text) {
    const codePoint = character.codePointAt(0)!;
    if (codePoint <= 0x1f) {
      escaped += JSON.stringify(character).slice(1, -1);
    } else if (
      (codePoint >= 0x7f && codePoint <= 0x9f) ||
      codePoint === 0x2028 ||
      codePoint === 0x2029
    ) {
      escaped += `\\u${codePoint.toString(16).padStart(4, '0')}`;
    } else {
      escaped += character;
    }
  }
  return escaped;
}

/** Writes one fully composed human line to stdout after terminal escaping. */
export function humanStdout(io: CliIo, text: string): void {
  io.stdout(escapeTerminalText(text));
}

/** Writes one fully composed human line to stderr after terminal escaping. */
export function humanStderr(io: CliIo, text: string): void {
  io.stderr(escapeTerminalText(text));
}

/** Writes one fully composed session line to stdout through its live terminal projector. */
export function sessionHumanStdout(io: CliIo, strings: StringTable, text: string): void {
  io.stdout(formatSessionTerminalLine(strings, text));
}

/** Writes one fully composed session line to stderr through its live terminal projector. */
export function sessionHumanStderr(io: CliIo, strings: StringTable, text: string): void {
  io.stderr(formatSessionTerminalLine(strings, text));
}

/**
 * Writes the engine-formatted diagnostic without rebuilding or re-escaping its composition.
 * Its issue data is control-escaped, its aggregate separators are physical, and projected errors
 * retain the mask applied after full composition.
 */
export function runeErrorStderr(io: CliIo, error: RuneError): void {
  io.stderr(formatRuneError(error));
}

/** Thrown by commands that finished with a known exit code that is not an error to report. */
export class ExitWithCode extends Error {
  constructor(readonly code: number) {
    super(`exit ${code}`);
  }
}
