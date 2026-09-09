import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { clearTimeout, setTimeout } from 'node:timers';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath, URL } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const require = createRequire(join(root, 'packages/gui-shell/package.json'));
const { chromium, expect } = require('@playwright/test');
assert(['win32', 'linux'].includes(process.platform) && process.arch === 'x64');
const windows = process.platform === 'win32';
const platform = windows ? 'windows' : 'linux';
const extension = windows ? 'zip' : 'tar.gz';
const shellArchive = resolve(
  process.argv[2] ??
    join(root, 'output/shell', `${platform}-x64`, `rune-gui-shell-${platform}.${extension}`),
);
assert(existsSync(shellArchive), 'Build the current shell archive before package verification');
const temporaryRoot = resolve(tmpdir());
const directory = mkdtempSync(join(temporaryRoot, 'rune workflow package '));
const source = join(directory, 'author workflow');
const shell = join(directory, 'fresh generic shell');
const unpacked = join(directory, 'extracted portable setup');
const caller = join(directory, 'unrelated working directory');
const emptyPath = join(directory, 'path without node');
for (const path of [source, shell, unpacked, caller, emptyPath]) mkdirSync(path);
const executable = join(unpacked, windows ? 'rune-gui-shell.exe' : 'rune-gui-shell');
const manifestName = 'setup recipe.yaml';
const packagedWorkflow = join(unpacked, 'resources/workflow');
const secret = 'portable-check-private-token';
const payload = 'workflow payload copied by a real OS process';
const version = JSON.parse(
  readFileSync(join(root, 'packages/engine/package.json'), 'utf8'),
).version;
const scriptName = windows ? 'check.ps1' : 'check.sh';
const command = windows
  ? join(process.env.SystemRoot, 'System32/WindowsPowerShell/v1.0/powershell.exe')
  : '/bin/sh';
