import { lstatSync, readFileSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';

import { UsageError } from '@rune/engine';

/** Read only the package-owned binding, never a manifest discovered in the caller's cwd. */
export function bundledWorkflow(resourcesDirectory: string): string | undefined {
  const binding = join(resourcesDirectory, 'rune-workflow.json');
  const info = lstatSync(binding, { throwIfNoEntry: false });
  if (info === undefined) return undefined;
  if (!info.isFile() || info.size > 4096) {
    throw new UsageError('the bundled workflow binding must be a small regular JSON file');
  }
  let value: unknown;
  try {
    value = JSON.parse(readFileSync(binding, 'utf8'));
  } catch {
    throw new UsageError('the bundled workflow binding is not valid JSON');
  }
  if (
    typeof value !== 'object' ||
    value === null ||
    Object.keys(value).sort().join(',') !== 'manifest,schemaVersion' ||
    !('schemaVersion' in value) ||
    value.schemaVersion !== 1 ||
    !('manifest' in value) ||
    typeof value.manifest !== 'string'
  ) {
    throw new UsageError('the bundled workflow binding has an unsupported schema');
  }
  const parts = value.manifest.split('/');
  if (
    parts.length < 2 ||
    parts[0] !== 'workflow' ||
    isAbsolute(value.manifest) ||
    parts.some((part) => part === '' || part === '.' || part === '..' || /[\\:\0]/u.test(part))
  ) {
    throw new UsageError('the bundled manifest must be beneath resources/workflow');
  }
  let target = resourcesDirectory;
  for (const [index, part] of parts.entries()) {
    target = join(target, part);
    const entry = lstatSync(target, { throwIfNoEntry: false });
    if (index === parts.length - 1 ? entry?.isFile() !== true : entry?.isDirectory() !== true) {
      throw new UsageError('the bundled manifest is missing or uses a filesystem link');
    }
  }
  return resolve(target);
}
