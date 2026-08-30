/**
 * `rune run` (docs/architecture.md §4.1, §9.3, §10).
 *
 * This PR ships the non-interactive driver — the parity anchor — and `--dry-run`. The
 * interactive prompter arrives with the next milestone slice; until then a TTY without
 * `--non-interactive` follows the same non-interactive path.
 */

import {
  CancelledError,
  createFailureResult,
  InternalError,
  RuneError,
  Session,
  UsageError,
  serializeResult,
  writeResult,
} from '@rune/engine';
import type { ExecutionPlan, RunResult } from '@rune/engine';

import { parseOverrides, parsePlatform } from './args.js';
import { ExitWithCode, type CliControl, type CliIo } from './io.js';
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
  let platform: ReturnType<typeof parsePlatform> = undefined;
  let session: Session | undefined;
  let plan: ExecutionPlan | undefined;
  let executionFailureResult: RunResult | undefined;
  let deliveryStarted = false;
  try {
    if (flags.platform !== undefined && flags.dryRun !== true) {
      throw new UsageError('--platform previews a plan and combines only with --dry-run');
    }
    platform = parsePlatform(flags.platform);

    session = await Session.open(manifestPath, {
      mode: 'non-interactive',
      values: flags.values ?? [],
      overrides: parseOverrides(flags.set ?? []),
      locale: flags.locale,
      logFile: flags.logFile,
      ...(platform === undefined ? {} : { platform }),
    });

    plan = session.plan();
    if (flags.dryRun === true && control.cancel?.cancelled === true) {
      throw new CancelledError();
    }
    const progress = progressObserver(io);
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
    if (flags.dryRun === true && flags.result !== '-') {
      renderPlan(plan, result.product, io);
    }
    renderOutcome(result, session.warnings(), io);
    if (flags.result !== undefined) {
      deliveryStarted = true;
      deliverResult(result, flags.result, io);
    }
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
    if (!(error instanceof UsageError)) {
      const failure =
        error instanceof RuneError
          ? error
          : new InternalError('an unexpected error escaped the run pipeline', { cause: error });
      io.stderr(failure.message);
      const result =
        executionFailureResult ??
        createFailureResult({
          error: failure,
          manifestPath,
          dryRun: flags.dryRun === true,
          mode: 'non-interactive',
          ...(platform === undefined ? {} : { platform }),
          ...(session === undefined ? {} : { session }),
          ...(plan === undefined ? {} : { plan }),
        });
      renderOutcome(result, session?.warnings() ?? [], io);
      if (flags.result !== undefined) {
        deliveryStarted = true;
        deliverResult(result, flags.result, io);
      }
      throw new ExitWithCode(result.exitCode);
    }
    throw error;
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
