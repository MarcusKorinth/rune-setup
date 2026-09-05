/** Private source identity bound to an exact validated manifest instance. */

import { InternalError } from '../errors.js';
import type { ManifestV1 } from './v1/schema.js';

export interface ManifestDescriptor {
  readonly path: string;
  readonly sha256: string;
  readonly schemaVersion: number;
  readonly manifestDir: string;
}

const manifestDescriptors = new WeakMap<ManifestV1, ManifestDescriptor>();

/** Binds the source bytes and path context that produced a validated manifest. */
export function bindManifestDescriptor(manifest: ManifestV1, descriptor: ManifestDescriptor): void {
  manifestDescriptors.set(manifest, Object.freeze(descriptor));
}

/** Internal fail-closed lookup: structural manifest copies have no source identity. */
export function manifestDescriptorFor(manifest: ManifestV1): ManifestDescriptor {
  const descriptor = manifestDescriptors.get(manifest);
  if (descriptor === undefined) {
    throw new InternalError('the manifest was not created by parseManifest or parseManifestText');
  }
  return descriptor;
}
