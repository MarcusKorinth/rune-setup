import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import process from 'node:process';
import { fileURLToPath, pathToFileURL, URL } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const npmCli = process.env.npm_execpath;
assert(npmCli, 'Run this check with npm run test:packages');
const temporaryRoot = resolve(tmpdir());
const directory = mkdtempSync(join(temporaryRoot, 'rune-package-check-'));
const consumer = join(directory, 'consumer with spaces');
mkdirSync(consumer);
const staleFixtures = [];

function run(args, cwd = root) {
  const result = spawnSync(process.execPath, args, {
    cwd,
    encoding: 'utf8',
    shell: false,
    timeout: 120_000,
    env: { ...process.env, RUNE_LOCALE: 'C' },
  });
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr + result.stdout);
  return result.stdout;
}

try {
  const packages = [];
  for (const workspace of ['engine', 'cli']) {
    const packageDirectory = join(root, 'packages', workspace);
    const manifest = JSON.parse(readFileSync(join(packageDirectory, 'package.json'), 'utf8'));
    const packageOutput = join(packageDirectory, 'dist');
    mkdirSync(packageOutput, { recursive: true });
    const stale = mkdtempSync(join(packageOutput, 'stale-pack-'));
    staleFixtures.push({ directory: stale, parent: packageOutput });
    for (const extension of ['js', 'js.map', 'd.ts', 'd.ts.map']) {
      writeFileSync(join(stale, `orphan.${extension}`), 'stale package output\n');
    }
    const reports = JSON.parse(
      run([
        npmCli,
        'pack',
        '--silent',
        '--json',
        '--workspace',
        manifest.name,
        '--pack-destination',
        directory,
      ]),
    );
    assert.equal(reports.length, 1);
    const report = reports[0];
    assert.equal(report.version, manifest.version);
    const paths = report.files.map((file) => file.path);
    assert(
      !paths.some((path) => path.startsWith(`dist/${basename(stale)}/`)),
      `${report.name} includes stale outputs from an earlier build`,
    );
    assert(!existsSync(stale), `${report.name} did not clean its generated output before packing`);
    for (const required of ['package.json', 'README.md', 'LICENSE']) {
      assert(paths.includes(required), `${report.name} is missing ${required}`);
    }
    for (const path of paths) {
      assert(
        ['package.json', 'README.md', 'LICENSE'].includes(path) ||
          /^dist\/.+\.(?:js|js\.map|d\.ts|d\.ts\.map)$/u.test(path),
        `Unexpected package file: ${report.name}/${path}`,
      );
    }
    packages.push({ manifest, report });
  }

  const [enginePackage, cliPackage] = packages;
  for (const declaredTypeTarget of [
    enginePackage.manifest.types,
    enginePackage.manifest.exports['.'].types,
  ]) {
    const typeTarget = declaredTypeTarget.replace(/^\.\//u, '');
    assert(
      enginePackage.report.files.some((file) => file.path === typeTarget),
      `${enginePackage.report.name} is missing declared type target ${declaredTypeTarget}`,
    );
  }
  assert.equal(
    cliPackage.manifest.dependencies[enginePackage.manifest.name],
    enginePackage.manifest.version,
  );
  writeFileSync(join(consumer, 'package.json'), JSON.stringify({ private: true, type: 'module' }));
  run(
    [
      npmCli,
      'install',
      '--omit=dev',
      '--ignore-scripts',
      '--no-audit',
      '--no-fund',
      ...packages.map(({ report }) => join(directory, report.filename)),
    ],
    consumer,
  );

  assert(!existsSync(join(consumer, 'node_modules', 'electron')));
  assert(
    existsSync(
      join(consumer, 'node_modules', '.bin', process.platform === 'win32' ? 'rune.cmd' : 'rune'),
    ),
  );
  const cliDirectory = join(consumer, 'node_modules', cliPackage.manifest.name);
  const cli = join(cliDirectory, cliPackage.manifest.bin.rune);
  assert.equal(
    run([cli, '--version'], consumer).trim(),
    `rune ${cliPackage.manifest.version} (engine ${enginePackage.manifest.version})`,
  );
  assert.equal(
    run([npmCli, 'exec', '--offline', '--', 'rune', '--version'], consumer).trim(),
    `rune ${cliPackage.manifest.version} (engine ${enginePackage.manifest.version})`,
    'The installed npm command shim must invoke the packaged CLI',
  );
  for (const args of [['schema'], ['schema', '--result']]) {
    assert.equal(
      JSON.parse(run([cli, ...args], consumer)).$schema,
      'https://json-schema.org/draft/2020-12/schema',
    );
  }

  const manifest = join(consumer, 'installer.yaml');
  writeFileSync(
    manifest,
    [
      'schemaVersion: 1',
      'product: { name: Package check, version: "1.0.0" }',
      'inputs: { token: { type: secret } }',
      'steps:',
      '  - id: verify',
      '    title: Verify installed package',
      '    run:',
      `      command: ${JSON.stringify(process.execPath)}`,
      '      args: ["-e", "console.log(process.env.TOKEN)"]',
      '      env: { TOKEN: "${token}" }',
      '',
    ].join('\n'),
  );
  run([cli, 'validate', manifest], consumer);
  const secret = 'package-check-private-value';
  const resultPath = join(consumer, 'result.json');
  const logPath = join(consumer, 'run.log');
  run(
    [
      cli,
      'run',
      manifest,
      '--non-interactive',
      '--set',
      `token=${secret}`,
      '--result',
      resultPath,
      '--log-file',
      logPath,
    ],
    consumer,
  );
  const resultText = readFileSync(resultPath, 'utf8');
  const logText = readFileSync(logPath, 'utf8');
  const result = JSON.parse(resultText);
  assert.equal(result.status, 'succeeded');
  assert.equal(result.exitCode, 0);
  assert.equal(result.stepsSucceeded, 1);
  assert.equal(result.inputs[0].value, null);
  assert(!resultText.includes(secret));
  assert(!logText.includes(secret));
  assert(logText.includes('***'));
  const engineDirectory = join(consumer, 'node_modules', enginePackage.manifest.name);
  const engine = await import(pathToFileURL(join(engineDirectory, enginePackage.manifest.main)));
  assert.equal(engine.serializeResult(result), resultText);
  process.stdout.write(
    'Installed package checks passed: clean outputs, contents, version, schemas, execution, masking.\n',
  );
} finally {
  for (const fixture of staleFixtures) {
    assert.equal(
      dirname(fixture.directory),
      fixture.parent,
      'Refuse cleanup outside package output',
    );
    rmSync(fixture.directory, { recursive: true, force: true });
  }
  assert.equal(dirname(directory), temporaryRoot, 'Refuse cleanup outside the temporary directory');
  rmSync(directory, { recursive: true, force: true });
}
