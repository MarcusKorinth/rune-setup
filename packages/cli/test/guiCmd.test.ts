import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import {
  closeSync,
  createWriteStream,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, relative } from 'node:path';
import { Duplex, PassThrough } from 'node:stream';
import type * as Fs from 'node:fs';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  CancelToken,
  CancelledError,
  PlatformError,
  RUNE_VERSION,
  UsageError,
  exitCodeFor,
} from '@rune/engine';

import { guiInstallCommand, launchGui, locateShell, shellCacheDir } from '../src/guiCmd.js';
import { createSignalController } from '../src/signals.js';

import type { CliIo } from '../src/io.js';
import type { Interaction } from '../src/prompt.js';

vi.mock('node:child_process', () => ({ spawn: vi.fn() }));
vi.mock('node:fs', async (importOriginal) => {
  const fs = await importOriginal<typeof Fs>();
  return {
    ...fs,
    closeSync: vi.fn(fs.closeSync),
    createWriteStream: vi.fn(fs.createWriteStream),
    lstatSync: vi.fn(fs.lstatSync),
    mkdirSync: vi.fn(fs.mkdirSync),
    mkdtempSync: vi.fn(fs.mkdtempSync),
    openSync: vi.fn(fs.openSync),
    readFileSync: vi.fn(fs.readFileSync),
    renameSync: vi.fn(fs.renameSync),
    rmSync: vi.fn(fs.rmSync),
    writeFileSync: vi.fn(fs.writeFileSync),
  };
});

const savedLocalAppData = process.env['LOCALAPPDATA'];
const savedXdgCacheHome = process.env['XDG_CACHE_HOME'];
const savedGuiShell = process.env['RUNE_GUI_SHELL'];
const spawnMock = vi.mocked(spawn);
const closeSyncMock = vi.mocked(closeSync);
const createWriteStreamMock = vi.mocked(createWriteStream);
const lstatSyncMock = vi.mocked(lstatSync);
const mkdirSyncMock = vi.mocked(mkdirSync);
const mkdtempSyncMock = vi.mocked(mkdtempSync);
const openSyncMock = vi.mocked(openSync);
const readFileSyncMock = vi.mocked(readFileSync);
const renameSyncMock = vi.mocked(renameSync);
const rmSyncMock = vi.mocked(rmSync);
const writeFileSyncMock = vi.mocked(writeFileSync);
const platformDescriptor = Object.getOwnPropertyDescriptor(process, 'platform')!;

let testDirectory: string;
let tarExit: number;
let tarCreatesShell: boolean;

const shellBinary = process.platform === 'win32' ? 'rune-gui-shell.exe' : 'rune-gui-shell';

beforeEach(() => {
  testDirectory = mkdtempSync(join(tmpdir(), 'rune-gui-install-test-'));
  process.env['LOCALAPPDATA'] = testDirectory;
  process.env['XDG_CACHE_HOME'] = testDirectory;
  process.env['RUNE_GUI_SHELL'] = join(testDirectory, shellBinary);
  tarExit = 0;
  tarCreatesShell = true;
  spawnMock.mockReset();
  spawnMock.mockImplementation((_command, args) => {
    const child = new EventEmitter();
    queueMicrotask(() => {
      const extractionDirectory = Array.isArray(args) ? args[3] : undefined;
      if (tarCreatesShell && typeof extractionDirectory === 'string') {
        writeFileSync(join(extractionDirectory, shellBinary), 'new shell');
      }
      child.emit('close', tarExit);
    });
    return child as ReturnType<typeof spawn>;
  });
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response('archive')),
  );
});

afterEach(() => {
  rmSync(testDirectory, { recursive: true, force: true });
  if (savedLocalAppData === undefined) delete process.env['LOCALAPPDATA'];
  else process.env['LOCALAPPDATA'] = savedLocalAppData;
  if (savedXdgCacheHome === undefined) delete process.env['XDG_CACHE_HOME'];
  else process.env['XDG_CACHE_HOME'] = savedXdgCacheHome;
  if (savedGuiShell === undefined) delete process.env['RUNE_GUI_SHELL'];
  else process.env['RUNE_GUI_SHELL'] = savedGuiShell;
  vi.unstubAllGlobals();
  vi.clearAllMocks();
  Object.defineProperty(process, 'platform', platformDescriptor);
});

function stubHostPlatform(platform: NodeJS.Platform): void {
  Object.defineProperty(process, 'platform', { ...platformDescriptor, value: platform });
}

function capture(): CliIo {
  return { stdout: vi.fn(), stderr: vi.fn() };
}

const interaction: Interaction = {
  input: new PassThrough(),
  isTTY: false,
  write: () => undefined,
  forceExit: () => undefined,
};

function probeProcess(output: string, code: number | null = 0): ReturnType<typeof spawn> {
  const child = new EventEmitter() as EventEmitter & { stdout: PassThrough };
  child.stdout = new PassThrough();
  queueMicrotask(() => {
    child.stdout.end(output);
    child.emit('close', code);
  });
  return child as unknown as ReturnType<typeof spawn>;
}

function waitingProbe(pid = 3131): {
  readonly child: ReturnType<typeof spawn>;
  readonly events: EventEmitter & { readonly stdout: PassThrough };
  readonly close: (output: string, code?: number | null) => void;
} {
  const child = new EventEmitter() as EventEmitter & { stdout: PassThrough; pid: number };
  child.stdout = new PassThrough();
  child.pid = pid;
  return {
    child: child as unknown as ReturnType<typeof spawn>,
    events: child,
    close: (output, code = 0) => {
      if (!child.stdout.writableEnded && !child.stdout.destroyed) child.stdout.end(output);
      child.emit('close', code);
    },
  };
}

function probeErrorProcess(message: string): ReturnType<typeof spawn> {
  const child = new EventEmitter() as EventEmitter & { stdout: PassThrough };
  child.stdout = new PassThrough();
  queueMicrotask(() => child.emit('error', new Error(message)));
  return child as unknown as ReturnType<typeof spawn>;
}

function runProcess(code: number | null = 0): ReturnType<typeof spawn> {
  const child = new EventEmitter();
  const options = spawnMock.mock.lastCall?.[2];
  if (process.platform === 'linux' && options?.env?.['RUNE_GUI_STARTUP_TOKEN'] !== undefined) {
    attachStartupPipe(child, () => child.emit('close', code));
  } else queueMicrotask(() => child.emit('close', code));
  return child as ReturnType<typeof spawn>;
}

function attachStartupPipe(child: EventEmitter, onDecision?: () => void): void {
  let sentReady = false;
  const pipe = new Duplex({
    read() {
      if (sentReady) return;
      sentReady = true;
      const token = spawnMock.mock.lastCall?.[2]?.env?.['RUNE_GUI_STARTUP_TOKEN'];
      this.push(Buffer.from(`READY ${token}\n`));
    },
    write(_chunk, _encoding, callback) {
      callback();
      if (onDecision !== undefined) setImmediate(onDecision);
    },
  });
  Object.assign(child, { stdio: [null, null, null, pipe], unref: vi.fn() });
}

function errorProcess(message: string): ReturnType<typeof spawn> {
  const child = new EventEmitter();
  Object.assign(child, { unref: vi.fn() });
  queueMicrotask(() => child.emit('error', new Error(message)));
  return child as ReturnType<typeof spawn>;
}

function waitingProcess(
  pid: number,
): EventEmitter & { pid: number; kill: ReturnType<typeof vi.fn> } {
  const child = new EventEmitter() as EventEmitter & {
    pid: number;
    kill: ReturnType<typeof vi.fn>;
  };
  child.pid = pid;
  child.kill = vi.fn();
  if (process.platform === 'linux') attachStartupPipe(child);
  return child;
}

function developmentShell(): { readonly directory: string; readonly electron: string } {
  const directory = join(testDirectory, 'development-shell');
  const electronPackage = join(directory, 'node_modules', 'electron');
  const electron = join(electronPackage, 'dist', 'electron');
  mkdirSync(dirname(electron), { recursive: true });
  writeFileSync(electron, 'prepared binary');
  writeFileSync(join(electronPackage, 'path.txt'), 'electron');
  writeFileSync(join(directory, 'package.json'), JSON.stringify({ private: true }), 'utf8');
  writeFileSync(
    join(electronPackage, 'package.json'),
    JSON.stringify({ name: 'electron', version: '0.0.0', main: 'index.cjs' }),
    'utf8',
  );
  writeFileSync(
    join(electronPackage, 'index.cjs'),
    'throw new Error("the Electron Node entry must never run");\n',
    'utf8',
  );
  return { directory, electron };
}

