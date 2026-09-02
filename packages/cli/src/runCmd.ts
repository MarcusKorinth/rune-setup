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
  InternalError,
  PlatformError,
  RuneError,
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
  // Session.open anchors relative manifest paths to the invocation cwd. Preserve that
  // identity for an early open failure, before any async work can change the cwd.
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

    session = await Session.open(absoluteManifestPath, {
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
      throw new UsageError(
        '--result and the effective log file must use different paths for a real run',
      );
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
      renderPlan(plan, session.manifest.product, io, strings);
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
    io.stdout(JSON.stringify(result, null, 2));
    return;
  }
  await writeResult(result, destination.path);
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
