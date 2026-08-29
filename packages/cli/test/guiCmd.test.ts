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

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { guiInstallCommand, locateShell, shellCacheDir } from '../src/guiCmd.js';

import type { CliIo } from '../src/io.js';

vi.mock('node:child_process', () => ({ spawn: vi.fn() }));

const savedLocalAppData = process.env['LOCALAPPDATA'];
const savedXdgCacheHome = process.env['XDG_CACHE_HOME'];
const spawnMock = vi.mocked(spawn);

let testDirectory: string;
let tarExit: number;
let tarCreatesShell: boolean;

const shellBinary = process.platform === 'win32' ? 'rune-gui-shell.exe' : 'rune-gui-shell';

beforeEach(() => {
  testDirectory = mkdtempSync(join(tmpdir(), 'rune-gui-install-test-'));
  process.env['LOCALAPPDATA'] = testDirectory;
  process.env['XDG_CACHE_HOME'] = testDirectory;
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
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

function capture(): CliIo {
  return { stdout: vi.fn(), stderr: vi.fn() };
}

function downloadedArchive(): string {
  const args = spawnMock.mock.calls[0]?.[1];
  if (!Array.isArray(args) || typeof args[1] !== 'string') {
    throw new Error('tar was not called with an archive path');
  }
  return args[1];
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
