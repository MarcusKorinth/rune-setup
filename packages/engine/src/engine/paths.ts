import { posix, resolve as resolvePath, sep, win32 } from 'node:path';

import type { Platform } from './context.js';

/**
 * Resolves a target-relative value from the manifest directory without allowing this host's
 * path grammar to reinterpret it as absolute. Target-absolute values stay byte-identical.
 */
export function resolveTargetPathFrom(value: string, basePath: string, platform: Platform): string {
  const targetPath = platform === 'windows' ? win32 : posix;
  if (targetPath.isAbsolute(value)) {
    return value;
  }
  return resolvePath(basePath, `.${sep}${value}`);
}