const args = [
  ...(windows ? ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File'] : []),
  '${manifestDir}/scripts/' + scriptName,
  '${manifestDir}/payload/message.txt',
  '${manifestDir}/executed.txt',
];
const resources = {
  ['scripts/' + scriptName]: windows
    ? 'param([string]$Payload, [string]$Marker)\n[IO.File]::WriteAllText($Marker, [IO.File]::ReadAllText($Payload))\n[Console]::WriteLine("portable-output:" + $env:RUNE_PACKAGE_TOKEN)\n'
    : 'IFS= read -r payload < "$1"\nprintf %s "$payload" > "$2"\nprintf "portable-output:%s\\n" "$RUNE_PACKAGE_TOKEN"\n',
  'payload/message.txt': payload,
  'assets/logo #1.svg':
    '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24"><rect width="24" height="24" fill="#2563eb"/></svg>\n',
  'assets/custom theme.css': ':root { --rune-radius: 3px; --portable-theme-loaded: yes; }\n',
  'locales/de.yaml': "rune.result.succeeded: 'Paket erfolgreich'\n",
  [manifestName]: [
    'schemaVersion: 1',
    'product: { name: Portable workflow check, version: 1.0.0 }',
    'gui:',
    '  windowTitle: Portable setup window',
    "  accentColor: '#2563eb'",
    "  logo: './assets/logo #1.svg'",
    "  theme: './assets/custom theme.css'",
    'inputs: { token: { type: secret } }',
    'steps:',
    '  - id: copy',
    '    title: Copy bundled payload',
    '    run:',
    `      command: ${JSON.stringify(command)}`,
    `      args: ${JSON.stringify(args)}`,
    '      env: { RUNE_PACKAGE_TOKEN: "${token}" }',
    '',
  ].join('\n'),
};
const environment = { ...process.env, RUNE_LOCALE: 'de', RUNE_INPUT_TOKEN: secret };
for (const key of Object.keys(environment)) {
  if (
    [
      'PATH',
      'NODE_OPTIONS',
      'NODE_PATH',
      'ELECTRON_RUN_AS_NODE',
      'RUNE_GUI_STARTUP_TOKEN',
    ].includes(key.toUpperCase())
  )
    delete environment[key];
}
environment.PATH = emptyPath;
const headlessEnvironment = { ...environment };
delete headlessEnvironment.DISPLAY;
delete headlessEnvironment.WAYLAND_DISPLAY;

function invoke(command, args, env = process.env, timeout = 30_000) {
  const result = spawnSync(command, args, {
    cwd: caller,
    env,
    shell: false,
    windowsHide: true,
    encoding: 'utf8',
    timeout,
  });
  assert.ifError(result.error);
  assert.equal(result.status, 0, `${command} exited ${result.status}\n${result.stderr}`);
  return result;
}

function invocation(mode) {
  return [
    ...(mode === 'headless' ? ['--non-interactive'] : ['--remote-debugging-port=0']),
    '--result',
    join(caller, mode + '.json'),
    '--log-file',
    join(caller, mode + '.log'),
  ];
}

function verifyOutcome(mode, stdout, stderr) {
  assert.equal(stdout, '', 'Portable execution must leave stdout byte-exactly empty');
  assert(!stderr.includes(secret), 'Portable diagnostics must mask declared secrets');
  const resultText = readFileSync(join(caller, mode + '.json'), 'utf8');
  const log = readFileSync(join(caller, mode + '.log'), 'utf8');
  assert(!resultText.includes(secret) && !log.includes(secret));
  const result = JSON.parse(resultText);
  assert.equal(result.status, 'succeeded');
  assert.equal(result.exitCode, 0);
  assert.equal(result.mode, mode === 'headless' ? 'non-interactive' : 'gui');
  assert.equal(result.runeVersion, version);
  assert.equal(result.locale, 'de');
  assert.equal(result.stepsSucceeded, 1);
  assert.equal(result.inputs[0].value, null);
  assert.equal(result.manifest.path, join(packagedWorkflow, manifestName));
  assert(log.includes('portable-output:***'));
  assert.equal(readFileSync(join(packagedWorkflow, 'executed.txt'), 'utf8'), payload);
  rmSync(join(packagedWorkflow, 'executed.txt'));
}

function within(promise, milliseconds) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error('Portable wizard did not close')),
      milliseconds,
    );
    void promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

