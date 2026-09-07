/**
 * `rune run` (docs/architecture.md §4.1, §9.3, §10).
 *
 * Interactive and non-interactive runs share the same Session pipeline. A TTY selects the
 * guided prompt/summary flow unless `--non-interactive` is present.
 */

import { resolve } from 'node:path';

import {
  CancelledError,
  createFailureResult,
  ExecutionError,
  exitCodeFor,
  formatSessionTerminalLine,
  InternalError,
  PlatformError,
  RESULT_LOG_COLLISION_MESSAGE,
  RuneError,
  sameSinkPath,
  serializeResult,
  Session,
  UsageError,
  writeResult,
} from '@rune/engine';
import type { ExecutionPlan, RunMode, RunResult, StringTable } from '@rune/engine';

import { parseOverrides, parsePlatform, type RunFlags } from './args.js';
import { launchGui } from './guiCmd.js';
import {
  ExitWithCode,
  humanStderr,
  runeErrorStderr,
  sessionHumanStderr,
  type CliControl,
  type CliIo,
} from './io.js';
import { progressObserver, renderOutcome, renderPlan } from './render.js';
import {
  cliPromptPresenters,
  Prompter,
  promptForInputs,
  summaryLoop,
  type Interaction,
} from './prompt.js';

export type { RunFlags } from './args.js';

