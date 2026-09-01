/**
 * Shared rendering (docs/architecture.md §9.3): the dry-run plan, run progress, and the
 * result summary — one renderer, so dry-run, the interactive summary, and logs tell one
 * story. Plan values keep their SecretString wrappers until this rendering sink masks them.
 */

import type { ChromeKey, ExecutionPlan, RunEvent, RunResult, StringTable } from '@rune/engine';

import type { CliIo } from './io.js';

/** Renders the immutable plan itself — the dry-run output (§10: requested output, stdout). */
export function renderPlan(
  plan: ExecutionPlan,
  product: { readonly name: string; readonly version: string },
  io: CliIo,
  strings: StringTable,
): void {
  io.stdout(
    strings.chrome(plan.preview ? 'rune.plan.headingPreview' : 'rune.plan.heading', {
      planVersion: plan.planSchemaVersion,
      productName: product.name,
      productVersion: product.version,
      manifestPath: plan.manifestPath,
      manifestSha: plan.manifestSha256,
      platform: plan.platform,
    }),
  );
  io.stdout(
    strings.chrome('rune.plan.executionOptions', {
      failFast: String(plan.executionOptions.failFast),
      logFile: safeJson(plan.executionOptions.logFile),
    }),
  );
  io.stdout(strings.chrome('rune.plan.inputs'));
  for (const input of plan.resolvedInputs) {
    io.stdout(
      strings.chrome('rune.plan.input', {
        id: input.id,
        value: safeJson(input.value),
        secret: String(input.secret),
        enabled: String(input.enabled),
        source: input.source ?? 'none',
        ignored: input.ignored ?? 'none',
      }),
    );
  }
  io.stdout(strings.chrome('rune.plan.steps'));
  plan.steps.forEach((step, index) => {
    const number = `${index + 1}.`.padEnd(3);
    if (step.state === 'SKIPPED') {
      io.stdout(
        strings.chrome('rune.plan.stepSkipped', {
          number,
          title: step.title,
          reason: step.skipReason,
        }),
      );
      return;
    }
    io.stdout(strings.chrome('rune.plan.step', { number, title: step.title }));
    io.stdout(strings.chrome('rune.plan.argv', { value: safeJson(step.command.argv) }));
    io.stdout(strings.chrome('rune.plan.cwd', { value: safeJson(step.command.cwd) }));
    io.stdout(strings.chrome('rune.plan.env', { value: safeJson(step.command.env) }));
    io.stdout(
      strings.chrome('rune.plan.timeoutSeconds', {
        value: safeJson(step.command.timeoutSeconds),
      }),
    );
    io.stdout(
      strings.chrome('rune.plan.successExitCodes', {
        value: safeJson(step.command.successExitCodes),
      }),
    );
  });
}

/** The engine's opaque values stringify as `***`; quoting keeps argv boundaries visible. */
function safeJson(value: unknown): string {
  return JSON.stringify(value) ?? 'none';
}

/** The progress renderer for a live run — diagnostics, so stderr (§10). */
export function progressObserver(io: CliIo, strings: StringTable): (event: RunEvent) => void {
  return (event) => {
    switch (event.kind) {
      case 'runStarted':
        io.stderr(
          strings.chrome('rune.progress.runStarted', {
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
        if (event.exitCode === undefined) {
          io.stderr(
            strings.chrome('rune.progress.stepFinishedWithoutExitCode', {
              state: event.state,
              durationMs: event.durationMs,
            }),
          );
          break;
        }
        io.stderr(
          strings.chrome('rune.progress.stepFinished', {
            state: event.state,
            exitCode: event.exitCode,
            durationMs: event.durationMs,
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
  io: CliIo,
  strings?: StringTable,
): void {
  for (const warning of warnings) {
    io.stderr(
      strings === undefined
        ? `warning: ${warning}`
        : strings.chrome('rune.warning', { message: warning }),
    );
  }
  const resultKey = resultChromeKey(result.status);
  if (resultKey !== undefined && strings !== undefined) {
    io.stderr(strings.chrome(resultKey));
  }
  if (result.status === 'succeeded' && result.nothingExecuted) {
    io.stderr(
      strings === undefined
        ? 'warning: nothing was executed — every step was skipped'
        : strings.chrome('rune.warning', {
            message: strings.chrome('rune.result.nothingExecuted'),
          }),
    );
  }
  io.stderr(
    strings === undefined
      ? `${result.status}: ${result.stepsSucceeded} succeeded, ${result.stepsFailed} failed, ` +
          `${result.stepsSkipped} skipped, ${result.stepsNotRun} not run (exit ${result.exitCode})`
      : strings.chrome('rune.result.summary', {
          status: result.status,
          succeeded: result.stepsSucceeded,
          failed: result.stepsFailed,
          skipped: result.stepsSkipped,
          notRun: result.stepsNotRun,
          exitCode: result.exitCode,
        }),
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
