import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  copyFileSync,
  createReadStream,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, relative, resolve, sep } from 'node:path';
import process from 'node:process';
import { fileURLToPath, URL } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const outputRoot = join(root, 'output');
const shellDirectory = join(root, 'packages', 'gui-shell');
const engineDirectory = join(root, 'packages', 'engine');
const npmCli = process.env.npm_execpath;
assert(npmCli, 'Run this build with npm run build:shell');
assert.equal(process.argv.length, 2, 'This build accepts no target overrides');
assert(['win32', 'linux'].includes(process.platform), 'Build on the supported target host');
assert.equal(process.arch, 'x64', 'Only host x64 shell archives are currently supported');

const readJson = (path) => JSON.parse(readFileSync(path, 'utf8'));
const writeJson = (path, value) => writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
const lock = readJson(join(root, 'package-lock.json'));
const shellManifest = readJson(join(shellDirectory, 'package.json'));
const engineManifest = readJson(join(engineDirectory, 'package.json'));
assert.equal(shellManifest.version, engineManifest.version, 'Shell and engine versions must match');
assert.equal(shellManifest.dependencies[engineManifest.name], engineManifest.version);

const shellRequire = createRequire(join(shellDirectory, 'package.json'));
const electronDirectory = dirname(shellRequire.resolve('electron/package.json'));
const electronManifest = readJson(join(electronDirectory, 'package.json'));
const electronLockKey = relative(root, electronDirectory).split(sep).join('/');
assert.equal(electronManifest.version, lock.packages[electronLockKey]?.version);
const electronDist = join(electronDirectory, 'dist');
assert(
  existsSync(join(electronDist, process.platform === 'win32' ? 'electron.exe' : 'electron')),
  'Prepare Electron first: npm run prepare:electron --workspace @rune/gui-shell',
);
assert.equal(readFileSync(join(electronDist, 'version'), 'utf8').trim(), electronManifest.version);

const platformName = process.platform === 'win32' ? 'windows' : 'linux';
const extension = process.platform === 'win32' ? 'zip' : 'tar.gz';
const destination = join(outputRoot, 'shell', `${platformName}-${process.arch}`);
mkdirSync(destination, { recursive: true });
const staging = mkdtempSync(join(outputRoot, '.shell-stage-'));
const appDirectory = join(staging, 'app');
mkdirSync(appDirectory);

/** Include only compiler outputs whose current source still exists, never stale dist files. */
function copyRuntime(source, compiled, destination) {
  for (const entry of readdirSync(source, { withFileTypes: true })) {
    assert(!entry.isSymbolicLink(), `Runtime source must not be a symlink: ${entry.name}`);
    if (entry.isDirectory()) {
      copyRuntime(
        join(source, entry.name),
        join(compiled, entry.name),
        join(destination, entry.name),
      );
    } else if (/\.(?:ts|cts|mts)$/u.test(entry.name) && !/\.d\.(?:ts|cts|mts)$/u.test(entry.name)) {
      const outputName = entry.name.replace(/\.(ts|cts|mts)$/u, (_match, extension) =>
        extension === 'ts' ? '.js' : extension === 'cts' ? '.cjs' : '.mjs',
      );
      mkdirSync(destination, { recursive: true });
      copyFileSync(join(compiled, outputName), join(destination, outputName));
    }
  }
}

function installRuntime() {
  const result = spawnSync(
    process.execPath,
    [
      npmCli,
      'ci',
      '--omit=dev',
      '--ignore-scripts',
      '--no-audit',
      '--no-fund',
      '--workspaces=false',
    ],
    {
      cwd: appDirectory,
      stdio: 'inherit',
      shell: false,
      timeout: 120_000,
      env: { ...process.env, npm_config_cache: join(outputRoot, 'cache', 'npm') },
    },
  );
  assert.ifError(result.error);
  assert.equal(result.status, 0, 'Installing the locked shell runtime failed');
}

