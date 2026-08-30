import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { PassThrough } from 'node:stream';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { RUNE_VERSION, UsageError, exitCodeFor } from '@rune/engine';

import { guiInstallCommand, launchGui, locateShell, shellCacheDir } from '../src/guiCmd.js';

import type { CliIo } from '../src/io.js';
import type { Interaction } from '../src/prompt.js';

vi.mock('node:child_process', () => ({ spawn: vi.fn() }));

const savedLocalAppData = process.env['LOCALAPPDATA'];
const savedXdgCacheHome = process.env['XDG_CACHE_HOME'];
const savedGuiShell = process.env['RUNE_GUI_SHELL'];
const spawnMock = vi.mocked(spawn);

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
});

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

function runProcess(code = 0): ReturnType<typeof spawn> {
  const child = new EventEmitter();
  queueMicrotask(() => child.emit('close', code));
  return child as ReturnType<typeof spawn>;
}

function downloadedArchive(): string {
  const args = spawnMock.mock.calls[0]?.[1];
  if (!Array.isArray(args) || typeof args[1] !== 'string') {
    throw new Error('tar was not called with an archive path');
  }
  return args[1];
}

function shellTemporaryDirectories(): readonly string[] {
  return readdirSync(tmpdir()).filter((entry) => entry.startsWith('rune-shell-'));
}

describe('rune gui install temporary archive', () => {
  it('uses a private random directory and removes it after success', async () => {
    await guiInstallCommand(capture());

    const archive = downloadedArchive();
    const archiveName =
      process.platform === 'win32' ? 'rune-gui-shell-windows.zip' : 'rune-gui-shell-linux.tar.gz';
    expect(archive).not.toBe(join(tmpdir(), `rune-shell-${process.pid}-${archiveName}`));
    expect(dirname(archive)).not.toBe(tmpdir());
    expect(basename(dirname(archive))).toMatch(/^rune-shell-/u);
    expect(basename(archive)).toBe(archiveName);
    expect(existsSync(dirname(archive))).toBe(false);
  });

  it('removes the private temporary directory when tar fails', async () => {
    tarExit = 2;

    await expect(guiInstallCommand(capture())).rejects.toMatchObject({ code: 1 });

    expect(existsSync(dirname(downloadedArchive()))).toBe(false);
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
});

describe('rune gui install atomic cache promotion', () => {
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
});

describe('rune run --gui shell version handshake', () => {
  it('launches the workflow only after the packaged shell reports the matching version', async () => {
    spawnMock
      .mockImplementationOnce(() =>
        probeProcess(JSON.stringify({ protocolVersion: 1, runeVersion: RUNE_VERSION }) + '\n'),
      )
      .mockImplementationOnce(() => runProcess());

    await launchGui(
      'installer.yaml',
      { set: ['name=value'], locale: 'de' },
      capture(),
      interaction,
    );

    expect(spawnMock).toHaveBeenCalledTimes(2);
    expect(spawnMock.mock.calls[0]?.[1]).toEqual(['--rune-version-probe']);
    expect(spawnMock.mock.calls[1]?.[1]).toEqual([
      'installer.yaml',
      '--set',
      'name=value',
      '--locale',
      'de',
    ]);
  });

  it('probes and launches a development-directory shell through its Electron', async () => {
    const shellDirectory = join(process.cwd(), 'packages', 'gui-shell');
    process.env['RUNE_GUI_SHELL'] = shellDirectory;
    spawnMock
      .mockImplementationOnce(() =>
        probeProcess(JSON.stringify({ protocolVersion: 1, runeVersion: RUNE_VERSION })),
      )
      .mockImplementationOnce(() => runProcess());

    await launchGui('installer.yaml', {}, capture(), interaction);

    expect(spawnMock.mock.calls[0]?.[1]).toEqual([shellDirectory, '--rune-version-probe']);
    expect(spawnMock.mock.calls[1]?.[1]).toEqual([shellDirectory, 'installer.yaml']);
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
});
