import { posix, resolve as resolvePath, sep, win32 } from 'node:path';

import type { Platform } from './context.js';

/** Any Windows spelling that starts from a root rather than a relative path component. */
export const WINDOWS_ROOTED_PATH_PATTERN = /^[\\/]/;

/** A normal fully qualified Windows drive or UNC path, excluding device namespaces. */
export const WINDOWS_FULLY_QUALIFIED_PATH_PATTERN =
  /^(?:[A-Za-z]:[\\/]|[\\/]{2}(?![\\/])(?!(?:[?.])[\\/])[^\\/]+[\\/][^\\/]+(?:$|[\\/]))/;

export function isFullyQualifiedWindowsPath(value: string): boolean {
  return WINDOWS_FULLY_QUALIFIED_PATH_PATTERN.test(value);
}

export function isWindowsRootedPath(value: string): boolean {
  return WINDOWS_ROOTED_PATH_PATTERN.test(value);
}

/**
 * Resolves a target-relative value from the manifest directory without allowing this host's
 * path grammar to reinterpret it as absolute. Target-absolute values stay byte-identical.
 */
export function resolveTargetPathFrom(value: string, basePath: string, platform: Platform): string {
  const targetPath = platform === 'windows' ? win32 : posix;
  if (targetPath.isAbsolute(value)) {
    return value;
  }
  const hostRelative =
    platform === 'windows' ? value.replace(/[\\/]/g, sep) : value.replace(/\//g, sep);
  return resolvePath(basePath, `.${sep}${hostRelative}`);
}