function downloadedArchive(): string {
  const args = spawnMock.mock.calls[0]?.[1];
  if (!Array.isArray(args) || typeof args[1] !== 'string') {
    throw new Error('tar was not called with an archive path');
  }
  return args[1];
}

function shellTemporaryDirectories(): readonly string[] {
  return readdirSync(tmpdir()).filter((entry) => entry.startsWith('rune-gui-install-'));
}

function cachedGeneration(contents = 'existing shell'): { name: string; binary: string } {
  const name = `generation-${randomUUID()}`;
  const binary = join(shellCacheDir(), name, shellBinary);
  mkdirSync(dirname(binary), { recursive: true });
  writeFileSync(binary, contents);
  writeFileSync(join(shellCacheDir(), 'current'), `${name}\n`);
  return { name, binary };
}

function selectedBinary(): string {
  const location = locateShell({});
  expect(location?.kind).toBe('binary');
  if (location?.kind !== 'binary') throw new Error('no selected shell');
  return location.path;
}

function isTemporaryPointer(path: unknown): path is string {
  return typeof path === 'string' && /^\.current-[a-f0-9-]{36}\.tmp$/u.test(basename(path));
}

describe('rune gui install temporary archive', () => {
  it('refuses an unsupported host before creating temporary storage, fetching, or caching', async () => {
    const temporaryDirectories = shellTemporaryDirectories();
    const io = capture();
    stubHostPlatform('darwin');

    const error = await guiInstallCommand(io).catch((cause: unknown) => cause);

    expect(error).toBeInstanceOf(PlatformError);
    expect(exitCodeFor(error)).toBe(2);
    expect((error as PlatformError).message).toBe(
      'host platform "darwin" is not supported; supported Node platforms are win32 and linux',
    );
    expect(fetch).not.toHaveBeenCalled();
    expect(spawnMock).not.toHaveBeenCalled();
    expect(existsSync(shellCacheDir())).toBe(false);
    expect(shellTemporaryDirectories()).toEqual(temporaryDirectories);
    expect(io.stderr).not.toHaveBeenCalled();
  });

  it('uses a private random directory and removes it after success', async () => {
    await guiInstallCommand(capture());

    const archive = downloadedArchive();
    const archiveName =
      process.platform === 'win32' ? 'rune-gui-shell-windows.zip' : 'rune-gui-shell-linux.tar.gz';
    expect(archive).not.toBe(join(tmpdir(), `rune-shell-${process.pid}-${archiveName}`));
    expect(dirname(archive)).not.toBe(tmpdir());
    expect(basename(dirname(archive))).toMatch(/^rune-gui-install-/u);
    expect(basename(archive)).toBe(archiveName);
    expect(existsSync(dirname(archive))).toBe(false);
    expect(fetch).toHaveBeenCalledWith(
      `https://github.com/MarcusKorinth/rune-setup/releases/download/v${RUNE_VERSION}/${archiveName}`,
    );
    expect(spawnMock).toHaveBeenCalledWith('tar', ['-xf', archive, '-C', expect.any(String)], {
      stdio: ['ignore', 'ignore', 'inherit'],
      shell: false,
    });
  });

  it('removes the private temporary directory when tar fails', async () => {
    tarExit = 2;

    await expect(guiInstallCommand(capture())).rejects.toMatchObject({ code: 1 });

    expect(existsSync(dirname(downloadedArchive()))).toBe(false);
  });

  it('reports a temporary-directory creation failure as an installation failure', async () => {
    const before = shellTemporaryDirectories();
    mkdtempSyncMock.mockImplementationOnce(() => {
      throw Object.assign(new Error('permission denied'), { code: 'EACCES' });
    });
    const io = capture();

    await expect(guiInstallCommand(io)).rejects.toMatchObject({ code: 1 });

    expect(io.stderr).toHaveBeenCalledWith(
      expect.stringContaining('could not create temporary storage'),
    );
    expect(fetch).not.toHaveBeenCalled();
    expect(shellTemporaryDirectories()).toEqual(before);
  });
});

describe('rune gui install download failures', () => {
  it('escapes control characters in a release status diagnostic', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: false,
        body: null,
        status: 503,
        statusText: 'unavailable\nFORGED',
      })),
    );
    const io = capture();

    await expect(guiInstallCommand(io)).rejects.toMatchObject({ code: 1 });

    expect(io.stderr).toHaveBeenCalledWith(
      `no shell release for engine ${RUNE_VERSION} (503 unavailable\\nFORGED)`,
    );
  });

  it('reports a rejected fetch as an installation failure without invoking tar', async () => {
    const existingShell = join(shellCacheDir(), shellBinary);
    mkdirSync(dirname(existingShell), { recursive: true });
    writeFileSync(existingShell, 'existing shell');
    const before = shellTemporaryDirectories();
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => Promise.reject(new Error('offline'))),
    );
    const io = capture();

    await expect(guiInstallCommand(io)).rejects.toMatchObject({ code: 1 });

    expect(io.stderr).toHaveBeenCalledWith(
      expect.stringContaining('check your network connection'),
    );
    expect(spawnMock).not.toHaveBeenCalled();
    expect(shellTemporaryDirectories()).toEqual(before);
    expect(readFileSync(existingShell, 'utf8')).toBe('existing shell');
  });

  it('reports a response stream failure as an installation failure without invoking tar', async () => {
    const existingShell = join(shellCacheDir(), shellBinary);
    mkdirSync(dirname(existingShell), { recursive: true });
    writeFileSync(existingShell, 'existing shell');
    const before = shellTemporaryDirectories();
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('partial archive'));
        controller.error(new Error('connection lost'));
      },
    });
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(body)),
    );
    const io = capture();

    await expect(guiInstallCommand(io)).rejects.toMatchObject({ code: 1 });

    expect(io.stderr).toHaveBeenCalledWith(
      expect.stringContaining('check your network connection'),
    );
    expect(spawnMock).not.toHaveBeenCalled();
    expect(shellTemporaryDirectories()).toEqual(before);
    expect(readFileSync(existingShell, 'utf8')).toBe('existing shell');
  });

  it('reports a temporary-storage failure as an installation failure without invoking tar', async () => {
    const existingShell = join(shellCacheDir(), shellBinary);
    mkdirSync(dirname(existingShell), { recursive: true });
    writeFileSync(existingShell, 'existing shell');
    const before = shellTemporaryDirectories();
    createWriteStreamMock.mockImplementationOnce(() => {
      const output = new PassThrough();
      queueMicrotask(() => {
        output.destroy(Object.assign(new Error('disk full'), { code: 'ENOSPC' }));
      });
      return output as unknown as ReturnType<typeof createWriteStream>;
    });
    const io = capture();

    await expect(guiInstallCommand(io)).rejects.toMatchObject({ code: 1 });

    expect(io.stderr).toHaveBeenCalledWith(
      'could not write the GUI shell archive to temporary storage — check temporary-directory permissions and available disk space',
    );
    expect(spawnMock).not.toHaveBeenCalled();
    expect(shellTemporaryDirectories()).toEqual(before);
    expect(readFileSync(existingShell, 'utf8')).toBe('existing shell');
  });

  it('preserves the download failure when temporary cleanup also fails', async () => {
    const before = new Set(shellTemporaryDirectories());
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => Promise.reject(new Error('offline'))),
    );
    rmSyncMock.mockImplementationOnce(() => {
      throw Object.assign(new Error('permission denied'), { code: 'EACCES' });
    });
    const io = capture();

    try {
      await expect(guiInstallCommand(io)).rejects.toMatchObject({ code: 1 });

      expect(io.stderr).toHaveBeenCalledWith(
        expect.stringContaining('check your network connection'),
      );
      expect(io.stderr).toHaveBeenCalledWith(
        expect.stringContaining('warning: could not remove temporary GUI shell files'),
      );
    } finally {
      for (const entry of shellTemporaryDirectories()) {
        if (!before.has(entry)) {
          rmSync(join(tmpdir(), entry), { recursive: true, force: true });
        }
      }
    }
  });
});

