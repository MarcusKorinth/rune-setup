/**
 * `rune run` (docs/architecture.md §4.1, §9.3, §10).
 *
 * `rune run` uses the non-interactive driver — the parity anchor — and supports `--dry-run`. The
 * interactive prompter arrives with the next milestone slice; until then every `rune run`
 * invocation uses the non-interactive path regardless of TTY state or flag presence.
 */

import { normalize, resolve, toNamespacedPath } from 'node:path';

import {
  CancelledError,
  createFailureResult,
  ExecutionError,
  exitCodeFor,
  InternalError,
  PlatformError,
  RuneError,
  serializeResult,
  Session,
  UsageError,
  writeResult,
} from '@rune/engine';
import type { ExecutionPlan, RunResult, StringTable } from '@rune/engine';

import { parseOverrides, parsePlatform } from './args.js';
import {
  ExitWithCode,
  humanStderr,
  runeErrorStderr,
  sessionHumanStderr,
  type CliControl,
  type CliIo,
} from './io.js';
import { progressObserver, renderOutcome, renderPlan } from './render.js';

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
  control: CliControl = {},
): Promise<void> {
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
  let platform: ReturnType<typeof parsePlatform> = undefined;
  let session: Session | undefined;
  let strings: StringTable | undefined;
  let plan: ExecutionPlan | undefined;
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
    // The flag spelling of the collision is an argument-level fact, so refuse it before the
    // session exists: a run that fails during open or planning would otherwise deliver its
    // failure result onto the path the operator designated as the log (§4.1). Session.open
    // anchors this flag against the same cwd, and nothing awaits in between. The manifest's
    // own execution.logFile is only knowable once the engine has anchored it, so that half
    // stays below, after planning.
    if (
      flags.dryRun !== true &&
      resultDestination !== undefined &&
      resultDestination.path !== '-' &&
      flags.logFile !== undefined &&
      flags.logFile !== '' &&
      samePath(resultDestination.path, resolve(flags.logFile))
    ) {
      throw new UsageError(COLLISION_MESSAGE);
    }

    session = await Session.open(manifestPath, {
      mode: 'non-interactive',
      values: flags.values ?? [],
      overrides: parseOverrides(flags.set ?? []),
      locale: flags.locale,
      logFile: flags.logFile,
      ...(platform === undefined ? {} : { platform }),
    });
    strings = session.getStrings();

    plan = session.plan();
    if (
      flags.dryRun !== true &&
      resultDestination !== undefined &&
      resultDestination.path !== '-' &&
      plan.executionOptions.logFile !== undefined &&
      samePath(resultDestination.path, plan.executionOptions.logFile)
    ) {
      throw new UsageError(COLLISION_MESSAGE);
    }
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
      // supplied, because those are the ones a secret registry can hold (§10).
      renderPlan(
        plan,
        session.manifest.product,
        {
          manifestPath,
          logFile: flags.logFile ?? session.manifest.execution.logFile,
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
          mode: 'non-interactive',
          ...(platform === undefined ? {} : { platform }),
          ...(session === undefined ? {} : { session }),
          ...(plan === undefined ? {} : { plan }),
        });
      // An open failure may have registered secret candidates without returning the session's
      // masking StringTable. In that case the projected diagnostic above is the only safe human
      // output; still deliver the machine result, but do not compose additional fallback lines.
      const renderFallback =
        session !== undefined || (result.status === 'config_error' && result.product === null);
      if (resultDestination !== undefined) {
        deliveryStarted = true;
        await deliverResult(result, resultDestination, io, strings, renderFallback);
      }
      if (renderFallback) {
        renderOutcome(result, session?.warnings() ?? [], io, strings);
      }
      throw new ExitWithCode(result.exitCode);
    }
    throw error;
  }
}

/** Both halves of the §4.1 collision rule report the same misconfiguration. */
const COLLISION_MESSAGE =
  '--result and the effective log file must use different paths for a real run';

/** @internal Compare absolute sink paths under the host's path-spelling rules. */
export function samePath(left: string, right: string): boolean {
  if (process.platform === 'win32') {
    return windowsPathKey(left) === windowsPathKey(right);
  }
  return normalize(left) === normalize(right);
}

function windowsPathKey(path: string): string {
  return toNamespacedPath(normalize(path))
    .replace(/^\\\\\.\\([A-Za-z]:\\)/u, String.raw`\\?\$1`)
    .toLowerCase();
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
