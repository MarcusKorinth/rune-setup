/**
 * The `rune` command line (docs/architecture.md §4.1, §10).
 *
 * One commander program with `exitOverride()` — RUNE, not the parser, decides exit codes,
 * and `main.ts` is the only `process.exit` site. Stream discipline: stdout carries only
 * requested machine output; everything else goes to stderr.
 */

import { Command, CommanderError } from 'commander';

import { exitCodeFor, RuneError, RUNE_VERSION } from '@rune/engine';

import { guiInstallCommand } from './guiCmd.js';
import {
  escapeTerminalText,
  ExitWithCode,
  runeErrorStderr,
  type CliControl,
  type CliIo,
} from './io.js';
import type { Interaction } from './prompt.js';
import { runCommand, type RunFlags } from './runCmd.js';
import { schemaCommand } from './schemaCmd.js';
import { validateCommand } from './validateCmd.js';

/**
 * Version of the CLI package — what `rune` reports about itself. `@rune/cli` and
 * `@rune/engine` are versioned independently, so the banner (and `rune --version`)
 * must not borrow the engine's number. Pinned to `packages/cli/package.json` by
 * `tests/package-versions.test.ts`.
 */
export const RUNE_CLI_VERSION = '0.1.0';

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

const processInteraction: Interaction = {
  input: process.stdin,
  isTTY: process.stdin.isTTY === true,
  write: (text) => {
    process.stderr.write(text);
  },
};

/** Runs the CLI for one argv; returns the process exit code (§10 table). */
export async function run(
  argv: readonly string[],
  io: CliIo = processIo,
  controlOrInteraction: CliControl | Interaction = {},
  suppliedInteraction?: Interaction,
): Promise<number> {
  // The third-argument Interaction form is kept for the scripted frontend contract tests;
  // executable hosts pass process control there and may inject their guarded prompt stream fourth.
  const legacyInteraction = isInteraction(controlOrInteraction) ? controlOrInteraction : undefined;
  const control: CliControl = isInteraction(controlOrInteraction) ? {} : controlOrInteraction;
  const interaction = suppliedInteraction ?? legacyInteraction ?? processInteraction;
  // Which stream commander last wrote to. It is the discriminator §10 actually cares about —
  // a page on stdout was requested, a message on stderr was not — and unlike commander's own
  // exit code it depends on this invocation alone (`Command.help()` derives that code from the
  // ambient `process.exitCode`, so the `help` verb would inherit whatever the host had set).
  let commanderStream: 'out' | 'err' | undefined;
  const program = new Command('rune');
  program
    .description('One manifest. Guided or automated.')
    .version(`rune ${RUNE_CLI_VERSION} (engine ${RUNE_VERSION})`, '--version')
    .exitOverride()
    .configureOutput({
      writeOut: (text) => {
        commanderStream = 'out';
        io.stdout(projectCommanderLayout(text));
      },
      writeErr: (text) => {
        commanderStream = 'err';
        io.stderr(projectCommanderLayout(text));
      },
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
    .command('gui')
    .description('manage the GUI shell')
    .command('install')
    .description('fetch the prebuilt GUI shell for this engine version into the per-user cache')
    .action(async () => {
      await guiInstallCommand(io);
    });

  program
    .command('run')
    .description('run a manifest — guided or automated')
    .argument('<manifest>', 'path to the manifest file')
    .option('--gui', 'run the graphical wizard from the installed GUI shell')
    .option('--non-interactive', 'never prompt; missing required inputs fail')
    .option('--dry-run', 'render the plan and execute nothing')
    .option('--set <key=value>', 'set an input (layer 4)', collect, [])
    .option('--values <file>', 'values file (layer 2)', collect, [])
    .option('--result <path>', 'write the result file here (- for stdout)')
    .option('--log-file <path>', 'write the run log here')
    .option('--locale <tag>', 'display locale')
    .option('--platform <platform>', 'preview a foreign platform (dry-run only)')
    .action(async (manifest: string, flags: RunFlags) => {
      await runCommand(manifest, flags, io, control, interaction);
    });

  try {
    await program.parseAsync([...argv], { from: 'user' });
    return 0;
  } catch (error) {
    return report(error, io, commanderStream);
  }
}

function isInteraction(value: CliControl | Interaction): value is Interaction {
  return 'input' in value && 'isTTY' in value && 'write' in value;
}

/**
 * One exit-code decision (§10): a carried code passes through, a parser error is CLI misuse
 * (2), and every other throwable — a RuneError or not — is mapped by the engine's exitCodeFor.
 */
function report(error: unknown, io: CliIo, commanderStream?: 'out' | 'err'): number {
  if (error instanceof ExitWithCode) {
    return error.code;
  }
  if (error instanceof RuneError) {
    runeErrorStderr(io, error);
    return exitCodeFor(error);
  }
  if (error instanceof CommanderError) {
    // commander already printed through configureOutput, and the stream it chose is the verdict:
    // a help or version page on stdout is requested output (exit 0), while every parser error
    // and the bare invocation explain themselves on stderr (exit 2, §10). Commander's own
    // `code` cannot tell the `help` verb from a bare invocation — it throws `commander.help` for
    // both — and its `exitCode` is derived from the ambient `process.exitCode` for that verb, so
    // neither is a property of this invocation. A CommanderError that printed nothing is misuse.
    return commanderStream === 'out' ? 0 : 2;
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