describe('rune gui install atomic cache promotion', () => {
  it('escapes control characters in the installed cache path', async () => {
    process.env['LOCALAPPDATA'] = join(testDirectory, 'cache\u2028FORGED');
    process.env['XDG_CACHE_HOME'] = join(testDirectory, 'cache\u2028FORGED');
    const io = capture();

    await guiInstallCommand(io);

    expect(io.stderr).toHaveBeenCalledWith(
      `GUI shell ${RUNE_VERSION} installed to ${shellCacheDir().replace('\u2028', '\\u2028')}`,
    );
  });

  it('reports cache-directory setup failures as installation failures', async () => {
    const previous = cachedGeneration();
    mkdirSyncMock.mockImplementationOnce(() => {
      throw Object.assign(new Error('permission denied'), { code: 'EACCES' });
    });
    const io = capture();

    await expect(guiInstallCommand(io)).rejects.toMatchObject({ code: 1 });

    expect(io.stderr).toHaveBeenCalledWith(expect.stringContaining('could not prepare'));
    expect(spawnMock).not.toHaveBeenCalled();
    expect(selectedBinary()).toBe(previous.binary);
    expect(readFileSync(previous.binary, 'utf8')).toBe('existing shell');
  });

  it('keeps the current generation intact when private staging-directory creation fails', async () => {
    const previous = cachedGeneration();
    const realMkdtempSync = mkdtempSyncMock.getMockImplementation()!;
    mkdtempSyncMock.mockImplementationOnce(realMkdtempSync).mockImplementationOnce(() => {
      throw new Error('staging directory denied');
    });
    const io = capture();

    await expect(guiInstallCommand(io)).rejects.toMatchObject({ code: 1 });

    expect(io.stderr).toHaveBeenCalledWith(expect.stringContaining('could not prepare'));
    expect(spawnMock).not.toHaveBeenCalled();
    expect(selectedBinary()).toBe(previous.binary);
    expect(readFileSync(previous.binary, 'utf8')).toBe('existing shell');
  });

  it('does not make a partially extracted shell locatable when tar fails', async () => {
    tarExit = 2;

    await expect(guiInstallCommand(capture())).rejects.toMatchObject({ code: 1 });

    expect(locateShell({})).toBeUndefined();
  });

  it('keeps an existing cache intact when tar writes the shell and then fails', async () => {
    const existingShell = join(shellCacheDir(), shellBinary);
    mkdirSync(dirname(existingShell), { recursive: true });
    writeFileSync(existingShell, 'existing shell');
    tarExit = 2;

    await expect(guiInstallCommand(capture())).rejects.toMatchObject({ code: 1 });

    expect(locateShell({})).toEqual({ kind: 'binary', path: existingShell });
    expect(readFileSync(existingShell, 'utf8')).toBe('existing shell');
  });

  it('publishes a complete generation and retains a previously located legacy shell', async () => {
    const legacyShell = join(shellCacheDir(), shellBinary);
    mkdirSync(dirname(legacyShell), { recursive: true });
    writeFileSync(legacyShell, 'existing shell');

    await guiInstallCommand(capture());

    const installedShell = selectedBinary();
    const generationName = basename(dirname(installedShell));
    expect(generationName).toMatch(/^generation-v1-[a-f0-9-]{36}$/u);
    expect(dirname(dirname(installedShell))).toBe(shellCacheDir());
    expect(readFileSync(join(shellCacheDir(), 'current'), 'utf8')).toBe(`${generationName}\n`);
    expect(writeFileSyncMock).toHaveBeenCalledWith(expect.any(Number), `${generationName}\n`, {
      encoding: 'utf8',
      flush: true,
    });
    expect(openSyncMock).toHaveBeenCalledWith(expect.any(String), 'wx', 0o600);
    expect(readFileSync(installedShell, 'utf8')).toBe('new shell');
    expect(readFileSync(legacyShell, 'utf8')).toBe('existing shell');
    expect(readdirSync(shellCacheDir()).sort()).toEqual(
      ['current', generationName, shellBinary].sort(),
    );
  });

  it('retains published generations when another installation becomes current', async () => {
    const previous = cachedGeneration();

    await guiInstallCommand(capture());

    const installedShell = selectedBinary();
    expect(installedShell).not.toBe(previous.binary);
    expect(readFileSync(installedShell, 'utf8')).toBe('new shell');
    expect(readFileSync(previous.binary, 'utf8')).toBe('existing shell');
    expect(readdirSync(shellCacheDir()).sort()).toEqual(
      ['current', previous.name, basename(dirname(installedShell))].sort(),
    );
  });

  it('rejects an archive without the expected shell binary without promotion', async () => {
    const existingShell = join(shellCacheDir(), shellBinary);
    mkdirSync(dirname(existingShell), { recursive: true });
    writeFileSync(existingShell, 'existing shell');
    tarCreatesShell = false;

    await expect(guiInstallCommand(capture())).rejects.toMatchObject({ code: 1 });

    expect(locateShell({})).toEqual({ kind: 'binary', path: existingShell });
    expect(readFileSync(existingShell, 'utf8')).toBe('existing shell');
  });

  it('reports a staged-shell inspection failure without replacing the existing cache', async () => {
    const existingShell = join(shellCacheDir(), shellBinary);
    mkdirSync(dirname(existingShell), { recursive: true });
    writeFileSync(existingShell, 'existing shell');
    lstatSyncMock.mockImplementationOnce(() => {
      throw Object.assign(new Error('permission denied'), { code: 'EACCES' });
    });
    const io = capture();

    await expect(guiInstallCommand(io)).rejects.toMatchObject({ code: 1 });

    expect(io.stderr).toHaveBeenCalledWith(expect.stringContaining('could not inspect'));
    expect(readFileSync(existingShell, 'utf8')).toBe('existing shell');
  });

  it.each([
    'generation rename',
    'pointer creation',
    'pointer write or flush',
    'pointer close',
    'pointer rename',
  ])('keeps the current generation intact when %s fails', async (failure) => {
    const previous = cachedGeneration();
    const realRenameSync = renameSyncMock.getMockImplementation()!;
    const realOpenSync = openSyncMock.getMockImplementation()!;
    const realWriteFileSync = writeFileSyncMock.getMockImplementation()!;
    const realCloseSync = closeSyncMock.getMockImplementation()!;
    let pointerDescriptor: number | undefined;
    const fail = (): never => {
      throw Object.assign(new Error('permission denied'), { code: 'EACCES' });
    };
    openSyncMock.mockImplementation((path, flags, mode) => {
      if (isTemporaryPointer(path) && failure === 'pointer creation') fail();
      const descriptor = realOpenSync(path, flags, mode);
      if (isTemporaryPointer(path)) pointerDescriptor = descriptor;
      return descriptor;
    });
    renameSyncMock.mockImplementation((from, to) => {
      if (
        (failure === 'generation rename' && basename(String(to)).startsWith('generation-v1-')) ||
        (failure === 'pointer rename' && isTemporaryPointer(from))
      ) {
        fail();
      }
      return realRenameSync(from, to);
    });
    writeFileSyncMock.mockImplementation((file, data, options) => {
      if (file === pointerDescriptor && failure === 'pointer write or flush') {
        realWriteFileSync(file, 'partial pointer');
        return fail();
      }
      return realWriteFileSync(file, data, options);
    });
    closeSyncMock.mockImplementation((file) => {
      realCloseSync(file);
      if (file === pointerDescriptor && failure === 'pointer close') fail();
    });
    const io = capture();

    try {
      await expect(guiInstallCommand(io)).rejects.toMatchObject({ code: 1 });

      expect(io.stderr).toHaveBeenCalledWith(expect.stringContaining('could not publish'));
      expect(selectedBinary()).toBe(previous.binary);
      expect(readFileSync(previous.binary, 'utf8')).toBe('existing shell');
      expect(readFileSync(join(shellCacheDir(), 'current'), 'utf8')).toBe(`${previous.name}\n`);
      const generations = readdirSync(shellCacheDir()).filter((name) =>
        name.startsWith('generation-v1-'),
      );
      expect(generations).toHaveLength(failure === 'generation rename' ? 0 : 1);
      expect(readdirSync(shellCacheDir()).sort()).toEqual(
        ['current', previous.name, ...generations].sort(),
      );
      for (const generation of generations) {
        expect(readFileSync(join(shellCacheDir(), generation, shellBinary), 'utf8')).toBe(
          'new shell',
        );
        expect(existsSync(join(shellCacheDir(), generation, '.rune-complete.json'))).toBe(true);
      }
      expect(existsSync(dirname(downloadedArchive()))).toBe(false);
    } finally {
      openSyncMock.mockImplementation(realOpenSync);
      renameSyncMock.mockImplementation(realRenameSync);
      writeFileSyncMock.mockImplementation(realWriteFileSync);
      closeSyncMock.mockImplementation(realCloseSync);
    }
  });

  it('keeps the current generation intact when failed publication cleanup also fails', async () => {
    const previous = cachedGeneration();
    const realRenameSync = renameSyncMock.getMockImplementation()!;
    const realRmSync = rmSyncMock.getMockImplementation()!;
    renameSyncMock.mockImplementation((from, to) => {
      if (isTemporaryPointer(from)) throw new Error('pointer publication denied');
      return realRenameSync(from, to);
    });
    rmSyncMock.mockImplementation((path, options) => {
      if (isTemporaryPointer(path)) throw new Error('pointer cleanup denied');
      return realRmSync(path, options);
    });
    const io = capture();

    try {
      await expect(guiInstallCommand(io)).rejects.toMatchObject({ code: 1 });

      expect(selectedBinary()).toBe(previous.binary);
      expect(readFileSync(previous.binary, 'utf8')).toBe('existing shell');
      expect(readFileSync(join(shellCacheDir(), 'current'), 'utf8')).toBe(`${previous.name}\n`);
      expect(io.stderr).toHaveBeenCalledWith(expect.stringContaining('could not publish'));
      expect(io.stderr).toHaveBeenCalledWith(
        expect.stringContaining('warning: could not remove temporary GUI shell files'),
      );
      expect(
        readdirSync(shellCacheDir()).filter((name) => name.startsWith('generation-v1-')),
      ).toHaveLength(1);
      expect(readdirSync(shellCacheDir()).filter(isTemporaryPointer)).toHaveLength(1);
    } finally {
      renameSyncMock.mockImplementation(realRenameSync);
      rmSyncMock.mockImplementation(realRmSync);
    }
  });

  it('does not remove a pointer temporary file it could not create exclusively', async () => {
    const previous = cachedGeneration();
    const realOpenSync = openSyncMock.getMockImplementation()!;
    let pointer: string | undefined;
    openSyncMock.mockImplementation((path, flags, mode) => {
      if (isTemporaryPointer(path)) {
        pointer = path;
        writeFileSync(path, 'another installer owns this file');
        throw Object.assign(new Error('already exists'), { code: 'EEXIST' });
      }
      return realOpenSync(path, flags, mode);
    });

    try {
      await expect(guiInstallCommand(capture())).rejects.toMatchObject({ code: 1 });

      expect(pointer).toBeDefined();
      expect(readFileSync(pointer!, 'utf8')).toBe('another installer owns this file');
      expect(selectedBinary()).toBe(previous.binary);
      expect(readFileSync(join(shellCacheDir(), 'current'), 'utf8')).toBe(`${previous.name}\n`);
      expect(
        readdirSync(shellCacheDir()).filter((name) => name.startsWith('generation-v1-')),
      ).toHaveLength(1);
    } finally {
      openSyncMock.mockImplementation(realOpenSync);
    }
  });

  it('keeps a successful installation when archive cleanup fails', async () => {
    const previous = cachedGeneration();
    rmSyncMock.mockImplementationOnce(() => {
      throw Object.assign(new Error('permission denied'), { code: 'EACCES' });
    });
    const io = capture();

    try {
      await guiInstallCommand(io);

      expect(readFileSync(selectedBinary(), 'utf8')).toBe('new shell');
      expect(readFileSync(previous.binary, 'utf8')).toBe('existing shell');
      expect(io.stderr).toHaveBeenCalledWith(
        expect.stringContaining('warning: could not remove temporary GUI shell files'),
      );
      expect(io.stderr).toHaveBeenCalledWith(expect.stringContaining('installed to'));
    } finally {
      rmSync(dirname(downloadedArchive()), { recursive: true, force: true });
    }
  });

  it.each([0, 1])(
    'selects the last complete concurrent installer (first completed: %i)',
    async (first) => {
      const previous = cachedGeneration();
      const extractions: { child: EventEmitter; directory: string }[] = [];
      spawnMock.mockImplementation((_command, args) => {
        const child = new EventEmitter();
        const directory = Array.isArray(args) ? args[3] : undefined;
        if (typeof directory !== 'string') throw new Error('missing extraction directory');
        extractions.push({ child, directory });
        return child as ReturnType<typeof spawn>;
      });
      const installs = [guiInstallCommand(capture()), guiInstallCommand(capture())];
      await vi.waitFor(() => expect(extractions).toHaveLength(2));
      expect(extractions[0]!.directory).not.toBe(extractions[1]!.directory);
      expect(selectedBinary()).toBe(previous.binary);
      for (const [index, extraction] of extractions.entries()) {
        writeFileSync(join(extraction.directory, shellBinary), `shell ${index}`);
      }

      extractions[first]!.child.emit('close', 0);
      await vi.waitFor(() => expect(readFileSync(selectedBinary(), 'utf8')).toBe(`shell ${first}`));
      const firstShell = selectedBinary();
      const last = 1 - first;
      extractions[last]!.child.emit('close', 0);
      await Promise.all(installs);

      const lastShell = selectedBinary();
      expect(readFileSync(lastShell, 'utf8')).toBe(`shell ${last}`);
      expect(readFileSync(firstShell, 'utf8')).toBe(`shell ${first}`);
      expect(readFileSync(previous.binary, 'utf8')).toBe('existing shell');
      expect(readdirSync(shellCacheDir()).sort()).toEqual(
        [
          'current',
          previous.name,
          basename(dirname(firstShell)),
          basename(dirname(lastShell)),
        ].sort(),
      );
    },
  );
});

