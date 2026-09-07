/**
 * Shared rendering (docs/architecture.md §9.3): the dry-run plan, run progress, and the
 * result summary — one renderer, so dry-run, the interactive summary, and logs tell one
 * story. Plan values keep their SecretString wrappers until this rendering sink masks them.
 */

import type { ChromeKey, ExecutionPlan, RunEvent, RunResult, StringTable } from '@rune/engine';

import { humanStderr, sessionHumanStderr, sessionHumanStdout, type CliIo } from './io.js';

/**
 * Renders the immutable plan itself — the dry-run output (§10: requested output, stdout).
 *
 * `spelled` carries the two paths as the operator wrote them: the manifest argument, and the
 * log path (`--log-file`, else `execution.logFile`), whose entry is `undefined` exactly when
 * the plan has no effective log path. §10 makes those the preview's spellings — the plan's own
 * fields carry RUNE-anchored spellings, which this sink's masks would meet without ever
 * having held them.
 */
export function renderPlan(
  plan: ExecutionPlan,
  product: { readonly name: string; readonly version: string },
  spelled: { readonly manifestPath: string; readonly logFile: string | undefined },
  io: CliIo,
  strings: StringTable,
): void {
  sessionHumanStdout(
    io,
    strings,
    strings.chrome(plan.preview ? 'rune.plan.headingPreview' : 'rune.plan.heading', {
      planVersion: plan.planSchemaVersion,
      productName: product.name,
      productVersion: product.version,
      manifestPath: spelled.manifestPath,
      manifestSha: plan.manifestSha256,
      platform: plan.platform,
    }),
  );
  sessionHumanStdout(
    io,
    strings,
    strings.chrome('rune.plan.executionOptions', {
      failFast: String(plan.executionOptions.failFast),
      logFile: quotedLogPath(spelled.logFile),
    }),
  );
  sessionHumanStdout(io, strings, strings.chrome('rune.plan.inputs'));
  for (const input of plan.resolvedInputs) {
    sessionHumanStdout(
      io,
      strings,
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
  sessionHumanStdout(io, strings, strings.chrome('rune.plan.steps'));
  plan.steps.forEach((step, index) => {
    const number = `${index + 1}.`.padEnd(3);
    if (step.state === 'SKIPPED') {
      sessionHumanStdout(
        io,
        strings,
        strings.chrome('rune.plan.stepSkipped', {
          number,
          title: step.title,
          reason: step.skipReason,
        }),
      );
      return;
    }
    sessionHumanStdout(
      io,
      strings,
      strings.chrome('rune.plan.step', { number, title: step.title }),
    );
    sessionHumanStdout(
      io,
      strings,
      strings.chrome('rune.plan.argv', { value: safeJson(step.command.argv) }),
    );
    sessionHumanStdout(
      io,
      strings,
      strings.chrome('rune.plan.cwd', { value: safeJson(step.command.cwd) }),
    );
    sessionHumanStdout(
      io,
      strings,
      strings.chrome('rune.plan.env', { value: safeJson(step.command.env) }),
    );
    sessionHumanStdout(
      io,
      strings,
      strings.chrome('rune.plan.timeoutSeconds', {
        value: safeJson(step.command.timeoutSeconds),
      }),
    );
    sessionHumanStdout(
      io,
      strings,
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

/**
 * The plan publishes its log path unprojected (§10 keeps a validated log path exact), so this
 * sink's masks are the only ones that can hide it and they must meet the registry's own
 * spelling — hence the operator's spelling, and quoting instead of escaping: `safeJson` would
 * rewrite a backslash or a quote and leave the secret in clear.
 *
 * The quotes are therefore decorative. A path holding a quote or a comma can make this line
 * look as if it carried a second `failFast`/`logFile` pair — accepted, because masking
 * outranks unambiguity here and the line's control characters stay visibly escaped, so a
 * forged field cannot become a forged line.
 */
function quotedLogPath(announcement: string | undefined): string {
  return announcement === undefined ? 'none' : `"${announcement}"`;
}

/** The progress renderer for a live run — diagnostics, so stderr (§10). */
export function progressObserver(
  io: CliIo,
  strings: StringTable,
): (event: RunEvent) => void | Promise<void> {
  return (event) => {
    switch (event.kind) {
      case 'runStarted':
        sessionHumanStderr(
          io,
          strings,
          strings.chrome('rune.progress.runStarted', {
            total: event.plan.steps.length,
            platform: event.plan.platform,
          }),
        );
        break;
      case 'stepStarted':
        sessionHumanStderr(
          io,
          strings,
          strings.chrome('rune.progress.step', {
            index: event.index + 1,
            total: event.total,
            title: event.title,
          }),
        );
        break;
      case 'stepOutput':
        sessionHumanStderr(
          io,
          strings,
          strings.chrome('rune.progress.output', { line: event.line }),
        );
        break;
      case 'stepFinished':
        if (event.exitCode === undefined) {
          sessionHumanStderr(
            io,
            strings,
            strings.chrome('rune.progress.stepFinishedWithoutExitCode', {
              state: event.state,
              durationMs: event.durationMs,
            }),
          );
          break;
        }
        sessionHumanStderr(
          io,
          strings,
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
    return io.drainStderr?.();
  };
}

/** The closing summary and the §10 warnings, on stderr. */
export function renderOutcome(
  result: RunResult,
  warnings: readonly string[],
  io: CliIo,
  strings?: StringTable,
): void {
  const writeStderr = (text: string): void => {
    if (strings === undefined) {
      humanStderr(io, text);
    } else {
      sessionHumanStderr(io, strings, text);
    }
  };
  for (const warning of warnings) {
    writeStderr(
      strings === undefined
        ? `warning: ${warning}`
        : strings.chrome('rune.warning', { message: warning }),
    );
  }
  const resultKey = resultChromeKey(result.status);
  if (resultKey !== undefined && strings !== undefined) {
    writeStderr(strings.chrome(resultKey));
  }
  if (result.status === 'succeeded' && result.nothingExecuted) {
    writeStderr(
      strings === undefined
        ? 'warning: nothing was executed — every step was skipped'
        : strings.chrome('rune.warning', {
            message: strings.chrome('rune.result.nothingExecuted'),
          }),
    );
  }
  writeStderr(
    strings === undefined
      ? `${result.status}: ${result.stepsSucceeded} succeeded, ${result.stepsFailed} failed, ` +
          `${result.stepsSkipped} skipped, ${result.stepsCancelled} cancelled, ` +
          `${result.stepsNotRun} not run (exit ${result.exitCode})`
      : strings.chrome('rune.result.summary', {
          status: result.status,
          succeeded: result.stepsSucceeded,
          failed: result.stepsFailed,
          skipped: result.stepsSkipped,
          cancelled: result.stepsCancelled,
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
