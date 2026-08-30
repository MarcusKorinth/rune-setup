/**
 * Shared rendering (docs/architecture.md §9.3): the dry-run plan, run progress, and the
 * result summary — one renderer, so dry-run, the interactive summary, and logs tell one
 * story. Everything rendered here arrives already masked from the engine.
 */

import type { RunEvent, RunResult, StringTable } from '@rune/engine';

import type { CliIo } from './io.js';

/** Renders a `planned` result — the dry-run output (§10: requested output, stdout). */
export function renderPlan(result: RunResult, strings: StringTable, io: CliIo): void {
  const preview = result.crossPlatformPreview
    ? strings.chrome('rune.plan.crossPlatformPreview')
    : '';
  io.stdout(
    strings.chrome('rune.plan.heading', {
      product: result.product.name,
      version: result.product.version,
      path: result.manifestPath,
      platform: result.platform,
      preview,
    }),
  );
  result.steps.forEach((step, index) => {
    const number = `${index + 1}.`.padEnd(3);
    if (step.state === 'SKIPPED') {
      io.stdout(
        strings.chrome('rune.plan.skipped', {
          number,
          title: step.title,
          state: step.state,
          reason: step.skipReason ?? '',
        }),
      );
      return;
    }
    io.stdout(strings.chrome('rune.plan.step', { number, title: step.title }));
    if (step.command !== null) {
      io.stdout(strings.chrome('rune.plan.command', { command: step.command.join(' ') }));
    }
  });
}

/** The progress renderer for a live run — diagnostics, so stderr (§10). */
export function progressObserver(strings: StringTable, io: CliIo): (event: RunEvent) => void {
  return (event) => {
    switch (event.kind) {
      case 'runStarted':
        io.stderr(
          strings.chrome('rune.progress.running', {
            total: event.plan.steps.length,
            platform: event.plan.platform,
          }),
        );
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
        io.stderr(strings.chrome('rune.progress.output', { line: event.line }));
        break;
      case 'stepFinished':
        io.stderr(
          strings.chrome('rune.progress.finished', {
            state: event.state,
            exit:
              event.exitCode === undefined
                ? ''
                : strings.chrome('rune.progress.exit', { code: event.exitCode }),
            duration: strings.chrome('rune.progress.duration', { duration: event.durationMs }),
          }),
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
  strings: StringTable,
  io: CliIo,
): void {
  for (const warning of warnings) {
    io.stderr(strings.chrome('rune.warning.message', { warning }));
  }
  if (!result.dryRun && result.nothingExecuted) {
    io.stderr(
      strings.chrome('rune.warning.message', {
        warning: strings.chrome('rune.result.nothingExecuted'),
      }),
    );
  }
  io.stderr(strings.chrome(`rune.result.${result.status}`));
  io.stderr(
    strings.chrome('rune.result.summary', {
      succeeded: result.stepsSucceeded,
      failed: result.stepsFailed,
      skipped: result.stepsSkipped,
      notrun: result.stepsNotRun,
      exit: result.exitCode,
    }),
  );
}