export async function runCommand(
  manifestPath: string,
  flags: RunFlags,
  io: CliIo,
  controlOrInteraction: CliControl | Interaction,
  suppliedInteraction?: Interaction,
): Promise<void> {
  const legacyInteraction = isInteraction(controlOrInteraction) ? controlOrInteraction : undefined;
  const control: CliControl = isInteraction(controlOrInteraction) ? {} : controlOrInteraction;
  const interaction = suppliedInteraction ?? legacyInteraction;
  if (interaction === undefined) {
    throw new InternalError('the run driver requires an interaction boundary');
  }
  // Session.open anchors relative manifest paths to the invocation cwd, against the same cwd
  // this reads: nothing awaits in between. Preserve that identity for an early open failure,
  // while the session itself keeps the operator's spelling for the lines that name it (§10).
  const absoluteManifestPath = resolve(manifestPath);
  // The engine resolves result paths when it writes them. Anchor relative destinations
  // before any async work or observer callbacks can change the process working directory.
  const resultOption = flags.result;
  const resultDestination =
    resultOption === undefined
      ? undefined
      : {
          path: resultOption === '-' ? '-' : resolve(resultOption),
          announcement: resultOption,
        };
  const interactive = flags.gui !== true && flags.nonInteractive !== true && interaction.isTTY;
  const mode: RunMode =
    flags.gui === true ? 'gui' : interactive ? 'interactive' : 'non-interactive';
  let platform: ReturnType<typeof parsePlatform> = undefined;
  let session: Session | undefined;
  let strings: StringTable | undefined;
  let plan: ExecutionPlan | undefined;
  let prompter: Prompter | undefined;
  let executionFailureResult: RunResult | undefined;
  let deliveryStarted = false;
  try {
    if (flags.platform !== undefined && flags.dryRun !== true) {
      throw new UsageError('--platform previews a plan and combines only with --dry-run');
    }
    platform = parsePlatform(flags.platform);
    // An empty path would resolve to the invocation cwd and fail only at execution setup.
    if (flags.logFile === '') {
      throw new UsageError('--log-file needs a non-empty path');
    }
    // A values-file diagnostic keeps the operator's own spelling, which names nothing when
    // that spelling is empty: the reader would see a location and a message without a path.
    if ((flags.values ?? []).includes('')) {
      throw new UsageError('--values needs a non-empty path');
    }
    // A real run that names a file for its result is the only invocation §4.1's collision rule
    // governs: a dry run never opens the log, and `--result -` names no file.
    const deliveredPath =
      flags.dryRun !== true && resultDestination !== undefined && resultDestination.path !== '-'
        ? resultDestination.path
        : undefined;
    // The flag spelling of the collision is an argument-level fact, so refuse it before the
    // session exists: a manifest that never parses configures no log file, and that invocation
    // would otherwise deliver its failure result onto the path the operator designated as the
    // log (§4.1). Session.open anchors this flag against the same cwd, and nothing awaits in
    // between. The manifest's own execution.logFile needs the engine's anchoring, so the engine
    // refuses that half itself, from the destination handed to open below.
    if (
      deliveredPath !== undefined &&
      flags.logFile !== undefined &&
      flags.logFile !== '' &&
      sameSinkPath(deliveredPath, resolve(flags.logFile))
    ) {
      throw new UsageError(RESULT_LOG_COLLISION_MESSAGE);
    }

    if (flags.gui === true) {
      if (flags.nonInteractive === true || flags.dryRun === true) {
        throw new UsageError('--gui combines with neither --non-interactive nor --dry-run');
      }
      if (resultOption === '-') {
        throw new UsageError('--gui has no stdout contract; use --result <path>');
      }
      const overrides = parseOverrides(flags.set ?? []);
      try {
        await launchGui(manifestPath, flags, io, interaction, control);
      } catch (error) {
        if (!(error instanceof CancelledError)) {
          throw error;
        }
        // The shell has not started, so the CLI validates the invocation before it owns the
        // cancellation outcome. Execution remains exclusively in the shell on ordinary GUI
        // launches.
        session = await Session.open(manifestPath, {
          mode: 'gui',
          values: flags.values ?? [],
          overrides,
          locale: flags.locale,
          logFile: flags.logFile,
          ...(resultDestination === undefined ? {} : { resultDestination: resultDestination.path }),
        });
        strings = session.getStrings();
        if (resultDestination !== undefined) {
          const result = createFailureResult({
            error,
            manifestPath: absoluteManifestPath,
            dryRun: false,
            mode: 'gui',
            session,
          });
          deliveryStarted = true;
          await deliverResult(result, resultDestination, io, strings);
        }
        throw new ExitWithCode(6);
      }
      return;
    }

    session = await Session.open(manifestPath, {
      mode,
      values: flags.values ?? [],
      overrides: parseOverrides(flags.set ?? []),
      locale: flags.locale,
      logFile: flags.logFile,
      ...(platform === undefined ? {} : { platform }),
      ...(deliveredPath === undefined ? {} : { resultDestination: deliveredPath }),
    });
    strings = session.getStrings();

    if (interactive) {
      cliPromptPresenters.assertPresentable(session.allInputs());
      prompter = new Prompter(
        interaction,
        formatSessionTerminalLine(strings, strings.chrome('rune.prompt.inputEnded')),
        control.cancel,
        control.onInterrupt,
      );
      await promptForInputs(session, prompter);
    }

    plan = session.plan();
    if (
      prompter !== undefined &&
      flags.dryRun !== true &&
      (await summaryLoop(
        session,
        prompter,
        io,
        {
          manifestPath,
          logFile: session.effectiveLogFile?.announcement,
        },
        (currentPlan) => {
          plan = currentPlan;
        },
      )) === 'cancel'
    ) {
      throw new CancelledError(
        formatSessionTerminalLine(strings, strings.chrome('rune.run.cancelledAtSummary')),
      );
    }
    // Nothing after this point reads answers. Release stdin before execution starts.
    prompter?.close();
    prompter = undefined;
    if (flags.dryRun === true && control.cancel?.isCancelled === true) {
      throw new CancelledError();
    }
    const progress = progressObserver(io, strings);
    const result =
      flags.dryRun === true
        ? session.describe()
        : await session.execute((event) => {
            // Session publishes a post-execution sink failure as the sole terminal event
            // before rejecting. Capture first so a broken renderer cannot hide the result.
            if (event.kind === 'runFinished') {
              executionFailureResult = event.result;
            }
            progress(event);
          }, control.cancel);
    // A returned execution owns its normal result path. The captured terminal result is
    // retained only while execute() is in flight, for a finalization failure that rejects.
    executionFailureResult = undefined;

    // With `--result -` the JSON owns stdout; the human plan would contaminate it (§10).
    if (flags.dryRun === true && resultOption !== '-') {
      // The plan carries anchored paths; the preview names the spellings the operator
      // supplied, because those are the ones a secret registry can hold (§10). The session
      // publishes that spelling beside the anchored one, so the precedence is read, not redone.
      renderPlan(
        plan,
        session.manifest.product,
        {
          manifestPath,
          logFile: session.effectiveLogFile?.announcement,
        },
        io,
        strings,
      );
    }
    if (resultDestination !== undefined) {
      deliveryStarted = true;
      await deliverResult(result, resultDestination, io, strings);
    }
    renderOutcome(result, session.warnings(), io, strings);
    if (result.exitCode !== 0) {
      throw new ExitWithCode(result.exitCode);
    }
  } catch (error) {
    // Once delivery starts, its sink owns the failure. Retrying here could write the same
    // destination or stdout twice, and a broken writer cannot reliably report itself.
    if (deliveryStarted) {
      throw error;
    }
    if (error instanceof ExitWithCode) {
      throw error;
    }
    // The result file is written on every outcome the run owns — manifest, input,
    // resolution, cancellation, internal — only usage errors skip it (§10).
    if (!(error instanceof UsageError) && !(error instanceof PlatformError)) {
      const failure =
        error instanceof RuneError
          ? error
          : new InternalError('an unexpected error escaped the run pipeline', { cause: error });
      runeErrorStderr(io, failure);
      const result =
        executionFailureResult ??
        createFailureResult({
          error: failure,
          manifestPath: absoluteManifestPath,
          dryRun: flags.dryRun === true,
          mode,
          ...(platform === undefined ? {} : { platform }),
          ...(session === undefined ? {} : { session }),
          ...(plan === undefined ? {} : { plan }),
        });
      // Only a completed plan carries the full derived-secret masker. Before then the projected
      // diagnostic above is the only safe human output from an opened Session; still deliver the
      // machine result, but do not compose locale, warning, or path-announcement fallback lines.
      const renderFallback =
        plan !== undefined || (result.status === 'config_error' && result.product === null);
      if (resultDestination !== undefined) {
        deliveryStarted = true;
        await deliverResult(
          result,
          resultDestination,
          io,
          renderFallback ? strings : undefined,
          renderFallback,
        );
      }
      if (renderFallback) {
        renderOutcome(result, session?.warnings() ?? [], io, strings);
      }
      throw new ExitWithCode(result.exitCode);
    }
    throw error;
  } finally {
    prompter?.close();
  }
}

