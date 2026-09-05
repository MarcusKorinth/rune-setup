/**
 * The CLI's process wiring (docs/architecture.md §10, stream discipline).
 *
 * Everything the automation contract decides about the process streams lives here rather than in
 * `main.ts`, which owns the process itself — argv, the real streams, the signal handlers and the
 * single `process.exit` site. A test can therefore drive one full run against its own writable
 * streams and observe the effective exit code, the guarded writers and the lost-sink line.
 */

import type { Writable } from 'node:stream';

import { INTERNAL_EXIT_CODE } from '@rune/engine';

import { run } from './cli.js';
import type { CliControl } from './io.js';
import { guardStream } from './streams.js';

/** The process streams the run writes to; each one is guarded on its own. */
export interface BootstrapStreams {
  readonly stdout: Writable;
  readonly stderr: Writable;
}

export interface BootstrapOptions {
  /**
   * Process control the executable host owns (cancellation). Required, so a host cannot drop
   * the token and silently turn its first `Ctrl+C` into a run that finishes regardless.
   */
  readonly control: CliControl;
  /**
   * Publishes an exit code decided after this call resolved: a stdout sink can report its loss
   * once the run has already returned its own code, and the caller has taken it. Required, so
   * a host cannot drop the hook and silently turn a lost sink back into a false success.
   */
  readonly setExitCode: (code: number) => void;
}

/**
 * Runs one argv against guarded process streams and returns the effective exit code.
 *
 * A consumer that closes stdout or stderr early ends RUNE's output on that stream and nothing
 * else: the run's exit code stands and no stack trace reaches the terminal (§10). Any other
 * stdout error has lost requested machine output, and exit 0 would then be a false success
 * signal on the automation contract: one fixed line — never the stream error itself — and the
 * internal-error code. The hook publishes that code itself because the error may arrive after
 * run() has resolved; stderr diagnostics stay best-effort and never change the exit code.
 */
export async function bootstrap(
  argv: readonly string[],
  streams: BootstrapStreams,
  options: BootstrapOptions,
): Promise<number> {
  const stderr = guardStream(streams.stderr);
  const stdout = guardStream(streams.stdout, () => {
    stderr.writeLine('could not write the requested machine output to stdout');
    options.setExitCode(INTERNAL_EXIT_CODE);
  });
  const code = await run(
    argv,
    { stdout: stdout.writeLine, stderr: stderr.writeLine },
    options.control,
  );
  return stdout.failure() === undefined ? code : INTERNAL_EXIT_CODE;
}
