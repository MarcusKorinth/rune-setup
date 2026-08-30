/**
 * `rune run` (docs/architecture.md §4.1, §9.3, §10).
 *
 * This PR ships the non-interactive driver — the parity anchor — and `--dry-run`. The
 * interactive prompter arrives with the next milestone slice; until then a TTY without
 * `--non-interactive` follows the same non-interactive path.
 */

import {
  createFailureResult,
  exitCodeFor,
  RuneError,
  Session,
  UsageError,
  serializeResult,
  writeResult,
} from '@rune/engine';
import type { ExecutionPlan, RunResult } from '@rune/engine';

import { parseOverrides, parsePlatform } from './args.js';
import { ExitWithCode, type CliIo } from './io.js';
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

export async function runCommand(manifestPath: string, flags: RunFlags, io: CliIo): Promise<void> {
  if (flags.platform !== undefined && flags.dryRun !== true) {
    throw new UsageError('--platform previews a plan and combines only with --dry-run');
  }
  const platform = parsePlatform(flags.platform);

  let session: Session | undefined;
  let plan: ExecutionPlan | undefined;
  try {
    session = await Session.open(manifestPath, {
      mode: 'non-interactive',
      values: flags.values ?? [],
      overrides: parseOverrides(flags.set ?? []),
      locale: flags.locale,
      logFile: flags.logFile,
      ...(platform === undefined ? {} : { platform }),
    });

    plan = session.plan();
    const result =
      flags.dryRun === true ? session.describe() : await session.execute(progressObserver(io));

    // With `--result -` the JSON owns stdout; the human plan would contaminate it (§10).
    if (flags.dryRun === true && flags.result !== '-') {
      renderPlan(plan, session.manifest.product, io);
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
    if (error instanceof RuneError && !(error instanceof UsageError)) {
      io.stderr(error.message);
      const code = exitCodeFor(error);
      const result = createFailureResult({
        error,
        manifestPath,
        dryRun: flags.dryRun === true,
        mode: 'non-interactive',
        ...(platform === undefined ? {} : { platform }),
        ...(session === undefined ? {} : { session }),
        ...(plan === undefined ? {} : { plan }),
      });
      renderOutcome(result, session?.warnings() ?? [], io);
      if (flags.result !== undefined) {
        deliverResult(result, flags.result, io);
      }
      throw new ExitWithCode(code);
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