function isInteraction(value: CliControl | Interaction): value is Interaction {
  return 'input' in value && 'isTTY' in value && 'write' in value;
}

/** `--result -` prints to stdout; anything else is a path the engine writes atomically. */
async function deliverResult(
  result: RunResult,
  destination: { readonly path: string; readonly announcement: string },
  io: CliIo,
  strings?: StringTable,
  announce = true,
): Promise<void> {
  if (destination.path === '-') {
    // The same validated text the file sink writes; the stdout seam appends the newline.
    io.stdout(serializeResult(result).replace(/\n$/u, ''));
    return;
  }
  try {
    // Write to the anchored path, but report the operator's spelling: `resolve` above may
    // have normalized separators or segments away, and only the spelling they typed is the
    // one a secret registry holds — the success line below names exactly that spelling.
    await writeResult(result, destination.path, { announcement: destination.announcement });
  } catch (error) {
    if (!(error instanceof ExecutionError) || error.code !== 'RUNE-407') {
      throw error;
    }
    reportDeliveryFailure(error, io, strings, announce);
    throw new ExitWithCode(exitCodeFor(error));
  }
  if (!announce) {
    return;
  }
  if (strings === undefined) {
    humanStderr(io, `result written to ${destination.announcement}`);
  } else {
    sessionHumanStderr(
      io,
      strings,
      strings.chrome('rune.result.written', { path: destination.announcement }),
    );
  }
}

/**
 * RUNE-407 is raised host-side, so no engine projection masks it, and its message names the
 * destination — a value the session may hold as a secret. Render it exactly like the success
 * line for the same path: through the session's terminal projector, the CLI's only masking sink.
 * The projector needs the raw message: its first mask is the only one that can see a secret
 * spelled with a control character, and formatRuneError would already have escaped that
 * character away. RUNE-407 carries one locationless issue, so both render the same line.
 * Without a StringTable the path may be named only where no secret can have been registered.
 */
function reportDeliveryFailure(
  error: ExecutionError,
  io: CliIo,
  strings: StringTable | undefined,
  safeToCompose: boolean,
): void {
  if (strings !== undefined) {
    sessionHumanStderr(io, strings, error.message);
  } else if (safeToCompose) {
    // The manifest never parsed, so no secret candidate exists: the path is plain argv.
    runeErrorStderr(io, error);
  } else {
    // A failed open may have registered secret candidates without returning the session's
    // StringTable; like the suppressed announcement, a line naming the path cannot be masked.
    humanStderr(io, 'could not write the result file');
  }
}
