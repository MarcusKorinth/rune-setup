/**
 * The bridge serializer (docs/architecture.md §9.2): every value that crosses towards the
 * renderer — invoke returns and pushed events alike — goes through one projection to
 * JSON-safe plain data first. A `SecretString` serializes to `***` by its own `toJSON`,
 * so a secret can never reach Electron's structured clone (which ignores `toJSON`), and
 * no engine object crosses at all.
 */

import { pathToFileURL } from 'node:url';

import type { ExecutionPlan, RunEvent, RunResult, ThemeConfig } from '@rune/engine';

import type { BridgeEvent, BridgePlan, BridgeResult, BridgeTheme } from '../preload/types.js';

export function project<T>(value: T): unknown {
  if (value === undefined) {
    return undefined;
  }
  return JSON.parse(JSON.stringify(value)) as unknown;
}

/** Projects the complete ExecutionPlan; SecretString.toJSON() supplies its literal mask. */
export function projectPlan(plan: ExecutionPlan): BridgePlan {
  return project(plan) as BridgePlan;
}

/** Projects one run event, routing its plan through the same masked plan contract. */
export function projectEvent(event: RunEvent): BridgeEvent {
  switch (event.kind) {
    case 'runStarted':
      return { kind: event.kind, plan: projectPlan(event.plan) };
    case 'stepStarted':
      return project(event) as BridgeEvent;
    case 'stepOutput':
      return project(event) as BridgeEvent;
    case 'stepFinished':
      return project(event) as BridgeEvent;
    case 'runFinished':
      return { kind: event.kind, result: projectResult(event.result) };
  }
}

/** Results are already field-aware structured-sink projections from the engine. */
export function projectResult(result: RunResult): BridgeResult {
  return project(result) as BridgeResult;
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
