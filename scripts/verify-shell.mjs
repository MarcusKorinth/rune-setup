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
const platform = process.platform === 'win32' ? 'windows' : 'linux';
assert(
  ['win32', 'linux'].includes(process.platform),
  'Shell verification supports Windows and Linux',
);
const archive = resolve(
  process.argv[2] ??
    join(
      root,
      'output/shell',
      `${platform}-${process.arch}`,
      `rune-gui-shell-${platform}.${platform === 'windows' ? 'zip' : 'tar.gz'}`,
    ),
);
assert(existsSync(archive), `Build the shell archive before verification: ${archive}`);
const temporaryRoot = resolve(tmpdir());
const directory = mkdtempSync(join(temporaryRoot, 'rune shell artifact '));
const unpacked = join(directory, 'fresh extracted shell');
const workflow = join(directory, 'workflow with spaces');
const emptyPath = join(directory, 'path without node');
for (const path of [unpacked, workflow, emptyPath]) mkdirSync(path);
const executable = join(
  unpacked,
  process.platform === 'win32' ? 'rune-gui-shell.exe' : 'rune-gui-shell',
);
const version = JSON.parse(
  readFileSync(join(root, 'packages/engine/package.json'), 'utf8'),
).version;
const secret = 'artifact-check-private-value';
const environment = { ...process.env, RUNE_LOCALE: 'C', RUNE_INPUT_TOKEN: secret };
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
if (process.platform === 'linux') {
  delete headlessEnvironment.DISPLAY;
  delete headlessEnvironment.WAYLAND_DISPLAY;
}

function invoke(command, args, env = process.env, expectedExit = 0) {
  const result = spawnSync(command, args, {
    cwd: workflow,
    env,
    shell: false,
    windowsHide: true,
    encoding: 'utf8',
    timeout: 30_000,
  });
  assert.ifError(result.error);
  assert.equal(
    result.status,
    expectedExit,
    `${command} exited ${result.status}\n${result.stderr}${result.stdout}`,
  );
  return result;
}

function verifyResult(mode) {
  const resultText = readFileSync(join(workflow, `${mode}.json`), 'utf8');
  const logText = readFileSync(join(workflow, `${mode}.log`), 'utf8');
  const result = JSON.parse(resultText);
  assert.equal(result.status, 'succeeded');
  assert.equal(result.exitCode, 0);
  assert.equal(result.mode, mode === 'headless' ? 'non-interactive' : 'gui');
  assert.equal(result.runeVersion, version);
  assert.equal(result.stepsSucceeded, 1);
  assert.equal(result.inputs[0].value, null);
  assert(!resultText.includes(secret));
  assert(!logText.includes(secret));
  assert(logText.includes('packaged-output:***'));
  assert.equal(readFileSync(join(workflow, 'executed.txt'), 'utf8'), 'invoked');
}

function invocation(mode) {
  return [
    '--',
    join(workflow, 'installer.yaml'),
    ...(mode === 'headless' ? ['--non-interactive'] : []),
    '--result',
    join(workflow, `${mode}.json`),
    '--log-file',
    join(workflow, `${mode}.log`),
  ];
}

function launch(args, env = environment) {
  const child = spawn(executable, args, {
    cwd: workflow,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: process.platform === 'linux',
    shell: false,
    windowsHide: true,
  });
  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8').on('data', (text) => {
    stdout += text;
  });
  child.stderr.setEncoding('utf8').on('data', (text) => {
    stderr += text;
  });
  const closed = new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (code, signal) => resolve({ code, signal }));
  });
  void closed.catch(() => undefined);
  return { child, closed, stdout: () => stdout, stderr: () => stderr };
}

function launchWizard(args = invocation('wizard')) {
  return launch(['--remote-debugging-port=0', ...args]);
}

