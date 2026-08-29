/**
 * `rune run` (docs/architecture.md §4.1, §9.3, §10).
 *
 * This PR ships the non-interactive driver — the parity anchor — and `--dry-run`. The
 * interactive prompter arrives with the next milestone slice; until then a TTY without
 * `--non-interactive` follows the same non-interactive path.
 */

import {
  CancelledError,
  exitCodeFor,
  failureResult,
  RuneError,
  Session,
  UsageError,
  serializeResult,
  writeResult,
} from '@rune/engine';
import type { RunMode, RunResult } from '@rune/engine';

import { parseOverrides, parsePlatform, type RunFlags } from './args.js';

export type { RunFlags } from './args.js';
import { launchGui } from './guiCmd.js';
import { ExitWithCode, type CliIo } from './io.js';
import { Prompter, promptForInputs, summaryLoop, type Interaction } from './prompt.js';
import { progressObserver, renderOutcome, renderPlan } from './render.js';

export async function runCommand(
  manifestPath: string,
  flags: RunFlags,
  io: CliIo,
  interaction: Interaction,
): Promise<void> {
  if (flags.platform !== undefined && flags.dryRun !== true) {
    throw new UsageError('--platform previews a plan and combines only with --dry-run');
  }
  const platform = parsePlatform(flags.platform);

  if (flags.gui === true) {
    // The GUI never combines with headless or preview modes, and carries no stdout
    // contract (paragraphs 4.1, 9.4).
    if (flags.nonInteractive === true || flags.dryRun === true) {
      throw new UsageError('--gui combines with neither --non-interactive nor --dry-run');
    }
    if (flags.result === '-') {
      throw new UsageError('--gui has no stdout contract; use --result <path>');
    }
    // Malformed --set is the same CLI misuse in every mode: exit 2 here, never a shell
    // crash there.
    parseOverrides(flags.set ?? []);
    await launchGui(manifestPath, flags, io, interaction);
    return;
  }

  // Interactive is the TTY default (§4.1); no TTY auto-degrades to non-interactive (§10).
  const interactive = flags.nonInteractive !== true && interaction.isTTY;
  const mode: RunMode = interactive ? 'interactive' : 'non-interactive';
  const prompter = interactive ? new Prompter(interaction) : undefined;

  let session: Session | undefined;
  try {
    session = await Session.open(manifestPath, {
      values: flags.values ?? [],
      overrides: parseOverrides(flags.set ?? []),
      locale: flags.locale,
      logFile: flags.logFile,
      mode,
      ...(platform === undefined ? {} : { platform }),
    });

    if (prompter !== undefined) {
      await promptForInputs(session, prompter);
      if (flags.dryRun !== true && (await summaryLoop(session, prompter, io)) === 'cancel') {
        throw new CancelledError('cancelled at the summary');
      }
      // The prompt phase is over; the input stream is released before anything executes.
      prompter.close();
    }

    const result =
      flags.dryRun === true
        ? session.describe()
        : await executeWithCancel(session, io, interaction);

    // With `--result -` the JSON owns stdout; the human plan would contaminate it (§10).
    if (flags.dryRun === true && flags.result !== '-') {
      renderPlan(result, io);
    }
    renderOutcome(result, session.warnings(), io);
    if (flags.result !== undefined) {
      deliverResult(result, flags.result, io);
    }
    if (result.exitCode !== 0) {
      throw new ExitWithCode(result.exitCode);
    }
  } catch (error) {
    if (error instanceof ExitWithCode) {
      throw error;
    }
    // The result file is written on every outcome the run owns — manifest, input,
    // resolution, cancellation, internal — only usage errors skip it (§10).
    if (
      error instanceof RuneError &&
      !(error instanceof UsageError) &&
      flags.result !== undefined
    ) {
      io.stderr(error.message);
      const code = exitCodeFor(error);
      deliverResult(
        cancelledWithPlan(session, error) ??
          failureShell({ session, code, manifestPath, flags, mode }),
        flags.result,
        io,
      );
      throw new ExitWithCode(code);
    }
    throw error;
  } finally {
    prompter?.close();
  }
}

/**
 * Runs with the §9.3 cancel flow: the first Ctrl+C fires the CancelToken (the interrupted
 * step becomes CANCELLED, the run exits 6 through the ordinary path), a second force-quits.
 */
async function executeWithCancel(
  session: Session,
  io: CliIo,
  interaction: Interaction,
): Promise<RunResult> {
  let cancelledOnce = false;
  const onSigint = (): void => {
    if (cancelledOnce) {
      interaction.forceExit(6);
      return;
    }
    cancelledOnce = true;
    io.stderr(session.getStrings().chrome('rune.run.cancelling'));
    session.cancel();
  };
  process.on('SIGINT', onSigint);
  try {
    return await session.execute(progressObserver(io));
  } finally {
    process.removeListener('SIGINT', onSigint);
  }
}

/** `--result -` prints to stdout; anything else is a path the engine writes atomically. */
function deliverResult(result: RunResult, destination: string, io: CliIo): void {
  if (destination === '-') {
    io.stdout(serializeResult(result).replace(/\n$/, ''));
    return;
  }
  writeResult(result, destination);
  io.stderr(`result written to ${destination}`);
}

/**
 * A cancellation after the plan existed — the summary's Cancel — reports that plan: all
 * pending steps NOT_RUN, inputs listed (§10's cancelled row). Anything else falls back to
 * the zero-counter shell below.
 */
function cancelledWithPlan(session: Session | undefined, error: RuneError): RunResult | undefined {
  if (!(error instanceof CancelledError) || session === undefined) {
    return undefined;
  }
  try {
    return session.describeCancelled();
  } catch {
    // Cancelled while inputs were still missing: no plan can exist — the shell is honest.
    return undefined;
  }
}

/** The §10 zero-counter shell, built by the engine's one function for both hosts. */
function failureShell(options: {
  session: Session | undefined;
  code: number;
  manifestPath: string;
  flags: RunFlags;
  mode: RunMode;
}): RunResult {
  const { session, code, flags } = options;
  return failureResult({
    exitCode: code,
    mode: options.mode,
    manifestPath: options.manifestPath,
    dryRun: flags.dryRun === true,
    platform: flags.platform,
    locale: session?.getStrings().locale ?? null,
    product:
      session === undefined
        ? undefined
        : { name: session.manifest.product.name, version: session.manifest.product.version },
  });
}
