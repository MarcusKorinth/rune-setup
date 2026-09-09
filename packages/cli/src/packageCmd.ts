import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, linkSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, relative, resolve } from 'node:path';

import { PlatformError, RUNE_VERSION, RuneError, UsageError, validateManifest } from '@rune/engine';

import { locateShell } from './guiCmd.js';
import { ExitWithCode, humanStderr, type CliIo } from './io.js';
import { copyFiles, inside, resourcePath, shellFiles, workflowFiles } from './packageFiles.js';

export interface PackageFlags {
  readonly output: string;
  readonly shell?: string;
  readonly include?: readonly string[];
}

export function verifyPackageShell(directory: string): void {
  if (existsSync(join(directory, 'resources', 'rune-workflow.json'))) {
    throw new UsageError('use a generic GUI shell, not an already packaged workflow');
  }
  const executable = join(
    directory,
    process.platform === 'win32' ? 'rune-gui-shell.exe' : 'rune-gui-shell',
  );
  const probe = spawnSync(executable, ['--rune-version-probe'], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
    shell: false,
    timeout: 10_000,
    killSignal: 'SIGKILL',
    maxBuffer: 4096,
    windowsHide: true,
  });
  if (probe.error !== undefined || probe.status !== 0) {
    throw new UsageError('the package shell could not complete its version probe');
  }
  let value: unknown;
  try {
    value = JSON.parse(probe.stdout);
  } catch {
    throw new UsageError('the package shell returned an invalid version probe');
  }
  if (
    typeof value !== 'object' ||
    value === null ||
    !('protocolVersion' in value) ||
    value.protocolVersion !== 1 ||
    !('runeVersion' in value) ||
    value.runeVersion !== RUNE_VERSION ||
    !('workflowPackageVersion' in value) ||
    value.workflowPackageVersion !== 1
  ) {
    throw new UsageError('the package shell must match this engine and support workflow packaging');
  }
}

/** Build a portable archive without running the workflow or collecting input values. */
export function packageCommand(manifestPath: string, flags: PackageFlags, io: CliIo): void {
  try {
    createPackage(manifestPath, flags, io);
  } catch (error) {
    if (error instanceof RuneError || error instanceof ExitWithCode) throw error;
    humanStderr(
      io,
      'could not read or write the workflow package; check paths, permissions and disk space',
    );
    throw new ExitWithCode(1);
  }
}

function createPackage(manifestPath: string, flags: PackageFlags, io: CliIo): void {
  if (!['win32', 'linux'].includes(process.platform) || process.arch !== 'x64') {
    throw new PlatformError('workflow packaging supports Windows and Linux x64 hosts');
  }
  const extension = process.platform === 'win32' ? '.zip' : '.tar.gz';
  if (!flags.output.endsWith(extension)) {
    throw new UsageError('the package output must end in ' + extension + ' on this host');
  }
  const output = resolve(flags.output);
  if (existsSync(output)) throw new UsageError('the package output already exists');
  const manifest = resolve(manifestPath);
  const root = dirname(manifest);
  const files = workflowFiles(manifest, flags.include ?? []);
  const report = validateManifest(manifest);
  for (const path of [
    report.manifest.gui?.logo,
    report.manifest.gui?.banner,
    report.manifest.gui?.theme,
  ]) {
    if (path === undefined) continue;
    const portable = resourcePath(path);
    if (!files.includes(portable)) {
      throw new UsageError('a GUI resource is not packaged; add its path with --include');
    }
  }

  let shellDirectory: string;
  if (flags.shell !== undefined) {
    shellDirectory = resolve(flags.shell);
  } else {
    const location = locateShell();
    if (location?.kind !== 'binary') {
      throw new UsageError('install a GUI shell with rune gui install or pass --shell DIRECTORY');
    }
    shellDirectory = dirname(location.path);
  }
  verifyPackageShell(shellDirectory);
  const runtime = shellFiles(shellDirectory);
  if (!runtime.includes('resources/app.asar')) {
    throw new UsageError('the package shell is missing its application archive');
  }
  if (
    runtime.some((path) => path === 'resources/workflow' || path.startsWith('resources/workflow/'))
  ) {
    throw new UsageError('the package shell already contains workflow resources');
  }

  mkdirSync(dirname(output), { recursive: true });
  const temporary = mkdtempSync(join(dirname(output), '.rune-package-'));
  try {
    const staged = join(temporary, 'app');
    mkdirSync(staged);
    copyFiles(shellDirectory, staged, runtime);
    copyFiles(root, join(staged, 'resources', 'workflow'), files);
    writeFileSync(
      join(staged, 'resources', 'rune-workflow.json'),
      JSON.stringify({
        schemaVersion: 1,
        manifest: 'workflow/' + resourcePath(relative(root, manifest)),
      }) + '\n',
      { flag: 'wx' },
    );
    const archive = join(temporary, 'workflow' + extension);
    const result = spawnSync(
      'tar',
      [process.platform === 'win32' ? '-acf' : '-czf', archive, '-C', staged, '--', '.'],
      {
        stdio: ['ignore', 'ignore', 'ignore'],
        shell: false,
        timeout: 120_000,
        killSignal: 'SIGKILL',
      },
    );
    if (result.error !== undefined || result.status !== 0) {
      humanStderr(io, 'could not create the workflow archive; check tar and available disk space');
      throw new ExitWithCode(1);
    }
    // Hard-link publication is atomic, stays on one filesystem and refuses an existing target.
    linkSync(archive, output);
  } finally {
    assert(inside(dirname(output), temporary) && basename(temporary).startsWith('.rune-package-'));
    rmSync(temporary, { recursive: true, force: true });
  }
  humanStderr(io, 'Created workflow package: ' + output);
}
