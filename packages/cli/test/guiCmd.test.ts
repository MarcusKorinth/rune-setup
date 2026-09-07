import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import {
  createWriteStream,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, relative } from 'node:path';
import { PassThrough } from 'node:stream';
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
    createWriteStream: vi.fn(fs.createWriteStream),
    mkdirSync: vi.fn(fs.mkdirSync),
    mkdtempSync: vi.fn(fs.mkdtempSync),
    renameSync: vi.fn(fs.renameSync),
    rmSync: vi.fn(fs.rmSync),
    statSync: vi.fn(fs.statSync),
  };
});

const savedLocalAppData = process.env['LOCALAPPDATA'];
const savedXdgCacheHome = process.env['XDG_CACHE_HOME'];
const savedGuiShell = process.env['RUNE_GUI_SHELL'];
const spawnMock = vi.mocked(spawn);
const createWriteStreamMock = vi.mocked(createWriteStream);
const mkdirSyncMock = vi.mocked(mkdirSync);
const mkdtempSyncMock = vi.mocked(mkdtempSync);
const renameSyncMock = vi.mocked(renameSync);
const rmSyncMock = vi.mocked(rmSync);
const statSyncMock = vi.mocked(statSync);
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
      child.stdout.end(output);
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
  queueMicrotask(() => child.emit('close', code));
  return child as ReturnType<typeof spawn>;
}

function errorProcess(message: string): ReturnType<typeof spawn> {
  const child = new EventEmitter();
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
  return child;
}

function developmentShell(): { readonly directory: string; readonly electron: string } {
  const directory = join(testDirectory, 'development-shell');
  const electronPackage = join(directory, 'node_modules', 'electron');
  const electron = join(testDirectory, 'fake-electron');
  mkdirSync(electronPackage, { recursive: true });
  writeFileSync(join(directory, 'package.json'), JSON.stringify({ private: true }), 'utf8');
  writeFileSync(
    join(electronPackage, 'package.json'),
    JSON.stringify({ name: 'electron', version: '0.0.0', main: 'index.cjs' }),
    'utf8',
  );
  writeFileSync(
    join(electronPackage, 'index.cjs'),
    `module.exports = ${JSON.stringify(electron)};\n`,
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
  it('reports cache-directory setup failures as installation failures', async () => {
    mkdirSyncMock.mockImplementationOnce(() => {
      throw Object.assign(new Error('permission denied'), { code: 'EACCES' });
    });
    const io = capture();

    await expect(guiInstallCommand(io)).rejects.toMatchObject({ code: 1 });

    expect(io.stderr).toHaveBeenCalledWith(expect.stringContaining('could not prepare'));
    expect(spawnMock).not.toHaveBeenCalled();
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

  it('promotes a complete staged shell over an existing cache and removes remnants', async () => {
    const installedShell = join(shellCacheDir(), shellBinary);
    mkdirSync(dirname(installedShell), { recursive: true });
    writeFileSync(installedShell, 'existing shell');

    await guiInstallCommand(capture());

    expect(locateShell({})).toEqual({ kind: 'binary', path: installedShell });
    expect(readFileSync(installedShell, 'utf8')).toBe('new shell');
    expect(readdirSync(dirname(shellCacheDir()))).toEqual([basename(shellCacheDir())]);
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
    statSyncMock.mockImplementationOnce(() => {
      throw Object.assign(new Error('permission denied'), { code: 'EACCES' });
    });
    const io = capture();

    await expect(guiInstallCommand(io)).rejects.toMatchObject({ code: 1 });

    expect(io.stderr).toHaveBeenCalledWith(expect.stringContaining('could not inspect'));
    expect(readFileSync(existingShell, 'utf8')).toBe('existing shell');
  });

  it('restores the existing cache when promotion fails', async () => {
    const existingShell = join(shellCacheDir(), shellBinary);
    mkdirSync(dirname(existingShell), { recursive: true });
    writeFileSync(existingShell, 'existing shell');
    const realRenameSync = renameSyncMock.getMockImplementation()!;
    renameSyncMock
      .mockImplementationOnce((oldPath, newPath) => realRenameSync(oldPath, newPath))
      .mockImplementationOnce(() => {
        throw Object.assign(new Error('permission denied'), { code: 'EACCES' });
      });
    const io = capture();

    await expect(guiInstallCommand(io)).rejects.toMatchObject({ code: 1 });

    expect(io.stderr).toHaveBeenCalledWith(expect.stringContaining('could not install'));
    expect(readFileSync(existingShell, 'utf8')).toBe('existing shell');
  });

  it('retains a recoverable backup when cache restoration fails', async () => {
    const existingShell = join(shellCacheDir(), shellBinary);
    mkdirSync(dirname(existingShell), { recursive: true });
    writeFileSync(existingShell, 'existing shell');
    const realRenameSync = renameSyncMock.getMockImplementation()!;
    renameSyncMock
      .mockImplementationOnce((oldPath, newPath) => realRenameSync(oldPath, newPath))
      .mockImplementationOnce(() => {
        throw Object.assign(new Error('promotion denied'), { code: 'EACCES' });
      })
      .mockImplementationOnce(() => {
        throw Object.assign(new Error('restoration denied'), { code: 'EACCES' });
      });
    const io = capture();

    await expect(guiInstallCommand(io)).rejects.toMatchObject({ code: 1 });

    const backup = renameSyncMock.mock.calls[0]?.[1];
    expect(typeof backup).toBe('string');
    expect(io.stderr).toHaveBeenCalledWith(expect.stringContaining(String(backup)));
    expect(readFileSync(join(String(backup), shellBinary), 'utf8')).toBe('existing shell');
    expect(existsSync(existingShell)).toBe(false);
  });

  it('keeps a successful installation when old-cache cleanup fails', async () => {
    const installedShell = join(shellCacheDir(), shellBinary);
    mkdirSync(dirname(installedShell), { recursive: true });
    writeFileSync(installedShell, 'existing shell');
    rmSyncMock.mockImplementationOnce(() => {
      throw Object.assign(new Error('permission denied'), { code: 'EACCES' });
    });
    const io = capture();

    await guiInstallCommand(io);

    expect(readFileSync(installedShell, 'utf8')).toBe('new shell');
    expect(io.stderr).toHaveBeenCalledWith(
      expect.stringContaining('warning: could not remove temporary GUI shell files'),
    );
    expect(io.stderr).toHaveBeenCalledWith(expect.stringContaining('installed to'));
  });
});

describe('rune run --gui shell version handshake', () => {
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
      stdio: ['ignore', 'ignore', 'inherit'],
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
          { stdio: 'ignore', shell: false },
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
      .mockImplementationOnce(() => errorProcess('permission denied'));
    const io = capture();

    await expect(launchGui('installer.yaml', {}, io, interaction)).rejects.toMatchObject({
      code: 70,
    });

    expect(io.stderr).toHaveBeenCalledWith('could not launch the GUI shell: permission denied');
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
          { stdio: 'ignore', shell: false },
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
          { stdio: 'ignore', shell: false },
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
