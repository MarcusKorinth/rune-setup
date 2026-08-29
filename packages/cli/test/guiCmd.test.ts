import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { guiInstallCommand } from '../src/guiCmd.js';

import type { CliIo } from '../src/io.js';

vi.mock('node:child_process', () => ({ spawn: vi.fn() }));

const savedLocalAppData = process.env['LOCALAPPDATA'];
const savedXdgCacheHome = process.env['XDG_CACHE_HOME'];
const spawnMock = vi.mocked(spawn);

let testDirectory: string;
let tarExit: number;

beforeEach(() => {
  testDirectory = mkdtempSync(join(tmpdir(), 'rune-gui-install-test-'));
  process.env['LOCALAPPDATA'] = testDirectory;
  process.env['XDG_CACHE_HOME'] = testDirectory;
  tarExit = 0;
  spawnMock.mockImplementation(() => {
    const child = new EventEmitter();
    queueMicrotask(() => child.emit('close', tarExit));
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