describe('GUI shell cache selection', () => {
  it('reports an actionable usage error when every sealed generation is damaged', async () => {
    await guiInstallCommand(capture());
    const first = selectedBinary();
    await guiInstallCommand(capture());
    const second = selectedBinary();
    expect(second).not.toBe(first);
    writeFileSync(first, 'damaged first shell');
    writeFileSync(second, 'damaged second shell');

    let failure: unknown;
    try {
      locateShell({});
    } catch (error) {
      failure = error;
    }

    expect(failure).toBeInstanceOf(UsageError);
    expect(exitCodeFor(failure)).toBe(2);
    expect((failure as UsageError).message).toContain('run: rune gui install');
  });

  it.each(['', '\n'])('accepts the exact generation basename with terminator %j', (terminator) => {
    const previous = cachedGeneration();
    writeFileSync(join(shellCacheDir(), 'current'), previous.name + terminator);

    expect(selectedBinary()).toBe(previous.binary);
  });

  it('ignores interrupted stages, unpublished generations and temporary pointers', () => {
    const cache = shellCacheDir();
    const orphan = cachedGeneration('unpublished shell');
    rmSync(join(cache, 'current'));
    const stage = join(cache, '.rune-shell-stage-orphan');
    mkdirSync(stage);
    writeFileSync(join(stage, shellBinary), 'incomplete shell');
    writeFileSync(join(cache, `.current-${randomUUID()}.tmp`), `${orphan.name}\n`);

    expect(locateShell({})).toBeUndefined();

    const legacy = join(cache, shellBinary);
    writeFileSync(legacy, 'legacy shell');
    expect(selectedBinary()).toBe(legacy);
  });

  it.each([
    '',
    '../outside',
    '..\\outside',
    '/outside/shell',
    'C:\\outside\\shell',
    'generation-00000000-0000-0000-0000-000000000000/../outside',
    'generation-00000000-0000-0000-0000-000000000000\\outside',
    'generation-00000000-0000-0000-0000-000000000000\n\n',
    'generation-00000000-0000-0000-0000-000000000000\r\n',
    ' generation-00000000-0000-0000-0000-000000000000',
    '{"generation":"outside"}',
    'x'.repeat(256),
  ])('rejects malformed selection %j without falling back to the legacy shell', (selection) => {
    const cache = shellCacheDir();
    mkdirSync(cache, { recursive: true });
    writeFileSync(join(cache, shellBinary), 'legacy shell');
    writeFileSync(join(cache, 'current'), selection);

    let error: unknown;
    try {
      locateShell({});
    } catch (cause) {
      error = cause;
    }

    expect(error).toBeInstanceOf(UsageError);
    expect(exitCodeFor(error)).toBe(2);
    expect((error as UsageError).message).toContain('run: rune gui install');
  });

  it.each(['missing generation', 'missing binary', 'directory pointer', 'directory binary'])(
    'reports an actionable error for a %s',
    (failure) => {
      const previous = cachedGeneration();
      if (failure === 'missing generation') rmSync(dirname(previous.binary), { recursive: true });
      else if (failure === 'missing binary') rmSync(previous.binary);
      else if (failure === 'directory pointer') {
        rmSync(join(shellCacheDir(), 'current'));
        mkdirSync(join(shellCacheDir(), 'current'));
      } else {
        rmSync(previous.binary);
        mkdirSync(previous.binary);
      }

      expect(() => locateShell({})).toThrow(UsageError);
      expect(() => locateShell({})).toThrow('run: rune gui install');
    },
  );

  it('maps a current-pointer read failure to an actionable usage error', () => {
    cachedGeneration();
    readFileSyncMock.mockImplementationOnce(() => {
      throw Object.assign(new Error('permission denied'), { code: 'EACCES' });
    });

    expect(() => locateShell({})).toThrow(UsageError);
  });

  it('rejects a generation directory linked outside the version cache', () => {
    const previous = cachedGeneration();
    const outside = join(testDirectory, 'outside');
    mkdirSync(outside);
    writeFileSync(join(outside, shellBinary), 'outside shell');
    rmSync(dirname(previous.binary), { recursive: true });
    symlinkSync(
      outside,
      dirname(previous.binary),
      process.platform === 'win32' ? 'junction' : 'dir',
    );

    expect(() => locateShell({})).toThrow(UsageError);
  });

  it.runIf(process.platform !== 'win32')('rejects linked pointer and binary files', () => {
    const previous = cachedGeneration();
    const pointer = join(shellCacheDir(), 'current');
    const outsidePointer = join(testDirectory, 'outside-current');
    writeFileSync(outsidePointer, `${previous.name}\n`);
    rmSync(pointer);
    symlinkSync(outsidePointer, pointer);
    expect(() => locateShell({})).toThrow(UsageError);

    rmSync(pointer);
    writeFileSync(pointer, `${previous.name}\n`);
    const outsideBinary = join(testDirectory, 'outside-shell');
    writeFileSync(outsideBinary, 'outside shell');
    rmSync(previous.binary);
    symlinkSync(outsideBinary, previous.binary);
    expect(() => locateShell({})).toThrow(UsageError);
  });
});

