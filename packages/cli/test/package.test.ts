import { spawnSync, type spawn } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  rmdirSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { RUNE_VERSION } from '@rune/engine';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { run } from '../src/cli.js';
import type * as GuiCommands from '../src/guiCmd.js';
import { copyFiles, inside, resourcePath, shellFiles, workflowFiles } from '../src/packageFiles.js';

const control = vi.hoisted(() => ({
  probe: {} as unknown,
  rawProbe: undefined as string | undefined,
  probeFailure: false,
  archiveFailure: false,
  location: undefined as
    { kind: 'binary'; path: string } | { kind: 'dev'; dir: string } | undefined,
}));

vi.mock('node:child_process', async (original) => {
  const actual = await original<{ spawn: typeof spawn; spawnSync: typeof spawnSync }>();
  return {
    ...actual,
    spawnSync: vi.fn((command: string, args: readonly string[], options: object) => {
      if (args[0] === '--rune-version-probe') {
        return {
          status: control.probeFailure ? 70 : 0,
          stdout: control.rawProbe ?? JSON.stringify(control.probe),
        };
      }
      if (control.archiveFailure && (args[0] === '-acf' || args[0] === '-czf')) {
        return { status: 1 };
      }
      return actual.spawnSync(command, args, options);
    }),
  };
});

vi.mock('../src/guiCmd.js', async (original) => ({
  ...(await original<typeof GuiCommands>()),
  locateShell: () => control.location,
}));

let root: string;
let source: string;
let shell: string;
let manifest: string;
let output: string;
let messages: string[];
const extension = process.platform === 'win32' ? '.zip' : '.tar.gz';

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'rune package test '));
  source = join(root, 'source workflow');
  shell = join(root, 'shell');
  mkdirSync(source);
  mkdirSync(join(shell, 'resources'), { recursive: true });
  writeFileSync(join(shell, 'resources', 'app.asar'), 'runtime');
  writeFileSync(join(shell, '.rune-complete.json'), 'cache-only');
  manifest = join(source, 'custom.yaml');
  writeFileSync(manifest, 'schemaVersion: 1\nproduct: {name: Example, version: "1"}\nsteps: []\n');
  output = join(root, 'result' + extension);
  messages = [];
  control.probe = { protocolVersion: 1, runeVersion: RUNE_VERSION, workflowPackageVersion: 1 };
  control.rawProbe = undefined;
  control.probeFailure = false;
  control.archiveFailure = false;
  control.location = undefined;
});

afterEach(() => {
  vi.restoreAllMocks();
  if (!inside(tmpdir(), root)) throw new Error('invalid test directory');
  rmSync(root, { recursive: true, force: true });
});

async function packageRun(extra: readonly string[] = [], useShell = true): Promise<number> {
  return run(
    ['package', manifest, '--output', output, ...(useShell ? ['--shell', shell] : []), ...extra],
    { stdout: (line) => messages.push('stdout:' + line), stderr: (line) => messages.push(line) },
  );
}

