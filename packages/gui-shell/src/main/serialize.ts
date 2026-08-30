/**
 * The bridge serializer (docs/architecture.md §9.2): every value that crosses towards the
 * renderer — invoke returns and pushed events alike — goes through one projection to
 * JSON-safe plain data first. A `SecretString` serializes to `null` by its own `toJSON`,
 * so a secret can never reach Electron's structured clone (which ignores `toJSON`), and
 * no engine object crosses at all.
 */

import { pathToFileURL } from 'node:url';

import {
  MASK,
  isSecretString,
  type ExecutionPlan,
  type ResolvedCommand,
  type ThemeConfig,
} from '@rune/engine';

import type {
  BridgePlan,
  BridgePlannedCommand,
  BridgePlannedStep,
  BridgeTheme,
} from '../preload/types.js';

export function project<T>(value: T, mask: (text: string) => string = (text) => text): unknown {
  if (value === undefined) {
    return undefined;
  }
  // The reviver applies mask() to every string — the second belt of §10 on top of the
  // wrapper: even a string a secret leaked into crosses masked.
  return JSON.parse(JSON.stringify(value), (_key, entry: unknown) =>
    typeof entry === 'string' ? mask(entry) : entry,
  ) as unknown;
}

/** Projects the engine plan without letting SecretString.toJSON() erase command text. */
export function projectPlan(plan: ExecutionPlan, mask: (text: string) => string): BridgePlan {
  const projected: BridgePlan = {
    manifestPath: plan.manifestPath,
    ...(plan.locale === undefined ? {} : { locale: plan.locale }),
    platform: plan.platform,
    preview: plan.preview,
    failFast: plan.failFast,
    ...(plan.logFile === undefined ? {} : { logFile: plan.logFile }),
    steps: plan.steps.map((step): BridgePlannedStep => {
      if (step.state === 'SKIPPED') {
        return {
          id: step.id,
          title: step.title,
          state: step.state,
          skipReason: step.skipReason,
        };
      }
      return {
        id: step.id,
        title: step.title,
        state: step.state,
        command: projectCommand(step.command),
      };
    }),
  };

  // project() keeps the ordinary-string masking belt and proves the return is plain JSON data.
  return project(projected, mask) as BridgePlan;
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

function projectCommand(command: ResolvedCommand): BridgePlannedCommand {
  return {
    argv: command.argv.map(projectCommandText),
    cwd: projectCommandText(command.cwd),
    env: Object.fromEntries(
      Object.entries(command.env).map(([name, value]) => [name, projectCommandText(value)]),
    ),
    timeoutSeconds: command.timeoutSeconds,
    successExitCodes: command.successExitCodes,
  };
}

function projectCommandText(value: ResolvedCommand['cwd']): string {
  return isSecretString(value) ? MASK : value;
}
