import { normalize, posix, resolve as resolvePath, sep, toNamespacedPath, win32 } from 'node:path';

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

/** Resolves an already-classified host-relative value from a fixed base directory. */
export function resolveManifestRelativePathFrom(value: string, basePath: string): string {
  return resolvePath(basePath, `.${sep}${value}`);
}

/**
 * True when two anchored absolute paths name the same sink on this host.
 *
 * §4.1 compares a `--result` destination against the effective log file case-insensitively on
 * Windows and case-sensitively on Linux. The engine owns both sinks, so it owns the comparison:
 * a frontend that reimplemented it would let one spelling of the same file through.
 */
export function sameSinkPath(left: string, right: string): boolean {
  if (process.platform === 'win32') {
    return windowsSinkKey(left) === windowsSinkKey(right);
  }
  return normalize(left) === normalize(right);
}

function windowsSinkKey(path: string): string {
  return toNamespacedPath(normalize(path))
    .replace(/^\\\\\.\\([A-Za-z]:\\)/u, String.raw`\\?\$1`)
    .toLowerCase();
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
  return resolveManifestRelativePathFrom(hostRelative, basePath);
}
