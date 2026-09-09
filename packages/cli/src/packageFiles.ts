import { copyFileSync, lstatSync, mkdirSync, readdirSync, type Stats } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';

import { UsageError } from '@rune/engine';

const RESOURCE_DIRECTORIES = ['scripts', 'payload', 'assets', 'locales'];

/** Portable archive paths are explicit, relative, and meaningful on both target hosts. */
export function resourcePath(path: string): string {
  const portable = path.replace(/^(?:\.[\\/])+/u, '');
  const parts = portable.split(/[\\/]/u);
  if (
    isAbsolute(portable) ||
    parts.some((part) => part === '' || part === '.' || part === '..' || part.includes(':')) ||
    path.includes('\0')
  ) {
    throw new UsageError('package resources must be paths beneath the manifest directory');
  }
  return parts.join('/');
}

/** Collect only declared workflow resources, without following filesystem links. */
export function workflowFiles(manifest: string, includes: readonly string[]): readonly string[] {
  const root = dirname(manifest);
  const paths = new Set<string>();
  collect(root, resourcePath(relative(root, manifest)), paths);
  for (const directory of RESOURCE_DIRECTORIES) {
    if (lstatSync(join(root, directory), { throwIfNoEntry: false }) !== undefined) {
      collect(root, directory, paths);
    }
  }
  for (const path of includes) collect(root, resourcePath(path), paths);
  return [...paths].sort();
}

function collect(root: string, path: string, files: Set<string>): void {
  const absolute = join(root, path);
  const info = resourceInfo(root, path);
  if (info.isDirectory()) {
    files.add(path);
    for (const child of readdirSync(absolute)) {
      if (resourcePath(child) !== child) throw new UsageError('a package filename is not portable');
      collect(root, path + '/' + child, files);
    }
  } else {
    files.add(path);
  }
}

function resourceInfo(root: string, path: string): Stats {
  let target = root;
  let info = lstatSync(root);
  for (const part of path.split('/')) {
    if (!info.isDirectory()) throw new UsageError('a package resource has an invalid parent');
    target = join(target, part);
    const entry = lstatSync(target, { throwIfNoEntry: false });
    if (entry === undefined) throw new UsageError('a requested package resource does not exist');
    if (!entry.isFile() && !entry.isDirectory()) {
      throw new UsageError('package resources must be regular files or directories, not links');
    }
    info = entry;
  }
  return info;
}

export function copyFiles(root: string, destination: string, files: readonly string[]): void {
  for (const path of files) {
    // Check again at copy time instead of allowing a changed source to become a link.
    const info = resourceInfo(root, path);
    const target = join(destination, path);
    if (info.isDirectory()) {
      mkdirSync(target, { recursive: true });
      continue;
    }
    mkdirSync(dirname(target), { recursive: true });
    copyFileSync(join(root, path), target);
  }
}

/** Runtime archives use the same no-link rule as the installed GUI cache. */
export function shellFiles(root: string): readonly string[] {
  const files = new Set<string>();
  for (const name of readdirSync(root)) {
    if (name !== '.rune-complete.json') collect(root, name, files);
  }
  return [...files].sort();
}

export function inside(root: string, target: string): boolean {
  const path = relative(resolve(root), resolve(target));
  return path !== '' && path !== '..' && !path.startsWith('..' + sep) && !isAbsolute(path);
}
