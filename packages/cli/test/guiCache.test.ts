import {
  chmodSync,
  existsSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import type * as Fs from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { locateCachedShell, publishCachedShell } from '../src/guiCache.js';

const faults = vi.hoisted(() => ({
  unreadable: undefined as string | undefined,
  beforeRename: undefined as ((source: string, destination: string) => void) | undefined,
  beforeFlush: undefined as ((descriptor: number) => void) | undefined,
}));

vi.mock('node:fs', async (importOriginal) => {
  const original = await importOriginal<typeof Fs>();
  return {
    ...original,
    readFileSync: (...args: Parameters<typeof original.readFileSync>) => {
      if (String(args[0]) === faults.unreadable) {
        throw Object.assign(new Error('read denied'), { code: 'EACCES' });
      }
      return Reflect.apply(original.readFileSync, original, args) as ReturnType<
        typeof original.readFileSync
      >;
    },
    renameSync: (source: Fs.PathLike, destination: Fs.PathLike) => {
      faults.beforeRename?.(String(source), String(destination));
      original.renameSync(source, destination);
    },
    fsyncSync: (descriptor: number) => {
      faults.beforeFlush?.(descriptor);
      original.fsyncSync(descriptor);
    },
  };
});

const version = '0.1.0';
const binaryName = process.platform === 'win32' ? 'rune-gui-shell.exe' : 'rune-gui-shell';
let directory: string;
let cache: string;
let pointer: string;

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'rune-cache-integrity-'));
  cache = join(directory, 'cache');
  pointer = join(cache, 'current');
  mkdirSync(cache);
});

afterEach(() => {
  faults.unreadable = undefined;
  faults.beforeRename = undefined;
  faults.beforeFlush = undefined;
  rmSync(directory, { recursive: true, force: true });
});

function stage(label: string): string {
  const staging = mkdtempSync(join(cache, '.rune-shell-stage-'));
  mkdirSync(join(staging, 'resources', 'locales'), { recursive: true });
  mkdirSync(join(staging, 'empty'));
  writeFileSync(join(staging, binaryName), `executable-${label}`, { mode: 0o755 });
  writeFileSync(join(staging, 'resources', 'app.asar'), `application-${label}`);
  writeFileSync(join(staging, 'resources', 'locales', 'en-US.pak'), `locale-${label}`);
  return staging;
}

function publish(label: string, engineVersion = version) {
  publishCachedShell(stage(label), cache, binaryName, engineVersion);
  const name = readFileSync(pointer, 'utf8').trim();
  expect(name).toMatch(/^generation-v1-[a-f0-9-]+$/u);
  const generation = join(cache, name);
  return {
    generation,
    binary: join(generation, binaryName),
    resource: join(generation, 'resources', 'app.asar'),
    seal: join(generation, '.rune-complete.json'),
  };
}

function expectReadOnlyRecovery(acceptable: readonly string[]): string | undefined {
  const entries = readdirSync(cache).sort();
  const selection = existsSync(pointer) ? readFileSync(pointer) : undefined;
  const located = locateCachedShell(cache, binaryName, version);
  expect(acceptable).toContain(located);
  expect(readdirSync(cache).sort()).toEqual(entries);
  expect(existsSync(pointer) ? readFileSync(pointer) : undefined).toEqual(selection);
  return located;
}

