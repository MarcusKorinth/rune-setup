/**
 * The bridge serializer (docs/architecture.md §9.2): every value that crosses towards the
 * renderer — invoke returns and pushed events alike — goes through one projection to
 * JSON-safe plain data first. A `SecretString` serializes to `***` by its own `toJSON`,
 * so a secret can never reach Electron's structured clone (which ignores `toJSON`), and
 * no engine object crosses at all.
 */

import { pathToFileURL } from 'node:url';

import {
  RuneError,
  exitCodeFor,
  formatIssues,
  formatSessionTerminalLine,
  type ExecutionPlan,
  type RunEvent,
  type RunResult,
  type StringTable,
  type ThemeConfig,
} from '@rune/engine';

import type {
  BridgeError,
  BridgeEvent,
  BridgePlan,
  BridgeResult,
  BridgeTheme,
  BridgeWarning,
} from '../preload/types.js';

/** Copies only public error fields; causes, stacks, and arbitrary properties stay in main. */
export function projectError(error: unknown, mask: (text: string) => string): BridgeError {
  const fallback: BridgeError = {
    kind: 'rune-error',
    code: 'RUNE-500',
    message: 'An unexpected shell error occurred.',
    location: null,
    exitCode: 70,
    displayText: 'RUNE-500 (exit 70): An unexpected shell error occurred.',
  };
  try {
    if (!(error instanceof RuneError)) {
      return fallback;
    }
    const text = (raw: string): string => {
      const masked = mask(raw);
      const escaped = JSON.stringify(masked).slice(1, -1);
      return mask(escaped) === escaped ? masked : '***';
    };
    return {
      kind: 'rune-error',
      code: error.code,
      message: text(error.message),
      location:
        error.location === undefined
          ? null
          : {
              file: text(error.location.file),
              line: error.location.line,
              column: error.location.column,
            },
      exitCode: exitCodeFor(error),
      displayText: text(
        `${error.code} (exit ${exitCodeFor(error)}): ${formatIssues(error.issues)}`,
      ),
    };
  } catch {
    return fallback;
  }
}

export function project<T>(value: T): unknown {
  if (value === undefined) {
    return undefined;
  }
  return JSON.parse(JSON.stringify(value)) as unknown;
}

/** Projects the complete ExecutionPlan; SecretString.toJSON() supplies its literal mask. */
export function projectPlan(plan: ExecutionPlan, strings: StringTable): BridgePlan {
  const projected = project(plan) as BridgePlan;
  return {
    ...projected,
    steps: projected.steps.map((step) =>
      step.state === 'PENDING'
        ? {
            ...step,
            displayCommand: formatSessionTerminalLine(strings, JSON.stringify(step.command.argv)),
          }
        : step,
    ),
  };
}

/** Projects one run event, routing its plan through the same masked plan contract. */
export function projectEvent(event: RunEvent, strings: StringTable): BridgeEvent {
  switch (event.kind) {
    case 'runStarted': {
      const plan = projectPlan(event.plan, strings);
      return {
        kind: event.kind,
        plan,
        displayText: strings.chrome('rune.progress.runStarted', {
          total: plan.steps.length,
          platform: plan.platform,
        }),
      };
    }
    case 'stepStarted': {
      const projected = project(event) as Extract<BridgeEvent, { kind: 'stepStarted' }>;
      return {
        ...projected,
        displayText: strings.chrome('rune.progress.step', {
          index: projected.index + 1,
          total: projected.total,
          title: projected.title,
        }),
      };
    }
    case 'stepOutput': {
      const projected = project(event) as Extract<BridgeEvent, { kind: 'stepOutput' }>;
      return {
        ...projected,
        displayText: strings.chrome('rune.progress.output', { line: projected.line }),
      };
    }
    case 'stepFinished': {
      const projected = project(event) as Extract<BridgeEvent, { kind: 'stepFinished' }>;
      return {
        ...projected,
        displayText: strings.chrome(
          projected.exitCode === undefined
            ? 'rune.progress.stepFinishedWithoutExitCode'
            : 'rune.progress.stepFinished',
          {
            state: projected.state,
            durationMs: projected.durationMs,
            ...(projected.exitCode === undefined ? {} : { exitCode: projected.exitCode }),
          },
        ),
      };
    }
    case 'runFinished':
      return { kind: event.kind, result: projectResult(event.result, strings) };
  }
}

/** Results are already field-aware structured-sink projections from the engine. */
export function projectResult(result: RunResult, strings: StringTable): BridgeResult {
  const projected = project(result) as BridgeResult;
  return {
    ...projected,
    displaySummary: strings.chrome('rune.result.summary', {
      status: projected.status,
      succeeded: projected.stepsSucceeded,
      failed: projected.stepsFailed,
      skipped: projected.stepsSkipped,
      cancelled: projected.stepsCancelled,
      notRun: projected.stepsNotRun,
      exitCode: projected.exitCode,
    }),
    steps: projected.steps.map((step) => ({
      ...step,
      displayTitle: formatSessionTerminalLine(
        strings,
        strings.chrome('rune.result.stepTitle', {
          title: step.title,
          exitCode: step.exitCode ?? '?',
        }),
      ),
    })),
  };
}

/** Preserves each engine warning beside its complete, final GUI presentation. */
export function projectWarnings(
  warnings: readonly string[],
  strings: StringTable,
): readonly BridgeWarning[] {
  return warnings.map((warning) => {
    const message = project(warning) as string;
    return {
      message,
      displayText: strings.chrome('rune.warning', { message }),
    };
  });
}

/** Keeps the engine path-based while giving the sandboxed renderer canonical asset URLs. */
export function projectTheme(theme: ThemeConfig): BridgeTheme {
  const fileUrl = (path: string): string => pathToFileURL(path).href;
  return {
    ...(theme.accentColor === undefined ? {} : { accentColor: theme.accentColor }),
    ...(theme.logo === undefined ? {} : { logo: fileUrl(theme.logo) }),
    ...(theme.banner === undefined ? {} : { banner: fileUrl(theme.banner) }),
    ...(theme.theme === undefined ? {} : { theme: fileUrl(theme.theme) }),
    ...(theme.windowTitle === undefined ? {} : { windowTitle: theme.windowTitle }),
  };
}
