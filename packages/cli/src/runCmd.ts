/**
 * `rune run` (docs/architecture.md §4.1, §9.3, §10).
 *
 * This module drives interactive and non-interactive runs through the same Session/engine
 * path, with a TTY selecting interactive mode unless `--non-interactive` is specified.
 */

import { randomUUID } from 'node:crypto';

import {
  CHROME_CATALOG,
  CancelledError,
  EXIT_CODE_BY_STATUS,
  RESULT_SCHEMA_VERSION,
  exitCodeFor,
  RUNE_VERSION,
  RuneError,
  Session,
  UsageError,
  formatChrome,
  serializeResult,
  writeResult,
} from '@rune/engine';
import type { RunMode, RunResult, RunStatus, StringTable } from '@rune/engine';

import { parseOverrides, parsePlatform } from './args.js';
import { ExitWithCode, type CliIo } from './io.js';
import {
  cliPromptPresenters,
  Prompter,
  promptForInputs,
  summaryLoop,
  type Interaction,
} from './prompt.js';
import { progressObserver, renderOutcome, renderPlan, renderWarnings } from './render.js';

export interface RunFlags {
  readonly nonInteractive?: boolean | undefined;
  readonly dryRun?: boolean | undefined;
  readonly set?: readonly string[] | undefined;
  readonly values?: readonly string[] | undefined;
  readonly result?: string | undefined;
  readonly logFile?: string | undefined;
  readonly locale?: string | undefined;
  readonly platform?: string | undefined;
}

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

  // Interactive is the TTY default (§4.1); no TTY auto-degrades to non-interactive (§10).
  const interactive = flags.nonInteractive !== true && interaction.isTTY;
  const mode: RunMode = interactive ? 'interactive' : 'non-interactive';

  let session: Session | undefined;
  let strings: StringTable | undefined;
  let prompter: Prompter | undefined;
  let removeExecutionSignalHandlers: (() => void) | undefined;
  try {
    session = await Session.open(manifestPath, {
      values: flags.values ?? [],
      overrides: parseOverrides(flags.set ?? []),
      locale: flags.locale,
      logFile: flags.logFile,
      mode,
      ...(platform === undefined ? {} : { platform }),
    });
    cliPromptPresenters.assertPresentable(session.allInputs());
    strings = session.getStrings();
    if (interactive) {
      prompter = new Prompter(interaction, strings.chrome('rune.prompt.inputEnded'));
    }

    if (prompter !== undefined) {
      await promptForInputs(session, prompter);
      if (flags.dryRun !== true && (await summaryLoop(session, prompter, io)) === 'cancel') {
        throw new CancelledError(strings.chrome('rune.run.cancelledAtSummary'));
      }
      // The prompt phase is over; the input stream is released before anything executes.
      prompter.close();
    }

    let result: RunResult;
    if (flags.dryRun === true) {
      result = session.describe();
    } else {
      removeExecutionSignalHandlers = installExecutionSignalHandlers(
        session,
        strings,
        io,
        interaction,
      );
      result = await session.execute(progressObserver(strings, io));
    }

    // With `--result -` the JSON owns stdout; the human plan would contaminate it (§10).
    if (flags.dryRun === true && flags.result !== '-') {
      renderPlan(result, strings, io);
    }
    renderOutcome(result, session.warnings(), strings, io);
    if (flags.result !== undefined) {
      deliverResult(result, flags.result, strings, io);
    }
    if (result.exitCode !== 0) {
      throw new ExitWithCode(result.exitCode);
    }
  } catch (error) {
    if (error instanceof ExitWithCode) {
      throw error;
    }
    const plannedCancellation =
      error instanceof RuneError ? cancelledWithPlan(session, error) : undefined;
    if (plannedCancellation !== undefined && session !== undefined && strings !== undefined) {
      renderWarnings(session.warnings(), strings, io);
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
        plannedCancellation ?? failureShell({ session, code, manifestPath, flags, mode }),
        flags.result,
        strings,
        io,
      );
      throw new ExitWithCode(code);
    }
    throw error;
  } finally {
    removeExecutionSignalHandlers?.();
    prompter?.close();
  }
}