describe('portable workflow packaging', () => {
  it('archives only declared resources and binds the original manifest without changing sources', async () => {
    mkdirSync(join(source, 'assets'));
    mkdirSync(join(source, 'payload'));
    writeFileSync(join(source, 'assets', 'logo.svg'), '<svg xmlns="http://www.w3.org/2000/svg"/>');
    writeFileSync(join(source, 'extra.txt'), 'explicit');
    writeFileSync(join(source, 'private.txt'), 'excluded');
    writeFileSync(manifest, readFileSync(manifest, 'utf8') + 'gui: {logo: ./assets/logo.svg}\n');
    const before = readFileSync(manifest);
    expect(await packageRun(['--include', './extra.txt'])).toBe(0);
    const unpacked = join(root, 'unpacked');
    mkdirSync(unpacked);
    expect(spawnSync('tar', ['-xf', output, '-C', unpacked], { shell: false }).status).toBe(0);
    expect(readFileSync(join(unpacked, 'resources/workflow/custom.yaml'))).toEqual(before);
    expect(readFileSync(manifest)).toEqual(before);
    expect(
      JSON.parse(readFileSync(join(unpacked, 'resources/rune-workflow.json'), 'utf8')),
    ).toEqual({
      schemaVersion: 1,
      manifest: 'workflow/custom.yaml',
    });
    expect(readFileSync(join(unpacked, 'resources/workflow/extra.txt'), 'utf8')).toBe('explicit');
    expect(existsSync(join(unpacked, 'resources/workflow/assets/logo.svg'))).toBe(true);
    expect(existsSync(join(unpacked, 'resources/workflow/payload'))).toBe(true);
    expect(existsSync(join(unpacked, 'resources/workflow/private.txt'))).toBe(false);
    expect(existsSync(join(unpacked, '.rune-complete.json'))).toBe(false);
    expect(messages.some((line) => line.startsWith('stdout:'))).toBe(false);
    expect(readdirSync(root).some((name) => name.startsWith('.rune-package-'))).toBe(false);
  });

  it('uses the installed binary directory when no shell override is supplied', async () => {
    control.location = { kind: 'binary', path: join(shell, 'rune-gui-shell.exe') };
    expect(await packageRun([], false)).toBe(0);
  });

  it.each([undefined, { kind: 'dev' as const, dir: 'development' }])(
    'requires a distributable shell when cache selection is %j',
    async (location) => {
      control.location = location;
      expect(await packageRun([], false)).toBe(2);
      expect(messages.join()).toContain('rune gui install');
    },
  );

  it('requires explicit inclusion of GUI resources outside the standard directories', async () => {
    writeFileSync(join(source, 'brand.css'), ':root { --rune-accent: red; }');
    writeFileSync(manifest, readFileSync(manifest, 'utf8') + 'gui: {theme: brand.css}\n');
    expect(await packageRun()).toBe(2);
    expect(await packageRun(['--include', 'brand.css'])).toBe(0);
  });

  it('refuses an existing archive and preserves its contents', async () => {
    writeFileSync(output, 'original');
    expect(await packageRun()).toBe(2);
    expect(readFileSync(output, 'utf8')).toBe('original');
  });

  it('requires the target host archive format', async () => {
    output = join(root, 'wrong.bin');
    expect(await packageRun()).toBe(2);
  });

  it.each([
    ['platform', 'darwin'],
    ['arch', 'arm64'],
  ] as const)('refuses unsupported %s %s', async (key, value) => {
    const descriptor = Object.getOwnPropertyDescriptor(process, key)!;
    Object.defineProperty(process, key, { ...descriptor, value });
    try {
      expect(await packageRun()).toBe(2);
    } finally {
      Object.defineProperty(process, key, descriptor);
    }
  });

  it.each([
    null,
    [],
    { protocolVersion: 2, runeVersion: RUNE_VERSION, workflowPackageVersion: 1 },
    { protocolVersion: 1, runeVersion: 'different', workflowPackageVersion: 1 },
    { protocolVersion: 1, runeVersion: RUNE_VERSION },
    { protocolVersion: 1, runeVersion: RUNE_VERSION, workflowPackageVersion: 2 },
  ])('refuses an incompatible runtime probe %j', async (probe) => {
    control.probe = probe;
    expect(await packageRun()).toBe(2);
    expect(existsSync(output)).toBe(false);
  });

  it('reports a failed probe and invalid JSON without echoing probe bytes', async () => {
    control.probeFailure = true;
    expect(await packageRun()).toBe(2);
    control.probeFailure = false;
    control.rawProbe = 'private-invalid-probe';
    expect(await packageRun()).toBe(2);
    expect(messages.join()).not.toContain(control.rawProbe);
  });

  it('refuses runtimes already bound to a workflow and incomplete runtime archives', async () => {
    writeFileSync(join(shell, 'resources/rune-workflow.json'), '{}');
    expect(await packageRun()).toBe(2);
    rmSync(join(shell, 'resources/rune-workflow.json'));
    mkdirSync(join(shell, 'resources/workflow'));
    expect(await packageRun()).toBe(2);
    rmdirSync(join(shell, 'resources/workflow'));
    rmSync(join(shell, 'resources/app.asar'));
    expect(await packageRun()).toBe(2);
  });

  it('cleans staging after an archive tool failure and leaves no output', async () => {
    control.archiveFailure = true;
    expect(await packageRun()).toBe(1);
    expect(existsSync(output)).toBe(false);
    expect(readdirSync(root).some((name) => name.startsWith('.rune-package-'))).toBe(false);
  });

  it('reports filesystem failures as packaging failures', async () => {
    writeFileSync(join(root, 'not-a-directory'), 'file');
    output = join(root, 'not-a-directory', 'result' + extension);
    expect(await packageRun()).toBe(1);
    expect(messages.join()).toContain('could not read or write');
  });
});

describe('package resource boundaries', () => {
  it.each(['../outside', '/absolute', 'C:\\outside', 'a/../b', 'a//b', '.', 'a\0b'])(
    'refuses nonportable resource path %j',
    (path) => expect(() => resourcePath(path)).toThrow('beneath'),
  );

  it('normalizes explicit Windows separators and keeps nested relative resources', () => {
    expect(resourcePath('assets\\image.png')).toBe('assets/image.png');
    expect(resourcePath('.\\assets\\image.png')).toBe('assets/image.png');
    expect(resourcePath('././assets/image.png')).toBe('assets/image.png');
    expect(inside(root, root)).toBe(false);
    expect(inside(root, resolve(root, '..', 'elsewhere'))).toBe(false);
  });

  it('refuses missing resources and directory links without traversing them', () => {
    expect(() => workflowFiles(manifest, ['missing'])).toThrow('does not exist');
    const outside = join(root, 'outside');
    mkdirSync(outside);
    symlinkSync(outside, join(source, 'assets'), process.platform === 'win32' ? 'junction' : 'dir');
    expect(() => workflowFiles(manifest, [])).toThrow('not links');
    rmSync(join(source, 'assets'));
    writeFileSync(join(outside, 'private.txt'), 'outside');
    symlinkSync(outside, join(source, 'linked'), process.platform === 'win32' ? 'junction' : 'dir');
    expect(() => workflowFiles(manifest, ['linked/private.txt'])).toThrow('not links');
    expect(() => copyFiles(source, join(root, 'copied'), ['linked/private.txt'])).toThrow(
      'not links',
    );
  });

  it('refuses a changed source during copying and links in the runtime', () => {
    const outside = join(root, 'outside');
    mkdirSync(outside);
    symlinkSync(outside, join(shell, 'linked'), process.platform === 'win32' ? 'junction' : 'dir');
    expect(() => shellFiles(shell)).toThrow('not links');
    expect(() => copyFiles(shell, join(root, 'destination'), ['linked'])).toThrow('not links');
  });
});