let wizard;
let closed;
let browser;
let stdout = '';
let stderr = '';
try {
  for (const [path, content] of Object.entries(resources)) {
    mkdirSync(dirname(join(source, path)), { recursive: true });
    writeFileSync(join(source, path), content);
  }
  writeFileSync(
    join(source, 'private-notes.txt'),
    'This unrelated file must stay outside the package.',
  );
  writeFileSync(join(caller, manifestName), 'This cwd manifest must never be opened.');
  invoke('tar', ['-xf', shellArchive, '-C', shell]);
  const archive = join(directory, 'portable workflow.' + extension);
  const packaged = invoke(
    process.execPath,
    [
      join(root, 'packages/cli/dist/main.js'),
      'package',
      join(source, manifestName),
      '--output',
      archive,
      '--shell',
      shell,
    ],
    process.env,
    180_000,
  );
  assert.equal(packaged.stdout, '');
  assert(!existsSync(join(source, 'executed.txt')), 'Packaging must not execute the workflow');
  invoke('tar', ['-xf', archive, '-C', unpacked]);
  assert.deepEqual(
    JSON.parse(readFileSync(join(unpacked, 'resources/rune-workflow.json'), 'utf8')),
    {
      schemaVersion: 1,
      manifest: 'workflow/' + manifestName,
    },
  );
  for (const [path, content] of Object.entries(resources)) {
    assert.deepEqual(readFileSync(join(packagedWorkflow, path)), Buffer.from(content));
  }
  assert(!existsSync(join(packagedWorkflow, 'private-notes.txt')));
  assert.equal(dirname(source), directory, 'Refuse to remove anything outside the test directory');
  rmSync(source, { recursive: true });

  const headless = invoke(executable, invocation('headless'), headlessEnvironment);
  verifyOutcome('headless', headless.stdout, headless.stderr);
  process.stdout.write(
    'Portable headless workflow passed without source files, Node, or a display.\n',
  );

  wizard = spawn(executable, invocation('wizard'), {
    cwd: caller,
    env: environment,
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: !windows,
    shell: false,
    windowsHide: true,
  });
  wizard.stdout.setEncoding('utf8').on('data', (text) => {
    stdout += text;
  });
  wizard.stderr.setEncoding('utf8').on('data', (text) => {
    stderr += text;
  });
  closed = new Promise((resolve, reject) => {
    wizard.once('error', reject);
    wizard.once('close', (code, signal) => resolve({ code, signal }));
  });
  void closed.catch(() => undefined);
  let endpoint;
  for (let attempt = 0; attempt < 150; attempt += 1) {
    endpoint = stderr.match(/DevTools listening on (ws:\/\/[^\s]+)/u)?.[1];
    if (endpoint !== undefined) break;
    assert(wizard.exitCode === null && wizard.signalCode === null, stderr);
    await delay(100);
  }
  assert(endpoint, `Portable wizard did not expose its debug endpoint: ${stderr}`);
  browser = await chromium.connectOverCDP(endpoint, { timeout: 15_000 });
  const context = browser.contexts()[0];
  assert(context);
  const page = context.pages()[0] ?? (await context.waitForEvent('page'));
  await expect(page).toHaveTitle('Portable setup window');
  await expect(page.locator('html')).toHaveAttribute('lang', 'de');
  await expect(page.locator('#product-name')).toHaveText('Portable workflow check');
  await expect(page.locator('#logo')).toBeVisible();
  await expect.poll(() => page.locator('#logo').evaluate((logo) => logo.naturalWidth)).toBe(24);
  const theme = await page.locator('html').evaluate((element) => {
    const style = element.ownerDocument.defaultView.getComputedStyle(element);
    return ['--rune-accent', '--rune-radius', '--portable-theme-loaded'].map((key) =>
      style.getPropertyValue(key).trim(),
    );
  });
  assert.deepEqual(theme, ['#2563eb', '3px', 'yes']);
  const next = page.locator('#next');
  await next.click();
  await expect(page.locator('.field[data-id="token"]')).toBeVisible();
  await next.click();
  await expect(page.locator('.result-heading')).toHaveText('Summary');
  await next.click();
  await expect(page.locator('.result-heading')).toHaveText('Paket erfolgreich');
  assert(!(await page.locator('body').innerText()).includes(secret));
  const finish = next.click().catch((error) => {
    if (
      !(error instanceof Error) ||
      !error.message.startsWith('locator.click: Target page, context or browser has been closed') ||
      !error.message.includes('performing click action')
    )
      throw error;
  });
  const [exit] = await Promise.all([within(closed, 15_000), finish]);
  assert.deepEqual(exit, { code: 0, signal: null });
  verifyOutcome('wizard', stdout, stderr);
  process.stdout.write(
    'Portable default wizard passed with bundled CSS, logo, title, locale, scripts, and payload.\n',
  );
} finally {
  if (wizard?.pid !== undefined && wizard.exitCode === null && wizard.signalCode === null) {
    if (windows) {
      spawnSync(
        join(process.env.SystemRoot, 'System32/taskkill.exe'),
        ['/PID', String(wizard.pid), '/T', '/F'],
        {
          shell: false,
          windowsHide: true,
          stdio: 'ignore',
          timeout: 10_000,
        },
      );
    } else {
      try {
        process.kill(-wizard.pid, 'SIGKILL');
      } catch {
        /* Already exited. */
      }
    }
  }
  if (closed !== undefined)
    await within(
      closed.catch(() => undefined),
      10_000,
    );
  await browser?.close().catch(() => undefined);
  assert.equal(dirname(directory), temporaryRoot, 'Refuse cleanup outside the temporary directory');
  rmSync(directory, { recursive: true, force: true });
}
