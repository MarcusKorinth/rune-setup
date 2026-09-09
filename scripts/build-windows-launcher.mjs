import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { basename, join } from 'node:path';
import process from 'node:process';
import { fileURLToPath, URL } from 'node:url';

const source = fileURLToPath(
  new URL('../packages/gui-shell/scripts/launch-windows.c', import.meta.url),
);

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { shell: false, timeout: 120_000, ...options });
  assert.ifError(result.error);
  assert.equal(
    result.status,
    0,
    result.stderr?.toString() || 'Windows launcher compilation failed',
  );
  return result.stdout?.toString().trim();
}

function latestDirectory(directory, prefix = '') {
  assert(existsSync(directory), `Missing Windows build tools: ${directory}`);
  const names = readdirSync(directory, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && entry.name.startsWith(prefix))
    .map((entry) => entry.name)
    .sort((left, right) => right.localeCompare(left, 'en', { numeric: true }));
  assert(names[0], `Missing Windows build tools: ${directory}`);
  return join(directory, names[0]);
}

/** Build only an OS transport shim; the engine continues to run inside Electron. */
export async function installWindowsLauncher(context) {
  if (context.electronPlatformName !== 'win32') return;
  const executable = join(context.appOutDir, 'rune-gui-shell.exe');
  const runtime = join(context.appOutDir, 'rune-gui-shell-bin.exe');
  renameSync(executable, runtime);
  const customCompiler = process.env.RUNE_WINDOWS_CC;
  if (customCompiler) {
    // A portable LLVM-MinGW clang or Zig cc is useful outside an MSVC developer machine.
    const zig = /^zig(?:\.exe)?$/iu.test(basename(customCompiler));
    run(
      customCompiler,
      [
        ...(zig ? ['cc'] : []),
        source,
        '-o',
        executable,
        '-municode',
        ...(zig ? ['-Wl,--subsystem,windows'] : ['-mwindows']),
        '-O2',
        '-Wall',
        '-Wextra',
        '-Werror',
        '-static',
        '-luser32',
      ],
      { stdio: 'inherit' },
    );
  } else {
    const programFiles = process.env['ProgramFiles(x86)'];
    assert(programFiles, 'Windows Program Files directory is unavailable');
    const vswhere = join(programFiles, 'Microsoft Visual Studio', 'Installer', 'vswhere.exe');
    assert(existsSync(vswhere), 'Install Visual Studio C++ Build Tools or set RUNE_WINDOWS_CC');
    const installation = run(vswhere, [
      '-latest',
      '-products',
      '*',
      '-requires',
      'Microsoft.VisualStudio.Component.VC.Tools.x86.x64',
      '-property',
      'installationPath',
    ]);
    assert(installation, 'Install Visual Studio C++ Build Tools or set RUNE_WINDOWS_CC');
    const msvc = latestDirectory(join(installation, 'VC', 'Tools', 'MSVC'));
    const sdk = join(programFiles, 'Windows Kits', '10');
    const includes = latestDirectory(join(sdk, 'Include'), '10.');
    const libraries = join(sdk, 'Lib', basename(includes));
    const compilerDirectory = join(msvc, 'bin', 'Hostx64', 'x64');
    const environment = { ...process.env };
    const pathKey = Object.keys(environment).find((key) => key.toUpperCase() === 'PATH') ?? 'PATH';
    environment[pathKey] = `${compilerDirectory};${environment[pathKey] ?? ''}`;
    run(
      join(compilerDirectory, 'cl.exe'),
      [
        '/nologo',
        '/O2',
        '/MT',
        '/std:c17',
        '/W4',
        '/WX',
        '/D_CRT_SECURE_NO_WARNINGS',
        `/I${join(msvc, 'include')}`,
        ...['ucrt', 'shared', 'um'].map((part) => `/I${join(includes, part)}`),
        source,
        `/Fe:${executable}`,
        `/Fo:${join(context.appOutDir, 'rune-launcher.obj')}`,
        '/link',
        '/SUBSYSTEM:WINDOWS',
        '/DYNAMICBASE',
        '/NXCOMPAT',
        `/LIBPATH:${join(msvc, 'lib', 'x64')}`,
        ...['ucrt', 'um'].map((part) => `/LIBPATH:${join(libraries, part, 'x64')}`),
        'kernel32.lib',
        'user32.lib',
      ],
      { stdio: 'inherit', env: environment },
    );
  }
  rmSync(join(context.appOutDir, 'rune-launcher.obj'), { force: true });
  rmSync(join(context.appOutDir, 'rune-gui-shell.pdb'), { force: true });
  // Builder stamps the public launcher after this hook. Stamp the inner Electron
  // executable through the same pinned builder path, including icon and version.
  await context.packager.signAndEditResources(
    runtime,
    context.arch,
    context.outDir,
    'rune-gui-shell-bin',
    'asInvoker',
  );
  const require = createRequire(import.meta.url);
  const builderRequire = createRequire(require.resolve('app-builder-lib/package.json'));
  const { NtExecutable, NtExecutableResource } = builderRequire('resedit');
  const launcher = NtExecutable.from(readFileSync(executable));
  const resources = NtExecutableResource.from(NtExecutable.from(readFileSync(runtime)));
  // Reuse the already branded icon, version and application manifest. Starting
  // with version translations also avoids a second, empty neutral-language entry.
  resources.entries = resources.entries.filter((entry) => [3, 14, 16, 24].includes(entry.type));
  resources.outputResource(launcher);
  writeFileSync(executable, Buffer.from(launcher.generate()));
}
