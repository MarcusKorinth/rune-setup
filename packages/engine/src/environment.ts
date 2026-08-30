/** A process environment supplied by the host for one invocation. */
export type Environment = Readonly<Record<string, string | undefined>>;

/**
 * Takes an immutable copy so later changes to `process.env` or a caller-owned object cannot
 * change an invocation that is already open.
 */
export function snapshotEnvironment(environment: Environment = process.env): Environment {
  return Object.freeze({ ...environment });
}

/**
 * Reads an environment variable with the host operating system's name semantics: exact on
 * POSIX and case-insensitive on Windows. The exact spelling wins for synthetic environments
 * that contain otherwise-impossible case variants of the same Windows variable.
 */
export function environmentValue(
  environment: Environment,
  name: string,
  platform: NodeJS.Platform = process.platform,
): string | undefined {
  if (Object.hasOwn(environment, name) || platform !== 'win32') {
    return environment[name];
  }

  const foldedName = name.toUpperCase();
  for (const [candidate, value] of Object.entries(environment)) {
    if (candidate.toUpperCase() === foldedName) {
      return value;
    }
  }
  return undefined;
}