/** Preserve npm's actual lock locations, including dependencies nested under the engine. */
function productionLock(appManifest, runtimeEngine) {
  const packages = {
    '': {
      name: appManifest.name,
      version: appManifest.version,
      license: appManifest.license,
      dependencies: appManifest.dependencies,
    },
    engine: runtimeEngine,
    [`node_modules/${engineManifest.name}`]: { resolved: 'engine', link: true },
  };
  const selected = new Set();
  const stageKey = (key) => key.replace(/^packages\/engine(?=\/|$)/u, 'engine');
  const collect = (owner, name, optional = false) => {
    let directory = owner;
    let key;
    while (true) {
      const candidate = `${directory === '' ? '' : `${directory}/`}node_modules/${name}`;
      if (lock.packages[candidate] !== undefined) {
        key = candidate;
        break;
      }
      if (directory === '') break;
      directory = directory.includes('/') ? directory.slice(0, directory.lastIndexOf('/')) : '';
    }
    if (key === undefined && optional) return;
    assert(key, `The lockfile has no production dependency ${name} for ${owner}`);
    if (selected.has(key)) return;
    const entry = lock.packages[key];
    assert(!entry.link, `Unexpected production workspace dependency: ${name}`);
    assert(!entry.hasInstallScript, `Review native or install-time runtime dependency: ${name}`);
    assert(
      entry.integrity && entry.resolved,
      `Runtime dependency ${name} must have locked integrity`,
    );
    selected.add(key);
    const { dev: _dev, devOptional: _devOptional, ...productionEntry } = entry;
    packages[stageKey(key)] = productionEntry;
    for (const dependency of Object.keys(entry.dependencies ?? {})) collect(key, dependency);
    for (const dependency of Object.keys(entry.optionalDependencies ?? {}))
      collect(key, dependency, true);
    for (const dependency of Object.keys(entry.peerDependencies ?? {})) {
      collect(key, dependency, entry.peerDependenciesMeta?.[dependency]?.optional === true);
    }
  };
  for (const name of Object.keys(runtimeEngine.dependencies)) collect('packages/engine', name);
  return {
    name: appManifest.name,
    version: appManifest.version,
    lockfileVersion: 3,
    requires: true,
    packages,
  };
}

async function sha256(path) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest('hex');
}

