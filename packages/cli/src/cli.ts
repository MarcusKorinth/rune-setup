/**
 * The `rune` command line (docs/architecture.md §4.1, §10).
 *
 * One commander program with `exitOverride()` — RUNE, not the parser, decides exit codes,
 * and `main.ts` is the only `process.exit` site. Stream discipline: stdout carries only
 * requested machine output; everything else goes to stderr.
 */

import { Command, CommanderError } from 'commander';

import { exitCodeFor, RuneError, RUNE_VERSION } from '@rune/engine';

import {
  escapeTerminalText,
  ExitWithCode,
  runeErrorStderr,
  type CliControl,
  type CliIo,
} from './io.js';
import { runCommand, type RunFlags } from './runCmd.js';
import { schemaCommand } from './schemaCmd.js';
import { validateCommand } from './validateCmd.js';

/**
 * Version of the CLI package — what `rune` reports about itself. `@rune/cli` and
 * `@rune/engine` are versioned independently, so the banner (and `rune --version`)
 * must not borrow the engine's number. Pinned to `packages/cli/package.json` by
 * `tests/package-versions.test.ts`.
 */
export const RUNE_CLI_VERSION = '0.0.0';

export { ExitWithCode } from './io.js';
export type { CliControl, CliIo } from './io.js';

/**
 * Default sink for a host that lets RUNE write to its own process streams. Unguarded on
 * purpose: owning a process stream's `error` event is the host's decision, and this package
 * makes it only where it owns the process — `bootstrap.ts` for the `rune` binary.
 */
const processIo: CliIo = {
  stdout: (line) => {
    process.stdout.write(`${line}\n`);
  },
  stderr: (line) => {
    process.stderr.write(`${line}\n`);
  },
};

/** Runs the CLI for one argv; returns the process exit code (§10 table). */
export async function run(
  argv: readonly string[],
  io: CliIo = processIo,
  control: CliControl = {},
): Promise<number> {
  const program = new Command('rune');
  program
    .description('One manifest. Guided or automated.')
    .version(`rune ${RUNE_CLI_VERSION} (engine ${RUNE_VERSION})`, '--version')
    .exitOverride()
    .configureOutput({
      writeOut: (text) => io.stdout(projectCommanderLayout(text)),
      writeErr: (text) => io.stderr(projectCommanderLayout(text)),
      outputError: (text, write) => write(escapeTerminalText(withoutFinalLf(text))),
    });

  program
    .command('validate')
    .description('validate a manifest and report what it reads')
    .argument('<manifest>', 'path to the manifest file')
    .option('--locale <tag>', 'display locale')
    .action(async (manifest: string, flags: { locale?: string }) => {
      await validateCommand(manifest, flags, io);
    });

  program
    .command('schema')
    .description('print the manifest JSON Schema (or the result-file schema)')
    .option('--output <file>', 'write to a file instead of stdout')
    .option('--result', 'emit the result-file schema instead')
    .action((flags: { output?: string; result?: boolean }) => {
      schemaCommand(flags, io);
    });

  program
    .command('run')
    .description('run a manifest non-interactively')
    .argument('<manifest>', 'path to the manifest file')
    .option('--non-interactive', 'never prompt; missing required inputs fail')
    .option('--dry-run', 'render the plan and execute nothing')
    .option('--set <key=value>', 'set an input (layer 4)', collect, [])
    .option('--values <file>', 'values file (layer 2)', collect, [])
    .option('--result <path>', 'write the result file here (- for stdout)')
    .option('--log-file <path>', 'write the run log here')
    .option('--locale <tag>', 'display locale')
    .option('--platform <platform>', 'preview a foreign platform (dry-run only)')
    .action(async (manifest: string, flags: RunFlags) => {
      await runCommand(manifest, flags, io, control);
    });

  try {
    await program.parseAsync([...argv], { from: 'user' });
    return 0;
  } catch (error) {
    return report(error, io);
  }
}

/**
 * One exit-code decision (§10): a carried code passes through, a parser error is CLI misuse
 * (2), and every other throwable — a RuneError or not — is mapped by the engine's exitCodeFor.
 */
function report(error: unknown, io: CliIo): number {
  if (error instanceof ExitWithCode) {
    return error.code;
  }
  if (error instanceof RuneError) {
    runeErrorStderr(io, error);
    return exitCodeFor(error);
  }
  if (error instanceof CommanderError) {
    // commander already printed through configureOutput, and it distinguishes the two outcomes
    // by `exitCode`, not by `code`: `--version`, `--help` and the `help` verb carry 0, while
    // every parser error and the bare invocation — both of which print to stderr — carry 1.
    // Keying on the code alone would report requested help, delivered on stdout, as CLI misuse.
    return error.exitCode === 0 ? 0 : 2;
  }
  // Unknown throwables may contain resolved input or process data. The run driver keeps the
  // cause internally when it can; this last-resort sink must never echo it verbatim.
  io.stderr('internal error: an unexpected error occurred');
  return exitCodeFor(error);
}

function collect(value: string, previous: readonly string[]): string[] {
  return [...previous, value];
}

/** Escapes each Commander-owned layout line without turning its separators into text. */
function projectCommanderLayout(text: string): string {
  return withoutFinalLf(text).split('\n').map(escapeTerminalText).join('\n');
}

function withoutFinalLf(text: string): string {
  return text.endsWith('\n') ? text.slice(0, -1) : text;
}