function within(promise, milliseconds, message) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), milliseconds);
    void promise.then(
      (result) => {
        clearTimeout(timer);
        resolve(result);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

async function debuggerEndpoint(run) {
  for (let attempt = 0; attempt < 150; attempt += 1) {
    const endpoint = run.stderr().match(/DevTools listening on (ws:\/\/[^\s]+)/)?.[1];
    if (endpoint !== undefined) return endpoint;
    if (run.child.exitCode !== null || run.child.signalCode !== null) {
      throw new Error(
        `The packaged wizard exited before exposing its debug endpoint: ${run.stderr()}`,
      );
    }
    await delay(100);
  }
  throw new Error(`The packaged wizard did not expose its debug endpoint: ${run.stderr()}`);
}

async function stop(run) {
  if (run.child.exitCode === null && run.child.signalCode === null && run.child.pid !== undefined) {
    if (process.platform === 'win32') {
      const taskkill = join(process.env.SystemRoot, 'System32/taskkill.exe');
      spawnSync(taskkill, ['/PID', String(run.child.pid), '/T', '/F'], {
        shell: false,
        windowsHide: true,
        stdio: 'ignore',
        timeout: 10_000,
      });
    } else {
      try {
        process.kill(-run.child.pid, 'SIGKILL');
      } catch {
        /* Already exited. */
      }
    }
  }
  await within(
    run.closed.catch(() => undefined),
    10_000,
    'The packaged wizard did not close during cleanup',
  );
}

function failureWorkflow(
  name,
  command,
  scriptPrefix,
  { invalidInput = false, slow = false, fail = false } = {},
) {
  const folder = join(workflow, name);
  mkdirSync(folder);
  const marker = join(folder, 'started.txt');
  const script = join(folder, process.platform === 'win32' ? 'check.ps1' : 'check.sh');
  writeFileSync(
    script,
    process.platform === 'win32'
      ? [
          'param([string]$Marker)',
          '[System.IO.File]::WriteAllText($Marker, [string]$PID)',
          '[Console]::WriteLine("packaged-output:" + $env:RUNE_PACKAGE_TOKEN)',
          ...(slow ? ['Start-Sleep -Seconds 30'] : []),
          ...(fail ? ['exit 7'] : []),
        ].join('\n')
      : [
          'printf %s "$$" > "$1"',
          'printf "packaged-output:%s\\n" "$RUNE_PACKAGE_TOKEN"',
          ...(slow ? ['exec /bin/sleep 30'] : []),
          ...(fail ? ['exit 7'] : []),
        ].join('\n'),
  );
  const manifest = join(folder, 'installer.yaml');
  writeFileSync(
    manifest,
    [
      'schemaVersion: 1',
      'product: { name: Packaged failure check, version: 1.0.0 }',
      'inputs:',
      '  token: { type: secret }',
      ...(invalidInput ? ['  choice: { type: select, options: [allowed] }'] : []),
      'steps:',
      '  - id: verify',
      '    title: Verify failure handling',
      '    run:',
      `      command: ${JSON.stringify(command)}`,
      `      args: ${JSON.stringify([...scriptPrefix, script, marker])}`,
      '      env: { RUNE_PACKAGE_TOKEN: "${token}" }',
      ...(name === 'timeout' ? ['      timeoutSeconds: 2'] : []),
      '',
    ].join('\n'),
  );
  const result = join(folder, 'result.json');
  const log = join(folder, 'run.log');
  return {
    folder,
    marker,
    result,
    log,
    args: ['--', manifest, '--non-interactive', '--result', result, '--log-file', log],
  };
}

function checkedFailureResult(path, status, exitCode, mode = 'non-interactive') {
  const text = readFileSync(path, 'utf8');
  assert(!text.includes(secret), 'Failure results must mask the declared secret');
  const result = JSON.parse(text);
  assert.equal(result.status, status);
  assert.equal(result.exitCode, exitCode);
  assert.equal(result.mode, mode);
  assert.equal(result.runeVersion, version);
  if (status === 'input_error') assert.deepEqual(result.inputs, []);
  else assert.equal(result.inputs.find((input) => input.id === 'token').value, null);
  return result;
}

function checkFailureOutput(run) {
  assert.equal(run.stdout.trim(), '', 'Failures must not print human diagnostics to stdout');
  assert(!run.stderr.includes(secret), 'Failure diagnostics must mask the declared secret');
}

function checkFailureLog(path, diagnostic) {
  const log = readFileSync(path, 'utf8');
  assert(!log.includes(secret), 'Failure logs must mask the declared secret');
  assert(log.includes('packaged-output:***'));
  if (diagnostic !== undefined) assert(log.includes(diagnostic));
}

function checkChildStopped(marker) {
  const pid = Number(readFileSync(marker, 'utf8'));
  assert(Number.isSafeInteger(pid) && pid > 1, 'The real child must report its PID');
  assert.throws(
    () => process.kill(pid, 0),
    { code: 'ESRCH' },
    'The child must be gone after settlement',
  );
}

function verifyFailures(command, scriptPrefix) {
  const invalid = failureWorkflow('invalid-input', command, scriptPrefix, { invalidInput: true });
  const invalidRun = invoke(
    executable,
    invalid.args,
    { ...headlessEnvironment, RUNE_INPUT_CHOICE: secret },
    4,
  );
  checkFailureOutput(invalidRun);
  const invalidResult = checkedFailureResult(invalid.result, 'input_error', 4);
  assert.equal(invalidResult.error.code, 'RUNE-202');
  assert.equal(invalidResult.stepsExecuted, 0);
  assert(!existsSync(invalid.marker), 'Invalid input must not start the child');

  for (const name of ['failed-step', 'timeout']) {
    const scenario = failureWorkflow(name, command, scriptPrefix, {
      fail: name === 'failed-step',
      slow: name === 'timeout',
    });
    const run = invoke(executable, scenario.args, headlessEnvironment, 1);
    checkFailureOutput(run);
    const result = checkedFailureResult(scenario.result, 'failed', 1);
    assert.equal(result.stepsFailed, 1);
    assert.equal(result.steps[0].state, 'FAILED');
    assert.equal(result.steps[0].exitCode, name === 'failed-step' ? 7 : null);
    assert(existsSync(scenario.marker), 'Failure must come from a real started process');
    checkChildStopped(scenario.marker);
    const diagnostic = name === 'failed-step' ? 'RUNE-401' : 'RUNE-402';
    assert(result.steps[0].outputTail.some((line) => line.line.includes(diagnostic)));
    checkFailureLog(scenario.log, diagnostic);
  }

  for (const sink of ['result', 'log']) {
    const scenario = failureWorkflow(`${sink}-failure`, command, scriptPrefix);
    // A regular file as parent fails reliably on both OS, including privileged CI users.
    const blocker = join(scenario.folder, secret);
    writeFileSync(blocker, 'keep this file');
    const destination = join(blocker, 'blocked-file');
    const args = [...scenario.args];
    args[args.indexOf(sink === 'result' ? '--result' : '--log-file') + 1] = destination;
    const run = invoke(executable, args, headlessEnvironment, 1);
    checkFailureOutput(run);
    assert(run.stderr.includes(sink === 'result' ? 'result file' : 'log file'), run.stderr);
    assert.equal(readFileSync(blocker, 'utf8'), 'keep this file');
    assert(!existsSync(destination));
    if (sink === 'log') {
      const result = checkedFailureResult(scenario.result, 'failed', 1);
      assert.equal(result.error.code, 'RUNE-406');
      assert.equal(result.stepsExecuted, 0);
      assert(!existsSync(scenario.marker), 'A failed log open must not start the child');
    } else {
      assert(existsSync(scenario.marker));
      checkFailureLog(scenario.log);
      assert(!existsSync(scenario.result));
    }
  }
  process.stdout.write(
    'Packaged invalid-input, failed-step, timeout, result-target and log-target checks passed with masked failures.\n',
  );
}

async function waitForChild(run, marker) {
  for (let attempt = 0; attempt < 150; attempt += 1) {
    if (existsSync(marker) && run.stderr().includes('packaged-output:***')) return;
    if (run.child.exitCode !== null || run.child.signalCode !== null) {
      throw new Error(`The cancellation child exited before readiness: ${run.stderr()}`);
    }
    await delay(100);
  }
  throw new Error(`The cancellation child did not start: ${run.stderr()}`);
}

async function verifyCancellation(command, scriptPrefix, gui) {
  const scenario = failureWorkflow(
    gui ? 'wizard-cancel' : 'headless-cancel',
    command,
    scriptPrefix,
    { slow: true },
  );
  const run = gui
    ? launchWizard(scenario.args.filter((argument) => argument !== '--non-interactive'))
    : launch(scenario.args, headlessEnvironment);
  let connection;
  try {
    let page;
    if (gui) {
      connection = await chromium.connectOverCDP(await debuggerEndpoint(run), { timeout: 15_000 });
      const context = connection.contexts()[0];
      page = context.pages()[0] ?? (await context.waitForEvent('page'));
      await expect(page.locator('.welcome h2')).toHaveText('Welcome');
      await page.locator('#next').click();
      await expect(page.locator('.field[data-id="token"]')).toBeVisible();
      await page.locator('#next').click();
      await expect(page.locator('.result-heading')).toHaveText('Summary');
      await page.locator('#next').click();
    }
    await waitForChild(run, scenario.marker);
    if (gui) await page.locator('#cancel').click();
    else assert(run.child.kill('SIGTERM'));
    const closed = await within(run.closed, 15_000, 'Cancellation did not complete');
    checkFailureOutput({ stdout: run.stdout(), stderr: run.stderr() });
    assert.deepEqual(
      closed,
      { code: 6, signal: null },
      `${run.stderr()}\n${existsSync(scenario.result) ? readFileSync(scenario.result, 'utf8') : 'No cancellation result was written.'}`,
    );
    const result = checkedFailureResult(
      scenario.result,
      'cancelled',
      6,
      gui ? 'gui' : 'non-interactive',
    );
    assert.equal(result.error.code, 'RUNE-601');
    assert.equal(result.stepsCancelled, 1);
    assert.equal(result.steps[0].state, 'CANCELLED');
    checkFailureLog(scenario.log);
    checkChildStopped(scenario.marker);
    process.stdout.write(
      `Packaged ${gui ? 'wizard Cancel' : 'headless SIGTERM'} stopped a running OS child and delivered the masked cancellation result.\n`,
    );
  } finally {
    await stop(run);
    await connection?.close().catch(() => undefined);
  }
}

let wizard;
let browser;
try {
  invoke('tar', ['-xf', archive, '-C', unpacked]);
  assert(existsSync(executable), 'The archive must contain its executable at the root');
  assert(
    existsSync(join(unpacked, 'resources/app.asar')),
    'The artifact must contain its real app.asar',
  );
  const probe = invoke(executable, ['--rune-version-probe'], headlessEnvironment);
  assert.deepEqual(JSON.parse(probe.stdout), { protocolVersion: 1, runeVersion: version });
  process.stdout.write('Packaged version probe passed from an extracted path with spaces.\n');

  const emptyManifest = join(workflow, 'empty.yaml');
  writeFileSync(
    emptyManifest,
    'schemaVersion: 1\nproduct: { name: Runtime control, version: 1.0.0 }\ninputs: {}\nsteps: []\n',
  );
  const control = invoke(
    executable,
    ['--', emptyManifest, '--non-interactive'],
    headlessEnvironment,
  );
  assert.equal(control.stdout.trim(), '', 'An empty workflow must not print diagnostics to stdout');
  if (control.stdout !== '') {
    process.stdout.write(
      `Native empty-workflow stdout contains only whitespace: ${JSON.stringify(control.stdout)}.\n`,
    );
  }

  const windows = process.platform === 'win32';
  const script = join(workflow, windows ? 'check.ps1' : 'check.sh');
  writeFileSync(
    script,
    windows
      ? [
          'param([string]$Marker)',
          '[System.IO.File]::WriteAllText($Marker, "invoked")',
          '[Console]::WriteLine("packaged-output:" + $env:RUNE_PACKAGE_TOKEN)',
        ].join('\n')
      : ['printf %s invoked > "$1"', 'printf "packaged-output:%s\\n" "$RUNE_PACKAGE_TOKEN"'].join(
          '\n',
        ),
  );
  const command = windows
    ? join(process.env.SystemRoot, 'System32/WindowsPowerShell/v1.0/powershell.exe')
    : '/bin/sh';
  const scriptPrefix = windows
    ? ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File']
    : [];
  const args = [...scriptPrefix, script, join(workflow, 'executed.txt')];
  writeFileSync(
    join(workflow, 'installer.yaml'),
    [
      'schemaVersion: 1',
      'product: { name: Packaged artifact check, version: 1.0.0 }',
      'inputs: { token: { type: secret } }',
      'steps:',
      '  - id: verify',
      '    title: Verify bundled engine',
      '    run:',
      `      command: ${JSON.stringify(command)}`,
      `      args: ${JSON.stringify(args)}`,
      '      env: { RUNE_PACKAGE_TOKEN: "${token}" }',
      '',
    ].join('\n'),
  );
  const headless = invoke(executable, invocation('headless'), headlessEnvironment);
  assert.equal(
    headless.stdout,
    control.stdout,
    'The workflow must add no stdout beyond native runtime whitespace',
  );
  assert(!headless.stderr.includes(secret));
  verifyResult('headless');
  process.stdout.write(
    `Packaged headless execution passed without Node on PATH${process.platform === 'linux' ? ' or DISPLAY/WAYLAND_DISPLAY' : ''}: process, result, logs, masking.\n`,
  );
  const streamed = invoke(
    executable,
    ['--', join(workflow, 'installer.yaml'), '--non-interactive', '--result', '-'],
    headlessEnvironment,
  );
  const streamedResult = JSON.parse(streamed.stdout);
  assert.equal(streamedResult.status, 'succeeded');
  assert.equal(streamedResult.exitCode, 0);
  assert.equal(streamedResult.runeVersion, version);
  assert.equal(streamedResult.inputs[0].value, null);
  assert(!streamed.stdout.includes(secret));
  process.stdout.write(
    'Packaged --result - returned valid masked JSON without human diagnostics.\n',
  );
  rmSync(join(workflow, 'executed.txt'));

  wizard = launchWizard();
  browser = await chromium.connectOverCDP(await debuggerEndpoint(wizard), { timeout: 15_000 });
  const context = browser.contexts()[0];
  assert(context, 'The packaged wizard must expose a browser context');
  const page = context.pages()[0] ?? (await context.waitForEvent('page'));
  await expect(page.locator('.welcome h2')).toHaveText('Welcome');
  assert(page.url().includes('/resources/app.asar/src/renderer/index.html'));
  const runtime = await page.locator('body').evaluate(async (body) => {
    const view = body.ownerDocument.defaultView;
    return {
      accent: view
        .getComputedStyle(body.ownerDocument.documentElement)
        .getPropertyValue('--rune-accent')
        .trim(),
      font: view.getComputedStyle(body).fontFamily,
      isolated: typeof view.require === 'undefined',
      open: await view.rune.open(),
    };
  });
  assert.equal(runtime.accent, '#4f6df5');
  assert(runtime.font.includes('system-ui'));
  assert.equal(runtime.isolated, true);
  assert.equal(runtime.open.runeVersion, version);
  const next = page.locator('#next');
  await next.click();
  await expect(page.locator('.field[data-id="token"]')).toBeVisible();
  await next.click();
  await expect(page.locator('.result-heading')).toHaveText('Summary');
  assert(!(await page.locator('body').innerText()).includes(secret));
  await next.click();
  await expect(next).toHaveText('Finish');
  assert(!(await page.locator('body').innerText()).includes(secret));
  await next.click();
  assert.deepEqual(await within(wizard.closed, 15_000, 'The packaged wizard did not finish'), {
    code: 0,
    signal: null,
  });
  assert.equal(wizard.stdout().trim(), '');
  assert(!wizard.stderr().includes(secret));
  verifyResult('wizard');
  process.stdout.write(
    'Packaged wizard passed through Welcome, inputs, Summary, execution, and Result with bundled CSS/preload/engine.\n',
  );
  await browser.close();
  browser = undefined;
  verifyFailures(command, scriptPrefix);
  await verifyCancellation(command, scriptPrefix, true);
  if (process.platform === 'linux') await verifyCancellation(command, scriptPrefix, false);
} finally {
  if (wizard !== undefined) await stop(wizard);
  await browser?.close().catch(() => undefined);
  assert.equal(dirname(directory), temporaryRoot, 'Refuse cleanup outside the temporary directory');
  rmSync(directory, { recursive: true, force: true });
}
