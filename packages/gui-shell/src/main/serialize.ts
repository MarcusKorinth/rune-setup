/**
 * The bridge serializer (docs/architecture.md §9.2): every value that crosses towards the
 * renderer — invoke returns and pushed events alike — goes through one projection to
 * JSON-safe plain data first. A `SecretString` serializes to `null` by its own `toJSON`,
 * so a secret can never reach Electron's structured clone (which ignores `toJSON`), and
 * no engine object crosses at all.
 */

export function project<T>(value: T): unknown {
  if (value === undefined) {
    return undefined;
  }
  return JSON.parse(JSON.stringify(value)) as unknown;
}
