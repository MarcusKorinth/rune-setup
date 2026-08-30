/**
 * Shared rendering (docs/architecture.md §9.3): the dry-run plan, run progress, and the
 * result summary — one renderer, so dry-run, the interactive summary, and logs tell one
 * story. Plan values keep their SecretString wrappers until this rendering sink masks them.
 */

import { isSecretString, MASK } from '@rune/engine';
import type { ChromeKey, ExecutionPlan, RunEvent, RunResult, StringTable } from '@rune/engine';

import type { CliIo } from './io.js';

/** Renders the immutable plan itself — the dry-run output (§10: requested output, stdout). */
export function renderPlan(
  plan: ExecutionPlan,
  product: { readonly name: string; readonly version: string },
  io: CliIo,
): void {
  const preview = plan.preview ? ', cross-platform preview' : '';
  io.stdout(
    `Execution plan v${plan.executionPlanVersion} for ${product.name} ${product.version} ` +
      `(${plan.manifestPath}, sha256 ${plan.manifestSha256}, platform ${plan.platform}${preview})`,
  );
  io.stdout(
    `Execution options: failFast=${String(plan.executionOptions.failFast)}, ` +
      `logFile=${maskedJson(plan.executionOptions.logFile)}`,
  );
  io.stdout('Resolved inputs:');
  for (const input of plan.resolvedInputs) {
    io.stdout(
      `  ${input.id}: value=${maskedJson(input.value)}, type=${input.type}, ` +
        `enabled=${String(input.enabled)}, source=${input.source ?? 'none'}, ` +
        `ignored=${input.ignored ?? 'none'}`,
    );
  }
  io.stdout('Steps:');
  plan.steps.forEach((step, index) => {
    const number = `${index + 1}.`.padEnd(3);
    if (step.state === 'SKIPPED') {
      io.stdout(`  ${number} ${step.title} — SKIPPED (${step.skipReason})`);
      return;
    }
    io.stdout(`  ${number} ${step.title}`);
    io.stdout(`       argv: ${maskedJson(step.command.argv)}`);
    io.stdout(`       cwd: ${maskedJson(step.command.cwd)}`);
    io.stdout(`       env: ${maskedJson(step.command.env)}`);
    io.stdout(`       timeoutSeconds: ${maskedJson(step.command.timeoutSeconds)}`);
    io.stdout(`       successExitCodes: ${maskedJson(step.command.successExitCodes)}`);
  });
}

/** JSON quoting keeps argv boundaries visible; wrappers are masked without being revealed. */
function maskedJson(value: unknown): string {
  return JSON.stringify(maskedValue(value));
}

function maskedValue(value: unknown): unknown {
  if (isSecretString(value)) {
    return MASK;
  }
  if (Array.isArray(value)) {
    return value.map(maskedValue);
  }
  if (typeof value === 'object' && value !== null) {
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [key, maskedValue(entry)]),
    );
  }
  return value;
}

/** The progress renderer for a live run — diagnostics, so stderr (§10). */
export function progressObserver(io: CliIo, strings: StringTable): (event: RunEvent) => void {
  return (event) => {
    switch (event.kind) {
      case 'runStarted':
        io.stderr(`running ${event.plan.steps.length} steps on ${event.plan.platform}`);
        break;
      case 'stepStarted':
        io.stderr(
          strings.chrome('rune.progress.step', {
            index: event.index + 1,
            total: event.total,
            title: event.title,
          }),
        );
        break;
      case 'stepOutput':
        io.stderr(`  ${event.line}`);
        break;
      case 'stepFinished':
        io.stderr(
          `  -> ${event.state}` +
            (event.exitCode === undefined ? '' : ` (exit ${event.exitCode})`) +
            ` after ${event.durationMs}ms`,
        );
        break;
      case 'runFinished':
        break;
    }
  };
}

/** The closing summary and the §10 warnings, on stderr. */
export function renderOutcome(
  result: RunResult,
  warnings: readonly string[],
  io: CliIo,
  strings?: StringTable,
): void {
  for (const warning of warnings) {
    io.stderr(`warning: ${warning}`);
  }
  const resultKey = resultChromeKey(result.status);
  if (resultKey !== undefined && strings !== undefined) {
    io.stderr(strings.chrome(resultKey));
  }
  if (result.status === 'succeeded' && result.nothingExecuted) {
    io.stderr(
      strings === undefined
        ? 'warning: nothing was executed — every step was skipped'
        : `warning: ${strings.chrome('rune.result.nothingExecuted')}`,
    );
  }
  io.stderr(
    `${result.status}: ${result.stepsSucceeded} succeeded, ${result.stepsFailed} failed, ` +
      `${result.stepsSkipped} skipped, ${result.stepsNotRun} not run (exit ${result.exitCode})`,
  );
}

/** Chrome keys exist only for user-facing terminal statuses. Other statuses keep evidence raw. */
function resultChromeKey(status: RunResult['status']): ChromeKey | undefined {
  switch (status) {
    case 'succeeded':
      return 'rune.result.succeeded';
    case 'failed':
      return 'rune.result.failed';
    case 'cancelled':
      return 'rune.result.cancelled';
    case 'planned':
      return 'rune.result.planned';
    default:
      return undefined;
  }
}
