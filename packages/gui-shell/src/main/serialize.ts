/**
 * The bridge serializer (docs/architecture.md §9.2): every value that crosses towards the
 * renderer — invoke returns and pushed events alike — goes through one projection to
 * JSON-safe plain data first. A `SecretString` serializes to `***` by its own `toJSON`,
 * so a secret can never reach Electron's structured clone (which ignores `toJSON`), and
 * no engine object crosses at all.
 */

import { pathToFileURL } from 'node:url';

import type {
  ExecutionPlan,
  ResolvedCommand,
  RunEvent,
  RunResult,
  ThemeConfig,
} from '@rune/engine';

import type {
  BridgeEvent,
  BridgePlan,
  BridgePlannedCommand,
  BridgePlannedStep,
  BridgeResult,
  BridgeTheme,
} from '../preload/types.js';

export function project<T>(value: T): unknown {
  if (value === undefined) {
    return undefined;
  }
  return JSON.parse(JSON.stringify(value)) as unknown;
}

/** Projects the engine plan without letting SecretString.toJSON() erase command text. */
export function projectPlan(plan: ExecutionPlan, mask: (text: string) => string): BridgePlan {
  const projected: BridgePlan = {
    manifestPath: plan.manifestPath,
    locale: plan.locale,
    platform: plan.platform,
    preview: plan.preview,
    failFast: plan.executionOptions.failFast,
    ...(plan.executionOptions.logFile === undefined
      ? {}
      : { logFile: plan.executionOptions.logFile }),
    steps: plan.steps.map((step): BridgePlannedStep => {
      if (step.state === 'SKIPPED') {
        return {
          id: step.id,
          title: mask(step.title),
          state: step.state,
          skipReason: mask(step.skipReason),
        };
      }
      return {
        id: step.id,
        title: mask(step.title),
        state: step.state,
        command: projectCommand(step.command, mask),
      };
    }),
  };

  return project(projected) as BridgePlan;
}

/** Projects one run event, routing its plan through the same masked plan contract. */
export function projectEvent(event: RunEvent, mask: (text: string) => string): BridgeEvent {
  switch (event.kind) {
    case 'runStarted':
      return { kind: event.kind, plan: projectPlan(event.plan, mask) };
    case 'stepStarted':
      return { ...event, title: mask(event.title) };
    case 'stepOutput':
      return { ...event, line: mask(event.line) };
    case 'stepFinished':
      return project(event) as BridgeEvent;
    case 'runFinished':
      return { kind: event.kind, result: projectResult(event.result, mask) };
  }
}

/** Masks only data-bearing result fields, leaving enums and machine identities intact. */
export function projectResult(result: RunResult, mask: (text: string) => string): BridgeResult {
  return project({
    ...result,
    product:
      result.product === null
        ? null
        : { name: mask(result.product.name), version: mask(result.product.version) },
    error:
      result.error === null
        ? null
        : {
            ...result.error,
            message: mask(result.error.message),
            location:
              result.error.location === null
                ? null
                : { ...result.error.location, file: mask(result.error.location.file) },
          },
    inputs: result.inputs.map((input) => ({
      ...input,
      value: Array.isArray(input.value)
        ? input.value.map(mask)
        : typeof input.value === 'string'
          ? mask(input.value)
          : input.value,
    })),
    steps: result.steps.map((step) => ({
      ...step,
      title: mask(step.title),
      command: step.command === null ? null : step.command.map(mask),
      skipReason: step.skipReason === null ? null : mask(step.skipReason),
      ...(step.outputTail === undefined
        ? {}
        : {
            outputTail: step.outputTail.map((line) => ({ ...line, line: mask(line.line) })),
          }),
    })),
  }) as BridgeResult;
}

/** Keeps the engine path-based while giving the sandboxed renderer canonical asset URLs. */
export function projectTheme(theme: ThemeConfig, mask: (text: string) => string): BridgeTheme {
  const fileUrl = (path: string): string => pathToFileURL(path).href;
  return {
    ...(theme.accentColor === undefined ? {} : { accentColor: mask(theme.accentColor) }),
    ...(theme.logo === undefined ? {} : { logo: fileUrl(theme.logo) }),
    ...(theme.banner === undefined ? {} : { banner: fileUrl(theme.banner) }),
    ...(theme.theme === undefined ? {} : { theme: fileUrl(theme.theme) }),
    ...(theme.windowTitle === undefined ? {} : { windowTitle: mask(theme.windowTitle) }),
  };
}

function projectCommand(
  command: ResolvedCommand,
  mask: (text: string) => string,
): BridgePlannedCommand {
  return {
    argv: command.argv.map((value) => mask(projectCommandText(value))),
    cwd: mask(projectCommandText(command.cwd)),
    env: Object.fromEntries(
      Object.entries(command.env).map(([name, value]) => [
        mask(name),
        mask(projectCommandText(value)),
      ]),
    ),
    timeoutSeconds: command.timeoutSeconds,
    successExitCodes: command.successExitCodes,
  };
}

function projectCommandText(value: ResolvedCommand['cwd']): string {
  return String(value);
}
