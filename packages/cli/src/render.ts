/**
 * Shared rendering (docs/architecture.md §9.3): the dry-run plan, run progress, and the
 * result summary — one renderer, so dry-run, the interactive summary, and logs tell one
 * story. Everything rendered here arrives already masked from the engine.
 */

import type { RunEvent, RunResult } from '@rune/engine';

import type { CliIo } from './io.js';

/** Renders a `planned` result — the dry-run output (§10: requested output, stdout). */
export function renderPlan(result: RunResult, io: CliIo): void {
  const preview = result.crossPlatformPreview ? ', cross-platform preview' : '';
  io.stdout(
    `Plan for ${result.product.name} ${result.product.version} ` +
      `(${result.manifestPath}, platform ${result.platform}${preview})`,
  );
  result.steps.forEach((step, index) => {
    const number = `${index + 1}.`.padEnd(3);
    if (step.state === 'SKIPPED') {
      io.stdout(`  ${number} ${step.title} — SKIPPED (${step.skipReason ?? ''})`);
      return;
    }
    io.stdout(`  ${number} ${step.title}`);
    if (step.command !== null) {
      io.stdout(`       ${step.command.join(' ')}`);
    }
  });
}

/** The progress renderer for a live run — diagnostics, so stderr (§10). */
export function progressObserver(io: CliIo): (event: RunEvent) => void {
  return (event) => {
    switch (event.kind) {
      case 'runStarted':
        io.stderr(`running ${event.plan.steps.length} steps on ${event.plan.platform}`);
        break;
      case 'stepStarted':
        io.stderr(`[${event.index + 1}/${event.total}] ${event.title}`);
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
export function renderOutcome(result: RunResult, warnings: readonly string[], io: CliIo): void {
  for (const warning of warnings) {
    io.stderr(`warning: ${warning}`);
  }
  if (!result.dryRun && result.nothingExecuted) {
    io.stderr('warning: nothing was executed — every step was skipped');
  }
  io.stderr(
    `${result.status}: ${result.stepsSucceeded} succeeded, ${result.stepsFailed} failed, ` +
      `${result.stepsSkipped} skipped, ${result.stepsNotRun} not run (exit ${result.exitCode})`,
  );
}
