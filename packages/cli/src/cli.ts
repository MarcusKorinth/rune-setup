/**
 * The `rune` command line (docs/architecture.md §4.1, §10).
 *
 * One commander program with `exitOverride()` — RUNE, not the parser, decides exit codes,
 * and `main.ts` is the only `process.exit` site. Stream discipline: stdout carries only
 * requested machine output; everything else goes to stderr.
 */

import { Command, CommanderError } from 'commander';

import { exitCodeFor, RuneError, RUNE_VERSION } from '@rune/engine';

import { ExitWithCode, type CliIo } from './io.js';
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
export type { CliIo } from './io.js';

const processIo: CliIo = {
  stdout: (line) => {
    process.stdout.write(`${line}\n`);
  },
  stderr: (line) => {
    process.stderr.write(`${line}\n`);
  },
};

/** Runs the CLI for one argv; returns the process exit code (§10 table). */
export async function run(argv: readonly string[], io: CliIo = processIo): Promise<number> {
  const program = new Command('rune');
  program
    .description('One manifest. Guided or automated.')
    .version(`rune ${RUNE_CLI_VERSION} (engine ${RUNE_VERSION})`, '--version')
    .exitOverride()
    .configureOutput({
      writeOut: (text) => io.stdout(text.replace(/\n$/, '')),
      writeErr: (text) => io.stderr(text.replace(/\n$/, '')),
    });

  program
    .command('validate')
    .description('validate a manifest and report what it reads')
    .argument('<manifest>', 'path to the manifest file')
    .option('--platform <platform>', 'preview a foreign platform (windows|linux)')
    .option('--locale <tag>', 'display locale')
    .action(async (manifest: string, flags: { platform?: string; locale?: string }) => {
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
    .description('run a manifest — guided or automated')
    .argument('<manifest>', 'path to the manifest file')
    .option('--non-interactive', 'never prompt; missing required inputs fail')
    .option('--dry-run', 'render the plan and execute nothing')
    .option('--set <key=value...>', 'set an input (layer 4)', collect, [])
    .option('--values <file...>', 'values file (layer 2)', collect, [])
    .option('--result <path>', 'write the result file here (- for stdout)')
    .option('--log-file <path>', 'write the run log here')
    .option('--locale <tag>', 'display locale')
    .option('--platform <platform>', 'preview a foreign platform (dry-run only)')
    .action(async (manifest: string, flags: RunFlags) => {
      await runCommand(manifest, flags, io);
    });

  try {
    await program.parseAsync([...argv], { from: 'user' });
    return 0;
  } catch (error) {
    return report(error, io);
  }
}

/** One exit-code decision (§10): RuneError → exitCodeFor; parser errors → 2; rest → 70. */
function report(error: unknown, io: CliIo): number {
  if (error instanceof ExitWithCode) {
    return error.code;
  }
  if (error instanceof RuneError) {
    io.stderr(error.message);
    return exitCodeFor(error);
  }
  if (error instanceof CommanderError) {
    // commander already printed its message through configureOutput; --version and help
    // "fail" parsing with dedicated codes that mean a clean exit.
    return error.code === 'commander.version' || error.code === 'commander.help' ? 0 : 2;
  }
  io.stderr(`internal error: ${error instanceof Error ? error.message : String(error)}`);
  return 70;
}

function collect(value: string, previous: readonly string[]): string[] {
  return [...previous, value];
}
