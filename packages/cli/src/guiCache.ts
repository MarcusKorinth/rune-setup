import { createHash, randomUUID } from 'node:crypto';
import {
  closeSync,
  fsyncSync,
  lstatSync,
  openSync,
  readdirSync,
  readFileSync,
  readSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';

const SEAL = '.rune-complete.json';
const CURRENT = 'current';
const VERIFIED_NAME = /^generation-v1-[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$(?![\s\S])/u;
const LEGACY_NAME = /^generation-[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$(?![\s\S])/u;

/** Read-only recovery: never replace a concurrent installer's current selection. */
export function locateCachedShell(
  cache: string,
  binaryName: string,
  engineVersion: string,
): string | undefined {
  const directory = lstatSync(cache, { throwIfNoEntry: false });
  if (directory === undefined) return undefined;
  if (!directory.isDirectory()) throw new Error('invalid cache directory');
  let pointerAbsent = false;
  let selected: string | undefined;
  try {
    const pointer = join(cache, CURRENT);
    const info = lstatSync(pointer, { throwIfNoEntry: false });
    pointerAbsent = info === undefined;
    if (info?.isFile() === true && info.size <= 128) {
      selected = readFileSync(pointer, 'utf8').replace(/\n$/u, '');
      if (VERIFIED_NAME.test(selected)) {
        if (verifyGeneration(join(cache, selected), binaryName, engineVersion)) {
          return join(cache, selected, binaryName);
        }
      } else if (LEGACY_NAME.test(selected) && hasBinary(join(cache, selected), binaryName)) {
        return join(cache, selected, binaryName);
      }
    }
  } catch {
    // Unreadable or torn selection metadata must not hide a surviving complete generation.
  }
  const candidates = readdirSync(cache)
    .filter((name) => VERIFIED_NAME.test(name))
    .sort()
    .reverse();
  for (const name of candidates) {
    if (name !== selected && verifyGeneration(join(cache, name), binaryName, engineVersion)) {
      return join(cache, name, binaryName);
    }
  }
  if (pointerAbsent && lstatSync(join(cache, binaryName), { throwIfNoEntry: false })?.isFile()) {
    return join(cache, binaryName);
  }
  if (!pointerAbsent || candidates.length > 0) throw new Error('no complete cache generation');
  return undefined;
}

/** Seal privately, then retain every visible generation, including after pointer failure. */
export function publishCachedShell(
  staging: string,
  cache: string,
  binaryName: string,
  engineVersion: string,
  onCleanupFailure: (path: string) => void = () => undefined,
): void {
  if (!hasBinary(staging, binaryName)) throw new Error('missing staged binary');
  const digest = treeDigest(staging, true);
  const sealFile = openSync(join(staging, SEAL), 'wx', 0o600);
  try {
    writeFileSync(sealFile, JSON.stringify({ format: 1, runeVersion: engineVersion, digest }), {
      encoding: 'utf8',
      flush: true,
    });
  } finally {
    closeSync(sealFile);
  }
  flushDirectory(staging);

  const name = `generation-v1-${randomUUID()}`;
  renameSync(staging, join(cache, name));
  // A reader can recover this generation now. No later failure may remove its files.
  flushDirectory(cache);
  const pointer = join(cache, `.current-${randomUUID()}.tmp`);
  let pointerCreated = false;
  try {
    const descriptor = openSync(pointer, 'wx', 0o600);
    pointerCreated = true;
    try {
      writeFileSync(descriptor, `${name}\n`, { encoding: 'utf8', flush: true });
    } finally {
      closeSync(descriptor);
    }
    renameSync(pointer, join(cache, CURRENT));
    pointerCreated = false;
    flushDirectory(cache);
  } finally {
    if (pointerCreated) {
      try {
        rmSync(pointer);
      } catch {
        onCleanupFailure(pointer);
      }
    }
  }
}

function hasBinary(directory: string, binaryName: string): boolean {
  return (
    lstatSync(directory, { throwIfNoEntry: false })?.isDirectory() === true &&
    lstatSync(join(directory, binaryName), { throwIfNoEntry: false })?.isFile() === true
  );
}

function verifyGeneration(directory: string, binaryName: string, engineVersion: string): boolean {
  try {
    if (!hasBinary(directory, binaryName)) return false;
    const path = join(directory, SEAL);
    const info = lstatSync(path, { throwIfNoEntry: false });
    if (info?.isFile() !== true || info.size > 1024) return false;
    const seal: unknown = JSON.parse(readFileSync(path, 'utf8'));
    if (typeof seal !== 'object' || seal === null) return false;
    const data = seal as Record<string, unknown>;
    return (
      Object.keys(data).sort().join(',') === 'digest,format,runeVersion' &&
      data['format'] === 1 &&
      data['runeVersion'] === engineVersion &&
      typeof data['digest'] === 'string' &&
      data['digest'] === treeDigest(directory, false)
    );
  } catch {
    return false;
  }
}

/** Framed metadata includes every entry; stream file contents to keep memory bounded. */
function treeDigest(root: string, flush: boolean): string {
  const tree = createHash('sha256');
  const buffer = Buffer.allocUnsafe(64 * 1024);
  const visit = (directory: string, prefix: string): void => {
    for (const name of readdirSync(directory).sort()) {
      if (prefix === '' && name === SEAL) continue;
      const path = join(directory, name);
      const relative = `${prefix}${name}`;
      const info = lstatSync(path);
      const executable = process.platform === 'win32' ? 0 : info.mode & 0o111;
      if (info.isDirectory()) {
        tree.update(JSON.stringify([relative, 'directory', executable]) + '\n');
        visit(path, `${relative}/`);
      } else if (info.isFile()) {
        const descriptor = openSync(path, flush && process.platform === 'win32' ? 'r+' : 'r');
        const file = createHash('sha256');
        let size = 0;
        try {
          let count: number;
          while ((count = readSync(descriptor, buffer, 0, buffer.length, null)) > 0) {
            file.update(buffer.subarray(0, count));
            size += count;
          }
          if (size !== info.size) throw new Error('cache file changed during inspection');
          if (flush) fsyncSync(descriptor);
        } finally {
          closeSync(descriptor);
        }
        tree.update(
          JSON.stringify([relative, 'file', size, executable, file.digest('hex')]) + '\n',
        );
      } else {
        throw new Error('linked or special cache entry');
      }
    }
    if (flush) flushDirectory(directory);
  };
  visit(root, '');
  return tree.digest('hex');
}

function flushDirectory(path: string): void {
  // Windows does not expose POSIX directory fsync through Node; recovery verifies survivors.
  if (process.platform === 'win32') return;
  const descriptor = openSync(path, 'r');
  try {
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
}
