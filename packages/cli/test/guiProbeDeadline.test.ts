import { spawnSync } from 'node:child_process';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';

import { expect, it, vi } from 'vitest';

import { UsageError } from '@rune/engine';

import { launchGui } from '../src/guiCmd.js';

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    if (process.platform === 'linux') {
      const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
      return stat.slice(stat.lastIndexOf(')') + 2, stat.lastIndexOf(')') + 3) !== 'Z';
    }
    return true;
  } catch {
    return false;
  }
}

it('terminates a real hung version probe and its descendant before rejecting startup', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'rune-stuck-probe-'));
  const pidFile = join(directory, 'pids.json');
  const electronPackage = join(directory, 'node_modules', 'electron');
  mkdirSync(join(electronPackage, 'dist'), { recursive: true });
  const binaryName = process.platform === 'win32' ? 'electron.exe' : 'electron';
  copyFileSync(process.execPath, join(electronPackage, 'dist', binaryName));
  writeFileSync(join(electronPackage, 'path.txt'), binaryName);
  writeFileSync(
    join(electronPackage, 'index.js'),
    `module.exports = ${JSON.stringify(process.execPath)};`,
  );
  writeFileSync(join(directory, 'package.json'), JSON.stringify({ main: 'index.cjs' }));
  writeFileSync(
    join(directory, 'index.cjs'),
    [
      'const { spawn } = require("node:child_process");',
      'const descendant = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });',
      'process.on("SIGTERM", () => {});',
      `require("node:fs").writeFileSync(${JSON.stringify(pidFile)}, JSON.stringify([process.pid, descendant.pid]));`,
      'setInterval(() => {}, 1000);',
    ].join('\n'),
  );
  vi.stubEnv('RUNE_GUI_SHELL', directory);
  const pids: number[] = [];
  const pending = launchGui(
    'unused.yaml',
    {},
    { stdout: vi.fn(), stderr: vi.fn() },
    {
      input: new PassThrough(),
      isTTY: false,
      write: () => undefined,
    },
  ).catch((error: unknown) => error);
  try {
    await vi.waitFor(() => expect(existsSync(pidFile)).toBe(true), { timeout: 5000 });
    pids.push(...(JSON.parse(readFileSync(pidFile, 'utf8')) as number[]));
    expect(pids).toHaveLength(2);
    expect(pids.every(alive)).toBe(true);
    const error = await pending;
    expect(error).toBeInstanceOf(UsageError);
    expect((error as Error).message).toContain('within 10 seconds');
    await vi.waitFor(() => expect(pids.some(alive)).toBe(false), { timeout: 5000 });
  } finally {
    for (const pid of pids) {
      if (!alive(pid)) continue;
      if (process.platform === 'win32') {
        spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { shell: false, timeout: 5000 });
      } else {
        try {
          process.kill(pid, 'SIGKILL');
        } catch {
          /* Already reaped. */
        }
      }
    }
    await pending;
    vi.unstubAllEnvs();
    rmSync(directory, { recursive: true, force: true });
  }
}, 25000);