try {
  copyRuntime(
    join(shellDirectory, 'src'),
    join(shellDirectory, 'dist'),
    join(appDirectory, 'dist'),
  );
  for (const path of ['src/renderer/index.html', 'src/theme/default.css']) {
    mkdirSync(dirname(join(appDirectory, path)), { recursive: true });
    copyFileSync(join(shellDirectory, path), join(appDirectory, path));
  }
  copyFileSync(join(root, 'LICENSE'), join(appDirectory, 'LICENSE'));
  const stagedEngine = join(appDirectory, 'engine');
  mkdirSync(stagedEngine);
  copyRuntime(
    join(engineDirectory, 'src'),
    join(engineDirectory, 'dist'),
    join(stagedEngine, 'dist'),
  );
  copyFileSync(join(root, 'LICENSE'), join(stagedEngine, 'LICENSE'));
  const runtimeEngine = {
    name: engineManifest.name,
    version: engineManifest.version,
    license: engineManifest.license,
    type: 'module',
    main: './dist/index.js',
    exports: { '.': { import: './dist/index.js', default: './dist/index.js' } },
    dependencies: engineManifest.dependencies,
  };
  const appManifest = {
    name: 'rune-gui-shell',
    productName: 'RUNE GUI Shell',
    version: shellManifest.version,
    description: shellManifest.description,
    author: 'Marcus Korinth',
    license: shellManifest.license,
    private: true,
    type: 'module',
    main: 'dist/main/index.js',
    dependencies: { [engineManifest.name]: 'file:./engine' },
  };
  writeJson(join(stagedEngine, 'package.json'), runtimeEngine);
  writeJson(join(appDirectory, 'package.json'), appManifest);
  const runtimeLock = productionLock(appManifest, runtimeEngine);
  writeJson(join(appDirectory, 'package-lock.json'), runtimeLock);
  installRuntime();

  process.env.ELECTRON_BUILDER_CACHE = join(outputRoot, 'cache', 'electron-builder');
  process.env.CSC_IDENTITY_AUTO_DISCOVERY = 'false';
  const { build, Platform, Arch } = shellRequire('electron-builder');
  const platform = process.platform === 'win32' ? Platform.WINDOWS : Platform.LINUX;
  const archiveName = `rune-gui-shell-${platformName}.${extension}`;
  const artifacts = await build({
    projectDir: appDirectory,
    targets: platform.createTarget(process.platform === 'linux' ? 'dir' : extension, Arch.x64),
    publish: 'never',
    config: {
      appId: 'io.github.marcuskorinth.rune-setup',
      productName: appManifest.productName,
      electronVersion: electronManifest.version,
      electronDist,
      asar: true,
      npmRebuild: false,
      directories: { output: destination, buildResources: join(staging, 'resources') },
      files: [
        'dist/**/*.js',
        'dist/**/*.cjs',
        'dist/**/*.mjs',
        'src/renderer/index.html',
        'src/theme/default.css',
        'LICENSE',
        '!**/*.map',
        '!**/*.ts',
        '!**/*.md',
      ],
      artifactName: archiveName,
      win: {
        executableName: 'rune-gui-shell',
        signExecutable: false,
        requestedExecutionLevel: 'asInvoker',
      },
      linux: { executableName: 'rune-gui-shell', category: 'Utility' },
    },
  });
  const archive = join(destination, archiveName);
  if (process.platform === 'linux') {
    // Builder's tar target adds a wrapper directory; gui install requires the executable at root.
    const unpacked = join(destination, 'linux-unpacked');
    assert(
      existsSync(join(unpacked, 'rune-gui-shell')),
      'Builder did not produce the shell binary',
    );
    const launcher = join(unpacked, 'rune-gui-shell');
    renameSync(launcher, join(unpacked, 'rune-gui-shell-bin'));
    copyFileSync(join(shellDirectory, 'scripts', 'launch-linux.sh'), launcher);
    chmodSync(launcher, 0o755);
    // Keep the temporary archive on the destination filesystem, including bind-mounted output.
    const archiveWork = mkdtempSync(join(destination, '.archive-'));
    try {
      const stagedArchive = join(archiveWork, archiveName);
      const result = spawnSync(
        'tar',
        ['-czf', stagedArchive, '-C', unpacked, '--', ...readdirSync(unpacked)],
        {
          stdio: 'inherit',
          shell: false,
          timeout: 120_000,
        },
      );
      assert.ifError(result.error);
      assert.equal(result.status, 0, 'Creating the Linux shell archive failed');
      renameSync(stagedArchive, archive);
    } finally {
      assert(resolve(archiveWork).startsWith(`${resolve(destination)}${sep}`));
      rmSync(archiveWork, { recursive: true, force: true });
    }
  } else {
    assert(artifacts.includes(archive), 'Builder did not produce the requested archive');
  }
  assert(existsSync(archive), 'The shell archive is missing');
  writeJson(join(destination, 'build-metadata.json'), {
    platform: platformName,
    architecture: process.arch,
    shellVersion: shellManifest.version,
    electronVersion: electronManifest.version,
    lockfileSha256: await sha256(join(root, 'package-lock.json')),
    runtime: Object.fromEntries(
      Object.entries(runtimeLock.packages)
        .filter(([key]) => key !== '')
        .map(([key, value]) => [
          key,
          {
            version: value.version ?? runtimeEngine.version,
            ...(value.integrity === undefined ? {} : { integrity: value.integrity }),
          },
        ]),
    ),
    archive: archiveName,
    archiveSha256: await sha256(archive),
  });
  process.stdout.write(`Shell archive: ${archive}\n`);
} finally {
  const absoluteStaging = resolve(staging);
  assert(absoluteStaging.startsWith(`${resolve(outputRoot)}${sep}`));
  rmSync(absoluteStaging, { recursive: true, force: true });
}
