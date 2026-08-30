/**
 * `rune run` (docs/architecture.md §4.1, §9.3, §10).
 *
 * This PR ships the non-interactive driver — the parity anchor — and `--dry-run`. The
 * interactive prompter arrives with the next milestone slice; until then a TTY without
 * `--non-interactive` follows the same non-interactive path.
 */

import { randomUUID } from 'node:crypto';

import {
  EXIT_CODE_BY_STATUS,
  exitCodeFor,
  RUNE_VERSION,
  RuneError,
  Session,
  UsageError,
  serializeResult,
  writeResult,
} from '@rune/engine';
import type { RunResult, RunStatus } from '@rune/engine';

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
  try {
    session = await Session.open(manifestPath, {
      mode: 'non-interactive',
      values: flags.values ?? [],
      overrides: parseOverrides(flags.set ?? []),
      locale: flags.locale,
      logFile: flags.logFile,
      ...(platform === undefined ? {} : { platform }),
    });

    const result =
      flags.dryRun === true ? session.describe() : await session.execute(progressObserver(io));

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
      deliverResult(failureShell({ session, code, manifestPath, flags }), flags.result, io);
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

/**
 * The result file of a run that never happened (§10): the failing status with zero
 * counters — honest about the fact that the pipeline refused before any plan existed.
 */
function failureShell(options: {
  session: Session | undefined;
  code: number;
  manifestPath: string;
  flags: RunFlags;
}): RunResult {
  const { session, code, flags } = options;
  const now = new Date().toISOString();
  const host = process.platform === 'win32' ? 'windows' : 'linux';
  const platform =
    flags.platform === 'windows' || flags.platform === 'linux' ? flags.platform : host;
  return {
    resultSchemaVersion: 1,
    id: randomUUID(),
    status: statusForExit(code),
    exitCode: code,
    mode: session?.mode ?? 'non-interactive',
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
    manifest: {
      path: session?.manifestPath ?? options.manifestPath,
      sha256: session?.manifestSha256 ?? null,
      schemaVersion: session?.manifest.schemaVersion ?? null,
    },
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
