/**
 * `rune run` (docs/architecture.md §4.1, §9.3, §10).
 *
 * This PR ships the non-interactive driver — the parity anchor — and `--dry-run`. The
 * interactive prompter arrives with the next milestone slice; until then a TTY without
 * `--non-interactive` follows the same non-interactive path.
 */

import { randomUUID } from 'node:crypto';

import {
  exitCodeFor,
  InputError,
  RUNE_VERSION,
  Session,
  UsageError,
  serializeResult,
  writeResult,
} from '@rune/engine';
import type { RunResult } from '@rune/engine';

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

  const session = await Session.open(manifestPath, {
    values: flags.values ?? [],
    overrides: parseOverrides(flags.set ?? []),
    locale: flags.locale,
    logFile: flags.logFile,
    ...(platform === undefined ? {} : { platform }),
  });

  let result: RunResult;
  try {
    result =
      flags.dryRun === true ? session.describe() : await session.execute(progressObserver(io));
  } catch (error) {
    // Resolution said no (every missing input already listed): still deliver a result file
    // with the matching status before the exit code (§10, never-block contract).
    if (error instanceof InputError && flags.result !== undefined) {
      io.stderr(error.message);
      const code = exitCodeFor(error);
      deliverResult(failureShell(session, code, manifestPath), flags.result, io);
      throw new ExitWithCode(code);
    }
    throw error;
  }

  if (flags.dryRun === true) {
    renderPlan(result, io);
  }
  renderOutcome(result, session.warnings(), io);
  if (flags.result !== undefined) {
    deliverResult(result, flags.result, io);
  }
  if (result.exitCode !== 0) {
    throw new ExitWithCode(result.exitCode);
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

function parseOverrides(pairs: readonly string[]): Record<string, string> {
  const overrides: Record<string, string> = {};
  for (const pair of pairs) {
    const separator = pair.indexOf('=');
    if (separator <= 0) {
      throw new UsageError(`--set expects key=value, got "${pair}"`);
    }
    overrides[pair.slice(0, separator)] = pair.slice(separator + 1);
  }
  return overrides;
}

function parsePlatform(raw: string | undefined): 'windows' | 'linux' | undefined {
  if (raw === undefined) {
    return undefined;
  }
  if (raw !== 'windows' && raw !== 'linux') {
    throw new UsageError(`--platform must be windows or linux, got "${raw}"`);
  }
  return raw;
}

/**
 * The result file of a run that never started (§10): the input_error shell with zero
 * counters — honest about the fact that resolution refused before any plan existed.
 */
function failureShell(session: Session, exitCode: number, manifestPath: string): RunResult {
  const now = new Date().toISOString();
  return {
    resultSchemaVersion: 1,
    id: randomUUID(),
    status: 'input_error',
    exitCode,
    dryRun: false,
    crossPlatformPreview: false,
    platform: process.platform === 'win32' ? 'windows' : 'linux',
    startedAt: now,
    finishedAt: now,
    durationMs: 0,
    runeVersion: RUNE_VERSION,
    product: session.manifest.product,
    manifestPath,
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
