import { isProxy } from 'node:util/types';

/**
 * Copies a native string array without invoking anything the supplied array controls.
 * Proxies are not stable snapshots, and accessors or holes are not list entries, so only an
 * array's own data properties are accepted. The returned snapshot is safe to expose.
 */
export function nativeStringArraySnapshot(value: unknown): readonly string[] | undefined {
  try {
    if (isProxy(value) || !Array.isArray(value)) {
      return undefined;
    }

    const lengthProperty = Object.getOwnPropertyDescriptor(value, 'length');
    const length = lengthProperty?.value;
    if (
      typeof length !== 'number' ||
      !Number.isInteger(length) ||
      length < 0 ||
      length > 0xffff_ffff
    ) {
      return undefined;
    }

    const entries: string[] = [];
    for (let index = 0; index < length; index += 1) {
      const entryProperty = Object.getOwnPropertyDescriptor(value, String(index));
      if (
        entryProperty === undefined ||
        !('value' in entryProperty) ||
        typeof entryProperty.value !== 'string'
      ) {
        return undefined;
      }
      entries[index] = entryProperty.value;
    }
    return Object.freeze(entries);
  } catch {
    return undefined;
  }
}
