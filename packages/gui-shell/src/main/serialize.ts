/**
 * The bridge serializer (docs/architecture.md §9.2): every value that crosses towards the
 * renderer — invoke returns and pushed events alike — goes through one projection to
 * JSON-safe plain data first. A `SecretString` serializes to `null` by its own `toJSON`,
 * so a secret can never reach Electron's structured clone (which ignores `toJSON`), and
 * no engine object crosses at all.
 */

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