describe('rune run --gui shell version handshake', () => {
  it('probes and launches the same generation when another installer publishes during the probe', async () => {
    const previous = cachedGeneration();
    const next = cachedGeneration('next shell');
    writeFileSync(join(shellCacheDir(), 'current'), `${previous.name}\n`);
    delete process.env['RUNE_GUI_SHELL'];
    spawnMock
      .mockImplementationOnce(() => {
        writeFileSync(join(shellCacheDir(), 'current'), `${next.name}\n`);
        return probeProcess(JSON.stringify({ protocolVersion: 1, runeVersion: RUNE_VERSION }));
      })
      .mockImplementationOnce(() => runProcess());

    await launchGui('installer.yaml', {}, capture(), interaction);

    expect(spawnMock.mock.calls[0]?.[0]).toBe(previous.binary);
    expect(spawnMock.mock.calls[1]?.[0]).toBe(previous.binary);
    expect(selectedBinary()).toBe(next.binary);
    expect(readFileSync(previous.binary, 'utf8')).toBe('existing shell');
  });

  it('refuses an unsupported host before resolving a development override or spawning', async () => {
    const { directory } = developmentShell();
    process.env['RUNE_GUI_SHELL'] = directory;
    const io = capture();
    stubHostPlatform('darwin');

    const error = await launchGui('installer.yaml', {}, io, interaction).catch(
      (cause: unknown) => cause,
    );

    expect(error).toBeInstanceOf(PlatformError);
    expect(exitCodeFor(error)).toBe(2);
    expect((error as PlatformError).message).toBe(
      'host platform "darwin" is not supported; supported Node platforms are win32 and linux',
    );
    expect(spawnMock).not.toHaveBeenCalled();
    expect(existsSync(shellCacheDir())).toBe(false);
    expect(io.stderr).not.toHaveBeenCalled();
  });

  it('launches a matching packaged shell with every run flag and safe spawn options', async () => {
    spawnMock
      .mockImplementationOnce(() =>
        probeProcess(JSON.stringify({ protocolVersion: 1, runeVersion: RUNE_VERSION }) + '\n'),
      )
      .mockImplementationOnce(() => runProcess());

    await launchGui(
      'installer.yaml',
      {
        set: ['name=value', 'environment=production'],
        values: ['defaults.yaml', 'production.yaml'],
        locale: 'de',
        result: 'result.json',
        logFile: 'run.log',
      },
      capture(),
      interaction,
    );

    expect(spawnMock).toHaveBeenCalledTimes(2);
    expect(spawnMock.mock.calls[0]?.[0]).toBe(join(testDirectory, shellBinary));
    expect(spawnMock.mock.calls[0]?.[1]).toEqual(['--rune-version-probe']);
    expect(spawnMock.mock.calls[0]?.[2]).toEqual({
      stdio: ['ignore', 'pipe', 'ignore'],
      shell: false,
      detached: process.platform !== 'win32',
    });
    expect(spawnMock.mock.calls[1]?.[0]).toBe(join(testDirectory, shellBinary));
    expect(spawnMock.mock.calls[1]?.[1]).toEqual([
      '--',
      'installer.yaml',
      '--set',
      'name=value',
      '--set',
      'environment=production',
      '--values',
      'defaults.yaml',
      '--values',
      'production.yaml',
      '--locale',
      'de',
      '--result',
      'result.json',
      '--log-file',
      'run.log',
    ]);
    expect(spawnMock.mock.calls[1]?.[2]).toEqual({
      stdio:
        process.platform === 'linux'
          ? ['ignore', 'ignore', 'inherit', 'pipe']
          : ['ignore', 'ignore', 'inherit'],
      ...(process.platform === 'linux'
        ? {
            env: {
              ...process.env,
              RUNE_GUI_STARTUP_TOKEN: expect.stringMatching(/^[a-f0-9]{32}$/u),
            },
          }
        : {}),
      shell: false,
      detached: process.platform !== 'win32',
    });
  });

  it('probes and launches a development-directory shell through its Electron', async () => {
    const { directory: shellDirectory, electron } = developmentShell();
    process.env['RUNE_GUI_SHELL'] = shellDirectory;
    spawnMock
      .mockImplementationOnce(() =>
        probeProcess(JSON.stringify({ protocolVersion: 1, runeVersion: RUNE_VERSION })),
      )
      .mockImplementationOnce(() => runProcess());

    await launchGui('installer.yaml', {}, capture(), interaction);

    expect(spawnMock.mock.calls[0]?.[0]).toBe(electron);
    expect(spawnMock.mock.calls[0]?.[1]).toEqual([shellDirectory, '--rune-version-probe']);
    expect(spawnMock.mock.calls[1]?.[0]).toBe(electron);
    expect(spawnMock.mock.calls[1]?.[1]).toEqual([shellDirectory, '--', 'installer.yaml']);
  });

  it.each(['path.txt', 'dist/electron'])(
    'rejects an unprepared development runtime missing %s without installing it',
    async (missing) => {
      const { directory: shellDirectory } = developmentShell();
      rmSync(join(shellDirectory, 'node_modules', 'electron', missing));
      process.env['RUNE_GUI_SHELL'] = shellDirectory;

      const error = await launchGui('installer.yaml', {}, capture(), interaction).catch(
        (cause: unknown) => cause,
      );

      expect(error).toBeInstanceOf(UsageError);
      expect((error as Error).message).toContain('prepare:electron');
      expect(spawnMock).not.toHaveBeenCalled();
    },
  );

  it('normalizes a relative development-directory shell before probing and launching', async () => {
    const { directory: shellDirectory, electron } = developmentShell();
    const relativeShellDirectory = relative(process.cwd(), shellDirectory);
    process.env['RUNE_GUI_SHELL'] = relativeShellDirectory;
    expect(locateShell()).toEqual({ kind: 'dev', dir: shellDirectory });
    spawnMock
      .mockImplementationOnce(() =>
        probeProcess(JSON.stringify({ protocolVersion: 1, runeVersion: RUNE_VERSION })),
      )
      .mockImplementationOnce(() => runProcess());

    await launchGui('installer.yaml', {}, capture(), interaction);

    expect(spawnMock.mock.calls[0]?.[0]).toBe(electron);
    expect(spawnMock.mock.calls[0]?.[1]).toEqual([shellDirectory, '--rune-version-probe']);
    expect(spawnMock.mock.calls[1]?.[0]).toBe(electron);
    expect(spawnMock.mock.calls[1]?.[1]).toEqual([shellDirectory, '--', 'installer.yaml']);
  });

  it('rejects a development-directory override without electron before spawning', async () => {
    const shellDirectory = join(testDirectory, 'missing-electron');
    mkdirSync(shellDirectory);
    process.env['RUNE_GUI_SHELL'] = shellDirectory;

    const error = await launchGui('installer.yaml', {}, capture(), interaction).catch(
      (cause: unknown) => cause,
    );

    expect(error).toBeInstanceOf(UsageError);
    expect(exitCodeFor(error as UsageError)).toBe(2);
    expect((error as UsageError).message).toContain('RUNE_GUI_SHELL directory');
    expect((error as UsageError).message).toContain(shellDirectory);
    expect((error as UsageError).message).toContain('electron');
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it('delimits a manifest name beginning with -- for the shell', async () => {
    spawnMock
      .mockImplementationOnce(() =>
        probeProcess(JSON.stringify({ protocolVersion: 1, runeVersion: RUNE_VERSION })),
      )
      .mockImplementationOnce(() => runProcess());

    await launchGui('--installer.yaml', { locale: 'de' }, capture(), interaction);

    expect(spawnMock.mock.calls[1]?.[1]).toEqual(['--', '--installer.yaml', '--locale', 'de']);
  });

  it('does not start the version probe when the host token is already cancelled', async () => {
    const cancel = new CancelToken();
    cancel.cancel();

    await expect(
      launchGui('installer.yaml', {}, capture(), interaction, { cancel }),
    ).rejects.toBeInstanceOf(CancelledError);

    expect(spawnMock).not.toHaveBeenCalled();
  });

  it('terminates an active version probe when the host token is cancelled', async () => {
    const probe = waitingProbe(3131);
    const cancel = new CancelToken();
    const processKill =
      process.platform === 'win32'
        ? undefined
        : vi.spyOn(process, 'kill').mockImplementation(() => true);
    spawnMock.mockImplementationOnce(() => probe.child);
    if (process.platform === 'win32') {
      spawnMock.mockImplementationOnce(() => runProcess());
    }

    const launch = launchGui('installer.yaml', {}, capture(), interaction, { cancel });
    let probeClosed = false;
    try {
      await vi.waitFor(() => expect(spawnMock).toHaveBeenCalledTimes(1));
      cancel.cancel();

      if (process.platform === 'win32') {
        expect(spawnMock.mock.calls[1]).toEqual([
          'taskkill',
          ['/PID', '3131', '/T', '/F'],
          { stdio: 'ignore', shell: false, timeout: 5000, killSignal: 'SIGKILL' },
        ]);
      } else {
        expect(processKill).toHaveBeenCalledWith(-3131, 'SIGTERM');
      }

      probe.close('', null);
      probeClosed = true;
      await expect(launch).rejects.toBeInstanceOf(CancelledError);
      expect(spawnMock.mock.calls.filter(([command]) => command !== 'taskkill')).toHaveLength(1);
    } finally {
      if (!probeClosed) {
        probe.close('', null);
      }
      await launch.catch(() => undefined);
      processKill?.mockRestore();
    }
  });

  it('forwards host SIGTERM cancellation and waits for the workflow result', async () => {
    const shell = waitingProcess(4242);
    const cancel = new CancelToken();
    const forceExit = vi.fn<(code: number) => void>();
    const signals = createSignalController(cancel, forceExit);
    const dispose = vi.fn();
    const subscribe = vi.spyOn(cancel, 'onCancel').mockImplementation((listener) => {
      const unsubscribe = CancelToken.prototype.onCancel.call(cancel, listener);
      return () => {
        dispose();
        unsubscribe();
      };
    });
    const sigintListeners = process.listenerCount('SIGINT');
    const sigtermListeners = process.listenerCount('SIGTERM');
    spawnMock
      .mockImplementationOnce(() =>
        probeProcess(JSON.stringify({ protocolVersion: 1, runeVersion: RUNE_VERSION })),
      )
      .mockImplementationOnce(() => shell as unknown as ReturnType<typeof spawn>);

    const launch = launchGui('installer.yaml', {}, capture(), interaction, { cancel });
    await vi.waitFor(() => expect(spawnMock).toHaveBeenCalledTimes(2));

    signals.handle('SIGTERM');
    if (process.platform === 'win32') {
      expect(spawnMock.mock.calls[2]).toEqual([
        'taskkill',
        ['/PID', '4242'],
        { stdio: 'ignore', shell: false },
      ]);
    } else {
      expect(shell.kill).toHaveBeenCalledTimes(1);
      expect(shell.kill).toHaveBeenCalledWith('SIGTERM');
    }
    signals.handle('SIGTERM');
    expect(forceExit).not.toHaveBeenCalled();
    if (process.platform === 'win32') {
      expect(spawnMock.mock.calls.filter(([command]) => command === 'taskkill')).toHaveLength(1);
    } else {
      expect(shell.kill).toHaveBeenCalledTimes(1);
    }
    let settled = false;
    const settlement = launch.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      },
    );
    await Promise.resolve();
    expect(settled).toBe(false);
    expect(process.listenerCount('SIGINT')).toBe(sigintListeners);
    expect(process.listenerCount('SIGTERM')).toBe(sigtermListeners);

    shell.emit('close', 6);
    await expect(launch).rejects.toMatchObject({ code: 6 });
    await settlement;
    expect(subscribe).toHaveBeenCalledTimes(1);
    expect(dispose).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['mismatched', JSON.stringify({ protocolVersion: 1, runeVersion: '0.0.0' }), 0],
    ['unsupported', '', 2],
    ['signal-terminated', '', null],
    ['malformed', '{not json', 0],
    ['missing', '', 0],
  ])('refuses a %s probe without launching the workflow', async (_case, output, code) => {
    spawnMock.mockImplementationOnce(() => probeProcess(output, code));

    const error = await launchGui('installer.yaml', {}, capture(), interaction).catch(
      (cause: unknown) => cause,
    );

    expect(error).toBeInstanceOf(UsageError);
    expect(exitCodeFor(error as UsageError)).toBe(2);
    expect((error as UsageError).message).toContain('rune gui install');
    expect(spawnMock).toHaveBeenCalledTimes(1);
  });

  it('forwards the shell cancellation exit code after a successful probe', async () => {
    spawnMock
      .mockImplementationOnce(() =>
        probeProcess(JSON.stringify({ protocolVersion: 1, runeVersion: RUNE_VERSION })),
      )
      .mockImplementationOnce(() => runProcess(6));

    await expect(launchGui('installer.yaml', {}, capture(), interaction)).rejects.toMatchObject({
      code: 6,
    });
  });

  it('maps an unknown shell exit code to the internal-error exit code', async () => {
    spawnMock
      .mockImplementationOnce(() =>
        probeProcess(JSON.stringify({ protocolVersion: 1, runeVersion: RUNE_VERSION })),
      )
      .mockImplementationOnce(() => runProcess(42));

    await expect(launchGui('installer.yaml', {}, capture(), interaction)).rejects.toMatchObject({
      code: 70,
    });
  });

  it('maps signal termination of the shell to the internal-error exit code', async () => {
    spawnMock
      .mockImplementationOnce(() =>
        probeProcess(JSON.stringify({ protocolVersion: 1, runeVersion: RUNE_VERSION })),
      )
      .mockImplementationOnce(() => runProcess(null));

    await expect(launchGui('installer.yaml', {}, capture(), interaction)).rejects.toMatchObject({
      code: 70,
    });
  });

  it('reports a shell spawn error and returns the internal-error exit code', async () => {
    const sigintListeners = process.listenerCount('SIGINT');
    const sigtermListeners = process.listenerCount('SIGTERM');
    spawnMock
      .mockImplementationOnce(() =>
        probeProcess(JSON.stringify({ protocolVersion: 1, runeVersion: RUNE_VERSION })),
      )
      .mockImplementationOnce(() => errorProcess('permission denied\nFORGED'));
    const io = capture();

    const failure = launchGui('installer.yaml', {}, io, interaction);
    if (process.platform === 'linux') await expect(failure).rejects.toBeInstanceOf(UsageError);
    else await expect(failure).rejects.toMatchObject({ code: 70 });

    expect(io.stderr).toHaveBeenCalledWith(
      'could not launch the GUI shell: permission denied\\nFORGED',
    );
    expect(process.listenerCount('SIGINT')).toBe(sigintListeners);
    expect(process.listenerCount('SIGTERM')).toBe(sigtermListeners);
  });

  it('terminates an active version probe on Ctrl+C and force-exits only on the second', async () => {
    const probe = waitingProbe(3131);
    const forceExit = vi.fn();
    const sigintListeners = process.listenerCount('SIGINT');
    const sigtermListeners = process.listenerCount('SIGTERM');
    const processKill =
      process.platform === 'win32'
        ? undefined
        : vi.spyOn(process, 'kill').mockImplementation(() => true);
    spawnMock.mockImplementationOnce(() => probe.child);
    if (process.platform === 'win32') {
      spawnMock.mockImplementationOnce(() => runProcess());
    }

    const launch = launchGui('installer.yaml', {}, capture(), {
      ...interaction,
      forceExit,
    });
    let probeClosed = false;
    try {
      await vi.waitFor(() => expect(spawnMock).toHaveBeenCalledTimes(1));

      process.emit('SIGINT');
      expect(forceExit).not.toHaveBeenCalled();

      if (process.platform === 'win32') {
        expect(spawnMock.mock.calls[1]).toEqual([
          'taskkill',
          ['/PID', '3131', '/T', '/F'],
          { stdio: 'ignore', shell: false, timeout: 5000, killSignal: 'SIGKILL' },
        ]);
      } else {
        expect(processKill).toHaveBeenCalledTimes(1);
        expect(processKill).toHaveBeenCalledWith(-3131, 'SIGTERM');
      }

      process.emit('SIGINT');
      expect(forceExit).toHaveBeenCalledTimes(1);
      expect(forceExit).toHaveBeenCalledWith(6);
      if (process.platform === 'win32') {
        expect(spawnMock).toHaveBeenCalledTimes(2);
      } else {
        expect(processKill).toHaveBeenCalledTimes(1);
      }

      probe.close('', null);
      probeClosed = true;
      await expect(launch).rejects.toBeInstanceOf(CancelledError);
      expect(spawnMock.mock.calls.filter(([command]) => command !== 'taskkill')).toHaveLength(1);
      expect(probe.events.listenerCount('error')).toBe(0);
      expect(probe.events.listenerCount('close')).toBe(0);
      expect(probe.events.stdout.listenerCount('data')).toBe(0);
      expect(process.listenerCount('SIGINT')).toBe(sigintListeners);
      expect(process.listenerCount('SIGTERM')).toBe(sigtermListeners);
    } finally {
      if (!probeClosed) {
        probe.close('', null);
      }
      await launch.catch(() => undefined);
      processKill?.mockRestore();
    }
  });

  it('terminates an active version probe once for repeated SIGTERM', async () => {
    const probe = waitingProbe(3131);
    const forceExit = vi.fn();
    const sigintListeners = process.listenerCount('SIGINT');
    const sigtermListeners = process.listenerCount('SIGTERM');
    const processKill =
      process.platform === 'win32'
        ? undefined
        : vi.spyOn(process, 'kill').mockImplementation(() => true);
    spawnMock.mockImplementationOnce(() => probe.child);
    if (process.platform === 'win32') {
      spawnMock.mockImplementationOnce(() => runProcess());
    }

    const launch = launchGui('installer.yaml', {}, capture(), {
      ...interaction,
      forceExit,
    });
    let probeClosed = false;
    try {
      await vi.waitFor(() => expect(spawnMock).toHaveBeenCalledTimes(1));

      process.emit('SIGTERM');
      process.emit('SIGTERM');
      process.emit('SIGTERM');
      if (process.platform === 'win32') {
        expect(spawnMock.mock.calls[1]).toEqual([
          'taskkill',
          ['/PID', '3131', '/T', '/F'],
          { stdio: 'ignore', shell: false, timeout: 5000, killSignal: 'SIGKILL' },
        ]);
        expect(spawnMock).toHaveBeenCalledTimes(2);
      } else {
        expect(processKill).toHaveBeenCalledTimes(1);
        expect(processKill).toHaveBeenCalledWith(-3131, 'SIGTERM');
        expect(spawnMock).toHaveBeenCalledTimes(1);
      }
      expect(forceExit).not.toHaveBeenCalled();

      probe.close('', null);
      probeClosed = true;
      await expect(launch).rejects.toBeInstanceOf(CancelledError);
      expect(spawnMock.mock.calls.filter(([command]) => command !== 'taskkill')).toHaveLength(1);
      expect(probe.events.listenerCount('error')).toBe(0);
      expect(probe.events.listenerCount('close')).toBe(0);
      expect(probe.events.stdout.listenerCount('data')).toBe(0);
      expect(process.listenerCount('SIGINT')).toBe(sigintListeners);
      expect(process.listenerCount('SIGTERM')).toBe(sigtermListeners);
    } finally {
      if (!probeClosed) {
        probe.close('', null);
      }
      await launch.catch(() => undefined);
      processKill?.mockRestore();
    }
  });

  it.runIf(process.platform === 'win32')(
    'contains a taskkill spawn error while cancelling the version probe',
    async () => {
      const probe = waitingProbe(3131);
      const taskkill = new EventEmitter();
      spawnMock
        .mockImplementationOnce(() => probe.child)
        .mockImplementationOnce(() => taskkill as ReturnType<typeof spawn>);

      const launch = launchGui('installer.yaml', {}, capture(), interaction);
      await vi.waitFor(() => expect(spawnMock).toHaveBeenCalledTimes(1));

      process.emit('SIGTERM');

      expect(() => taskkill.emit('error', new Error('taskkill unavailable'))).not.toThrow();
      probe.close('', null);
      await expect(launch).rejects.toBeInstanceOf(CancelledError);
    },
  );

  it.each(['linux', 'win32'] as const)(
    'bounds a stuck version probe and its close wait on %s',
    async (platform) => {
      stubHostPlatform(platform);
      vi.useFakeTimers();
      const probe = waitingProbe(3131);
      probe.child.unref = vi.fn();
      const processKill = vi.spyOn(process, 'kill').mockImplementation(() => true);
      spawnMock.mockImplementationOnce(() => probe.child).mockImplementation(() => runProcess());
      const launch = launchGui('installer.yaml', {}, capture(), interaction).catch(
        (error: unknown) => error,
      );
      try {
        await vi.advanceTimersByTimeAsync(9999);
        expect(spawnMock).toHaveBeenCalledTimes(1);
        expect(processKill).not.toHaveBeenCalled();
        await vi.advanceTimersByTimeAsync(1);
        if (platform === 'linux') {
          expect(processKill).toHaveBeenCalledWith(-3131, 'SIGKILL');
        } else {
          expect(spawnMock.mock.calls[1]).toEqual([
            'taskkill',
            ['/PID', '3131', '/T', '/F'],
            { stdio: 'ignore', shell: false, timeout: 5000, killSignal: 'SIGKILL' },
          ]);
        }
        await vi.advanceTimersByTimeAsync(5000);
        const error = await launch;
        expect(error).toBeInstanceOf(UsageError);
        expect(exitCodeFor(error)).toBe(2);
        expect((error as Error).message).toContain('within 10 seconds');
        expect(probe.events.stdout.destroyed).toBe(true);
        expect(probe.child.unref).toHaveBeenCalledOnce();
        expect(vi.getTimerCount()).toBe(0);
        expect(spawnMock.mock.calls.filter(([command]) => command !== 'taskkill')).toHaveLength(1);
        // A late native error after the close deadline must not crash the host.
        expect(() => probe.events.emit('error', new Error('late error'))).not.toThrow();
      } finally {
        probe.close('', null);
        processKill.mockRestore();
        vi.useRealTimers();
      }
    },
  );

  it.each(['before', 'after'] as const)(
    'keeps the first terminal cause when cancellation arrives %s the probe deadline',
    async (order) => {
      stubHostPlatform('linux');
      vi.useFakeTimers();
      const probe = waitingProbe(3131);
      const cancel = new CancelToken();
      const processKill = vi.spyOn(process, 'kill').mockImplementation(() => true);
      spawnMock.mockImplementationOnce(() => probe.child);
      const launch = launchGui('installer.yaml', {}, capture(), interaction, { cancel }).catch(
        (error: unknown) => error,
      );
      try {
        if (order === 'before') cancel.cancel();
        await vi.advanceTimersByTimeAsync(10000);
        if (order === 'after') cancel.cancel();
        probe.close('', null);
        expect(exitCodeFor(await launch)).toBe(order === 'before' ? 6 : 2);
        expect(vi.getTimerCount()).toBe(0);
        expect(spawnMock).toHaveBeenCalledTimes(1);
      } finally {
        probe.close('', null);
        processKill.mockRestore();
        vi.useRealTimers();
      }
    },
  );

  it('does not launch the workflow when cancellation wins after the probe closes', async () => {
    const probe = waitingProbe();
    const forceExit = vi.fn();
    const sigintListeners = process.listenerCount('SIGINT');
    const sigtermListeners = process.listenerCount('SIGTERM');
    spawnMock.mockImplementationOnce(() => probe.child);

    const launch = launchGui('installer.yaml', {}, capture(), {
      ...interaction,
      forceExit,
    });
    await vi.waitFor(() => expect(spawnMock).toHaveBeenCalledTimes(1));

    probe.close(JSON.stringify({ protocolVersion: 1, runeVersion: RUNE_VERSION }));
    process.emit('SIGTERM');

    await expect(launch).rejects.toBeInstanceOf(CancelledError);
    expect(spawnMock).toHaveBeenCalledTimes(1);
    expect(forceExit).not.toHaveBeenCalled();
    expect(probe.events.listenerCount('error')).toBe(0);
    expect(probe.events.listenerCount('close')).toBe(0);
    expect(probe.events.stdout.listenerCount('data')).toBe(0);
    expect(process.listenerCount('SIGINT')).toBe(sigintListeners);
    expect(process.listenerCount('SIGTERM')).toBe(sigtermListeners);
  });

  it('removes its signal listeners when the version probe errors', async () => {
    const sigintListeners = process.listenerCount('SIGINT');
    const sigtermListeners = process.listenerCount('SIGTERM');
    spawnMock.mockImplementationOnce(() => probeErrorProcess('permission denied'));

    await expect(launchGui('installer.yaml', {}, capture(), interaction)).rejects.toBeInstanceOf(
      UsageError,
    );

    expect(process.listenerCount('SIGINT')).toBe(sigintListeners);
    expect(process.listenerCount('SIGTERM')).toBe(sigtermListeners);
  });

  it('forwards the first Ctrl+C, force-exits on the second, and removes its listeners', async () => {
    const shell = waitingProcess(4242);
    const forceExit = vi.fn();
    const sigintListeners = process.listenerCount('SIGINT');
    const sigtermListeners = process.listenerCount('SIGTERM');
    spawnMock
      .mockImplementationOnce(() =>
        probeProcess(JSON.stringify({ protocolVersion: 1, runeVersion: RUNE_VERSION })),
      )
      .mockImplementationOnce(() => shell as unknown as ReturnType<typeof spawn>);

    const launch = launchGui('installer.yaml', {}, capture(), {
      ...interaction,
      forceExit,
    });
    let shellClosed = false;
    try {
      await vi.waitFor(() => expect(spawnMock).toHaveBeenCalledTimes(2));

      process.emit('SIGINT');
      process.emit('SIGINT');

      if (process.platform === 'win32') {
        expect(shell.kill).not.toHaveBeenCalled();
        expect(spawnMock.mock.calls[2]).toEqual([
          'taskkill',
          ['/PID', '4242'],
          { stdio: 'ignore', shell: false },
        ]);
      } else {
        expect(shell.kill).toHaveBeenCalledTimes(1);
        expect(shell.kill).toHaveBeenCalledWith('SIGTERM');
      }
      expect(forceExit).toHaveBeenCalledTimes(1);
      expect(forceExit).toHaveBeenCalledWith(6);

      shell.emit('close', 6);
      shellClosed = true;
      await expect(launch).rejects.toMatchObject({ code: 6 });
      expect(process.listenerCount('SIGINT')).toBe(sigintListeners);
      expect(process.listenerCount('SIGTERM')).toBe(sigtermListeners);
    } finally {
      if (!shellClosed) {
        shell.emit('close', 6);
      }
      await launch.catch(() => undefined);
    }
  });

  it('forwards SIGTERM once without force-exiting when it is repeated', async () => {
    const shell = waitingProcess(4242);
    const forceExit = vi.fn();
    const sigintListeners = process.listenerCount('SIGINT');
    const sigtermListeners = process.listenerCount('SIGTERM');
    spawnMock
      .mockImplementationOnce(() =>
        probeProcess(JSON.stringify({ protocolVersion: 1, runeVersion: RUNE_VERSION })),
      )
      .mockImplementationOnce(() => shell as unknown as ReturnType<typeof spawn>);

    const launch = launchGui('installer.yaml', {}, capture(), {
      ...interaction,
      forceExit,
    });
    let shellClosed = false;
    try {
      await vi.waitFor(() => expect(spawnMock).toHaveBeenCalledTimes(2));

      process.emit('SIGTERM');
      process.emit('SIGTERM');

      if (process.platform === 'win32') {
        expect(shell.kill).not.toHaveBeenCalled();
        expect(spawnMock.mock.calls[2]).toEqual([
          'taskkill',
          ['/PID', '4242'],
          { stdio: 'ignore', shell: false },
        ]);
        expect(spawnMock).toHaveBeenCalledTimes(3);
      } else {
        expect(shell.kill).toHaveBeenCalledTimes(1);
        expect(shell.kill).toHaveBeenCalledWith('SIGTERM');
        expect(spawnMock).toHaveBeenCalledTimes(2);
      }
      expect(forceExit).not.toHaveBeenCalled();

      shell.emit('close', 6);
      shellClosed = true;
      await expect(launch).rejects.toMatchObject({ code: 6 });
      expect(process.listenerCount('SIGINT')).toBe(sigintListeners);
      expect(process.listenerCount('SIGTERM')).toBe(sigtermListeners);
    } finally {
      if (!shellClosed) {
        shell.emit('close', 6);
      }
      await launch.catch(() => undefined);
    }
  });

  it.runIf(process.platform === 'win32')(
    'contains a taskkill spawn error while cancelling the running shell',
    async () => {
      const shell = waitingProcess(4242);
      const taskkill = new EventEmitter();
      spawnMock
        .mockImplementationOnce(() =>
          probeProcess(JSON.stringify({ protocolVersion: 1, runeVersion: RUNE_VERSION })),
        )
        .mockImplementationOnce(() => shell as unknown as ReturnType<typeof spawn>)
        .mockImplementationOnce(() => taskkill as ReturnType<typeof spawn>);

      const launch = launchGui('installer.yaml', {}, capture(), interaction);
      await vi.waitFor(() => expect(spawnMock).toHaveBeenCalledTimes(2));

      process.emit('SIGTERM');

      expect(() => taskkill.emit('error', new Error('taskkill unavailable'))).not.toThrow();
      shell.emit('close', 6);
      await expect(launch).rejects.toMatchObject({ code: 6 });
    },
  );
});