describe('GUI cache integrity and recovery', () => {
  it('returns no shell for an empty cache', () => {
    expect(locateCachedShell(cache, binaryName, version)).toBeUndefined();
  });

  it.each(['absent', 'empty', 'truncated', 'invalid', 'missing target'] as const)(
    'recovers an intact generation when current is %s without repairing the pointer',
    (damage) => {
      const first = publish('first');
      const second = publish('second');
      if (damage === 'absent') rmSync(pointer);
      else {
        writeFileSync(
          pointer,
          damage === 'empty'
            ? ''
            : damage === 'truncated'
              ? 'generation-v1-12'
              : damage === 'invalid'
                ? '../outside\n'
                : 'generation-v1-00000000-0000-0000-0000-000000000000\n',
        );
      }
      expectReadOnlyRecovery([first.binary, second.binary]);
    },
  );

  it('keeps a valid current selection even when another complete generation exists', () => {
    const selected = publish('selected');
    publish('other');
    writeFileSync(pointer, `${basename(selected.generation)}\n`);
    expectReadOnlyRecovery([selected.binary]);
  });

  it.each(['missing', 'truncated', 'same-size replacement', 'extra file', 'renamed'] as const)(
    'rejects a selected generation with a %s resource and uses the intact generation',
    (damage) => {
      const intact = publish('old');
      const broken = publish('new');
      if (damage === 'missing') rmSync(broken.resource);
      else if (damage === 'truncated') writeFileSync(broken.resource, '');
      else if (damage === 'same-size replacement') {
        writeFileSync(broken.resource, 'x'.repeat(readFileSync(broken.resource).length));
      } else if (damage === 'extra file') {
        writeFileSync(join(broken.generation, 'resources', 'injected.js'), 'replacement');
      } else renameSync(broken.resource, join(dirname(broken.resource), 'renamed.asar'));
      expectReadOnlyRecovery([intact.binary]);
    },
  );

  it.each(['missing', 'empty', 'truncated JSON', 'wrong digest', 'wrong version'] as const)(
    'does not recover a generation with a %s completion record',
    (damage) => {
      const intact = publish('old');
      const broken = publish('new');
      if (damage === 'missing') rmSync(broken.seal);
      else if (damage === 'empty') writeFileSync(broken.seal, '');
      else if (damage === 'truncated JSON') writeFileSync(broken.seal, '{"format":1,');
      else {
        const seal = JSON.parse(readFileSync(broken.seal, 'utf8')) as Record<string, unknown>;
        if (damage === 'wrong digest') seal['digest'] = '0'.repeat(64);
        else seal['runeVersion'] = '9.9.9';
        writeFileSync(broken.seal, JSON.stringify(seal));
      }
      expectReadOnlyRecovery([intact.binary]);
    },
  );

  it.skipIf(process.platform === 'win32')(
    'rejects executable permission changes even when every byte is unchanged',
    () => {
      const intact = publish('old');
      const broken = publish('new');
      chmodSync(broken.binary, 0o644);
      expectReadOnlyRecovery([intact.binary]);
    },
  );

  it.each(['generation', 'nested resource directory'] as const)(
    'never follows a %s symlink or junction to an outside runtime',
    (linkedPart) => {
      const intact = publish('old');
      const broken = publish('new');
      const linked =
        linkedPart === 'generation' ? broken.generation : join(broken.generation, 'resources');
      const outside = join(directory, 'outside');
      renameSync(linked, outside);
      symlinkSync(outside, linked, process.platform === 'win32' ? 'junction' : 'dir');
      expect(lstatSync(linked).isSymbolicLink()).toBe(true);
      expectReadOnlyRecovery([intact.binary]);
      expect(
        readFileSync(join(outside, linkedPart === 'generation' ? binaryName : 'app.asar'), 'utf8'),
      ).toBe(linkedPart === 'generation' ? 'executable-new' : 'application-new');
    },
  );

  it.skipIf(process.platform === 'win32')('never follows a nested resource file symlink', () => {
    const intact = publish('old');
    const broken = publish('new');
    const outside = join(directory, 'outside.asar');
    renameSync(broken.resource, outside);
    symlinkSync(outside, broken.resource);
    expectReadOnlyRecovery([intact.binary]);
    expect(readFileSync(outside, 'utf8')).toBe('application-new');
  });

  it('reports damage when neither generation is intact instead of returning a partial runtime', () => {
    const first = publish('first');
    const second = publish('second');
    rmSync(first.resource);
    writeFileSync(second.resource, '');
    const selection = readFileSync(pointer);
    expect(() => locateCachedShell(cache, binaryName, version)).toThrow(/cache|generation|shell/iu);
    expect(readFileSync(pointer)).toEqual(selection);
  });

  it('recovers around an unreadable current file without writing it', () => {
    const intact = publish('intact');
    const selection = readFileSync(pointer);
    faults.unreadable = pointer;
    expect(locateCachedShell(cache, binaryName, version)).toBe(intact.binary);
    faults.unreadable = undefined;
    expect(readFileSync(pointer)).toEqual(selection);
  });

  it('rejects an unreadable pointer when no complete generation can be recovered', () => {
    const broken = publish('broken');
    rmSync(broken.resource);
    faults.unreadable = pointer;
    expect(() => locateCachedShell(cache, binaryName, version)).toThrow(/cache|generation|shell/iu);
  });

  it('ignores intact generations sealed for another engine version', () => {
    const matching = publish('matching');
    publish('other-version', '9.9.9');
    expectReadOnlyRecovery([matching.binary]);
    rmSync(matching.resource);
    expect(() => locateCachedShell(cache, binaryName, version)).toThrow(/cache|generation|shell/iu);
  });

  it('ignores staging trees, pointer temporaries, and unsealed orphan generations', () => {
    stage('interrupted');
    const oldGeneration = join(cache, 'generation-11111111-1111-1111-1111-111111111111');
    mkdirSync(oldGeneration);
    writeFileSync(join(oldGeneration, binaryName), 'unsealed old runtime');
    writeFileSync(join(cache, '.current-interrupted.tmp'), `${basename(oldGeneration)}\n`);
    expect(locateCachedShell(cache, binaryName, version)).toBeUndefined();
    const intact = publish('intact');
    rmSync(pointer);
    expectReadOnlyRecovery([intact.binary]);
  });

  it('reports an incomplete new generation when no complete runtime survives', () => {
    const incomplete = join(cache, 'generation-v1-22222222-2222-2222-2222-222222222222');
    mkdirSync(incomplete);
    writeFileSync(join(incomplete, binaryName), 'unsealed new runtime');
    expect(() => locateCachedShell(cache, binaryName, version)).toThrow(/cache|generation|shell/iu);
    const intact = publish('intact');
    rmSync(pointer);
    expectReadOnlyRecovery([intact.binary]);
  });

  it('accepts an old unsealed generation only while current explicitly selects it', () => {
    const legacy = join(cache, 'generation-11111111-1111-1111-1111-111111111111');
    mkdirSync(legacy);
    const binary = join(legacy, binaryName);
    writeFileSync(binary, 'legacy executable');
    writeFileSync(pointer, `${basename(legacy)}\n`);
    expectReadOnlyRecovery([binary]);
    rmSync(pointer);
    expect(locateCachedShell(cache, binaryName, version)).toBeUndefined();
  });

  it('uses a direct legacy binary only without current or a verified generation', () => {
    const legacy = join(cache, binaryName);
    writeFileSync(legacy, 'legacy executable');
    expect(locateCachedShell(cache, binaryName, version)).toBe(legacy);
    writeFileSync(pointer, 'torn');
    expect(() => locateCachedShell(cache, binaryName, version)).toThrow(/cache|generation|shell/iu);
    rmSync(pointer);
    const complete = publish('complete');
    rmSync(pointer);
    expectReadOnlyRecovery([complete.binary]);
  });

  it('does not publish a generation when an extracted-file flush fails', () => {
    const selected = publish('old');
    const staging = stage('new');
    const resource = lstatSync(join(staging, 'resources', 'app.asar'));
    const entries = readdirSync(cache).sort();
    const selection = readFileSync(pointer);
    const failure = Object.assign(new Error('resource flush failed'), { code: 'EIO' });
    faults.beforeFlush = (descriptor) => {
      const openFile = fstatSync(descriptor);
      if (openFile.isFile() && openFile.dev === resource.dev && openFile.ino === resource.ino) {
        throw failure;
      }
    };
    expect(() => publishCachedShell(staging, cache, binaryName, version)).toThrow(failure);
    faults.beforeFlush = undefined;
    expect(readdirSync(cache).sort()).toEqual(entries);
    expect(readFileSync(pointer)).toEqual(selection);
    expectReadOnlyRecovery([selected.binary]);
  });

  it.skipIf(process.platform === 'win32')(
    'retains a complete visible generation if flushing its cache directory fails',
    () => {
      const selected = publish('old');
      const staging = stage('new');
      const cacheInfo = lstatSync(cache);
      const selection = readFileSync(pointer, 'utf8');
      const entries = new Set(readdirSync(cache));
      const failure = Object.assign(new Error('generation directory flush failed'), {
        code: 'EIO',
      });
      faults.beforeFlush = (descriptor) => {
        const openDirectory = fstatSync(descriptor);
        if (
          openDirectory.isDirectory() &&
          openDirectory.dev === cacheInfo.dev &&
          openDirectory.ino === cacheInfo.ino &&
          readFileSync(pointer, 'utf8') === selection
        ) {
          throw failure;
        }
      };
      expect(() => publishCachedShell(staging, cache, binaryName, version)).toThrow(failure);
      faults.beforeFlush = undefined;
      expect(readFileSync(pointer, 'utf8')).toBe(selection);
      const visible = readdirSync(cache).filter(
        (name) => name.startsWith('generation-v1-') && !entries.has(name),
      );
      expect(visible).toHaveLength(1);
      const binary = join(cache, visible[0]!, binaryName);
      expect(readFileSync(binary, 'utf8')).toBe('executable-new');
      expect(locateCachedShell(cache, binaryName, version)).toBe(selected.binary);
      rmSync(selected.resource);
      expectReadOnlyRecovery([binary]);
      expect(readFileSync(selected.binary, 'utf8')).toBe('executable-old');
    },
  );

  it.skipIf(process.platform === 'win32')(
    'does not roll back current or delete a runtime if the final directory flush fails',
    () => {
      const previous = publish('old');
      const staging = stage('new');
      const cacheInfo = lstatSync(cache);
      const oldSelection = readFileSync(pointer, 'utf8');
      const failure = Object.assign(new Error('selection directory flush failed'), { code: 'EIO' });
      let pinned: string | undefined;
      faults.beforeFlush = (descriptor) => {
        const openDirectory = fstatSync(descriptor);
        if (
          openDirectory.isDirectory() &&
          openDirectory.dev === cacheInfo.dev &&
          openDirectory.ino === cacheInfo.ino &&
          readFileSync(pointer, 'utf8') !== oldSelection
        ) {
          pinned = locateCachedShell(cache, binaryName, version);
          throw failure;
        }
      };
      expect(() => publishCachedShell(staging, cache, binaryName, version)).toThrow(failure);
      faults.beforeFlush = undefined;
      expect(pinned).toBeDefined();
      expect(readFileSync(pointer, 'utf8')).not.toBe(oldSelection);
      expectReadOnlyRecovery([pinned!]);
      expect(readFileSync(pinned!, 'utf8')).toBe('executable-new');
      expect(readFileSync(previous.binary, 'utf8')).toBe('executable-old');
      expect(readFileSync(previous.resource, 'utf8')).toBe('application-old');
    },
  );

  it('refuses an existing completion record in staging without replacing or trusting it', () => {
    const selected = publish('old');
    const staging = stage('old');
    const receipt = readFileSync(selected.seal);
    const stagedReceipt = join(staging, '.rune-complete.json');
    writeFileSync(stagedReceipt, receipt);
    const entries = readdirSync(cache).sort();
    expect(() => publishCachedShell(staging, cache, binaryName, version)).toThrow(/EEXIST/u);
    expect(readFileSync(stagedReceipt)).toEqual(receipt);
    expect(readdirSync(cache).sort()).toEqual(entries);
    expectReadOnlyRecovery([selected.binary]);
  });

  it('retains a visible complete generation after pointer publication fails', () => {
    const selected = publish('old');
    const previousEntries = new Set(readdirSync(cache));
    const staging = stage('new');
    const failure = Object.assign(new Error('pointer rename failed'), { code: 'EIO' });
    let readDuringPublication: string | undefined;
    faults.beforeRename = (_source, destination) => {
      if (destination !== pointer) return;
      readDuringPublication = locateCachedShell(cache, binaryName, version);
      throw failure;
    };
    expect(() => publishCachedShell(staging, cache, binaryName, version)).toThrow(failure);
    faults.beforeRename = undefined;
    expect(readDuringPublication).toBe(selected.binary);
    expect(locateCachedShell(cache, binaryName, version)).toBe(selected.binary);
    const retained = readdirSync(cache).filter(
      (name) => name.startsWith('generation-v1-') && !previousEntries.has(name),
    );
    expect(retained).toHaveLength(1);
    const recovered = join(cache, retained[0]!, binaryName);
    expect(readFileSync(recovered, 'utf8')).toBe('executable-new');
    rmSync(selected.resource);
    expectReadOnlyRecovery([recovered]);
    expect(readFileSync(selected.binary, 'utf8')).toBe('executable-old');
  });

  it('preserves a reader that recovers the first generation before pointer publication fails', () => {
    const staging = stage('first');
    let pinned: string | undefined;
    faults.beforeRename = (_source, destination) => {
      if (destination !== pointer) return;
      expect(existsSync(pointer)).toBe(false);
      pinned = locateCachedShell(cache, binaryName, version);
      throw new Error('first pointer publication interrupted');
    };
    expect(() => publishCachedShell(staging, cache, binaryName, version)).toThrow(
      'first pointer publication interrupted',
    );
    faults.beforeRename = undefined;
    expect(pinned).toBeDefined();
    expectReadOnlyRecovery([pinned!]);
    expect(readFileSync(pinned!, 'utf8')).toBe('executable-first');
    expect(readFileSync(join(dirname(pinned!), 'resources', 'app.asar'), 'utf8')).toBe(
      'application-first',
    );
  });

  it('rejects a linked resource tree before publication without changing the current runtime', () => {
    const current = publish('current');
    const staging = stage('linked');
    const resources = join(staging, 'resources');
    const outside = join(directory, 'outside');
    renameSync(resources, outside);
    symlinkSync(outside, resources, process.platform === 'win32' ? 'junction' : 'dir');
    expect(() => publishCachedShell(staging, cache, binaryName, version)).toThrow();
    expectReadOnlyRecovery([current.binary]);
    expect(readFileSync(join(outside, 'app.asar'), 'utf8')).toBe('application-linked');
  });

  it.each([false, true])(
    'retains both complete generations when publishers interleave (outer fails: %s)',
    (outerFails) => {
      const prior = publish('prior');
      const staging = stage('outer');
      let inner: ReturnType<typeof publish> | undefined;
      faults.beforeRename = (_source, destination) => {
        if (destination !== pointer) return;
        faults.beforeRename = undefined;
        inner = publish('inner');
        expect(locateCachedShell(cache, binaryName, version)).toBe(inner.binary);
        if (outerFails) throw new Error('outer publisher interrupted');
      };
      if (outerFails) {
        expect(() => publishCachedShell(staging, cache, binaryName, version)).toThrow(
          'outer publisher interrupted',
        );
      } else publishCachedShell(staging, cache, binaryName, version);
      const generations = readdirSync(cache).filter((name) => name.startsWith('generation-v1-'));
      expect(generations).toHaveLength(3);
      const selected = locateCachedShell(cache, binaryName, version);
      expect(readFileSync(selected!, 'utf8')).toBe(
        outerFails ? 'executable-inner' : 'executable-outer',
      );
      expect(readFileSync(prior.binary, 'utf8')).toBe('executable-prior');
      expect(readFileSync(inner!.binary, 'utf8')).toBe('executable-inner');
    },
  );
});
