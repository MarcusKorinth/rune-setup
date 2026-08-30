import { posix, resolve as resolvePath, sep, win32 } from 'node:path';

import type { Platform } from './context.js';

/** A Windows path rooted on the process's current drive rather than a named drive or UNC root. */
export const WINDOWS_ROOT_RELATIVE_PATH_PATTERN = /^[\\/](?![\\/])/;

export function isWindowsRootRelativePath(value: string): boolean {
  return WINDOWS_ROOT_RELATIVE_PATH_PATTERN.test(value);
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