/**
 * Installs the §7/§9.3 cancel flow: the first SIGINT and the platform termination
 * signal (POSIX SIGTERM, Windows SIGBREAK) fire the same CancelToken path. Repeated
 * termination signals stay idempotent; only a second SIGINT force-quits.
 */
function installExecutionSignalHandlers(
  session: Session,
  strings: StringTable,
  io: CliIo,
  interaction: Interaction,
): () => void {
  const signalSource = interaction.signalSource ?? process;
  const terminationSignal = process.platform === 'win32' ? 'SIGBREAK' : 'SIGTERM';
  let cancellationRequested = false;
  let sigintCount = 0;

  const requestCancel = (): void => {
    if (cancellationRequested) {
      return;
    }
    cancellationRequested = true;
    io.stderr(strings.chrome('rune.run.cancelling'));
    session.cancel();
  };
  const onSigint = (): void => {
    sigintCount += 1;
    if (sigintCount >= 2) {
      interaction.forceExit(6);
      return;
    }
    requestCancel();
  };
  const onTerminationSignal = (): void => {
    requestCancel();
  };

  signalSource.on('SIGINT', onSigint);
  signalSource.on(terminationSignal, onTerminationSignal);

  return () => {
    signalSource.removeListener('SIGINT', onSigint);
    signalSource.removeListener(terminationSignal, onTerminationSignal);
  };
}

/** `--result -` prints to stdout; anything else is a path the engine writes atomically. */
function deliverResult(
  result: RunResult,
  destination: string,
  strings: StringTable | undefined,
  io: CliIo,
): void {
  if (destination === '-') {
    io.stdout(serializeResult(result).replace(/\n$/, ''));
    return;
  }
  writeResult(result, destination);
  if (strings === undefined) {
    const template = CHROME_CATALOG.get('rune.result.written');
    if (template !== undefined) {
      io.stderr(formatChrome(template, { path: destination }));
    }
    return;
  }
  io.stderr(strings.chrome('rune.result.written', { path: destination }));
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

/**
 * The result file of a run that never happened (§10): the failing status with zero
 * counters — honest about the fact that the pipeline refused before any plan existed.
 */
function failureShell(options: {
  session: Session | undefined;
  code: number;
  manifestPath: string;
  flags: RunFlags;
  mode: RunMode;
}): RunResult {
  const { session, code, flags } = options;
  const now = new Date().toISOString();
  const host = process.platform === 'win32' ? 'windows' : 'linux';
  const platform =
    flags.platform === 'windows' || flags.platform === 'linux' ? flags.platform : host;
  return {
    resultSchemaVersion: RESULT_SCHEMA_VERSION,
    id: randomUUID(),
    status: statusForExit(code),
    exitCode: code,
    mode: options.mode,
    dryRun: flags.dryRun === true,
    crossPlatformPreview: platform !== host,
    platform,
    locale: session?.getStrings().locale ?? null,
    startedAt: now,
    finishedAt: now,
    durationMs: 0,
    runeVersion: RUNE_VERSION,
    // A manifest that failed to parse has no product to report; empty identity says so.
    product:
      session === undefined
        ? { name: '', version: '' }
        : { name: session.manifest.product.name, version: session.manifest.product.version },
    manifestPath: options.manifestPath,
    stepsTotal: 0,
    stepsExecuted: 0,
    stepsSucceeded: 0,
    stepsFailed: 0,
    stepsCancelled: 0,
    stepsSkipped: 0,
    stepsNotRun: 0,
    nothingExecuted: true,
    inputs: [],
    steps: [],
  };
}

/** The §10 table read backwards: every exit code implies exactly one status. */
function statusForExit(code: number): RunStatus {
  for (const [status, exit] of Object.entries(EXIT_CODE_BY_STATUS)) {
    if (exit === code && status !== 'planned' && status !== 'succeeded') {
      return status as RunStatus;
    }
  }
  return 'internal_error';
}
