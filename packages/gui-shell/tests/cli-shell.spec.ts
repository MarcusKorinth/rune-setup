import { spawn, type ChildProcess } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { chromium, expect, test, type Browser } from '@playwright/test';

const packageDirectory = dirname(dirname(fileURLToPath(import.meta.url)));
const cliMain = join(packageDirectory, '..', 'cli', 'dist', 'main.js');
const shellFixtureDirectory = join(packageDirectory, 'tests', 'fixtures', 'cli-shell');
const linuxLauncher = join(shellFixtureDirectory, 'launch-linux.sh');
const electronExecutable = createRequire(join(packageDirectory, 'package.json'))(
  'electron',
) as string;
const endpoint = 'https://example.test:8443/a:b';

interface GuiResult {
  readonly exitCode: number;
  readonly mode: string;
  readonly status: string;
  readonly dryRun: boolean;
  readonly resultSchemaVersion: number;
  readonly product: { readonly name: string; readonly version: string };
  readonly manifest: {
    readonly path: string;
    readonly sha256: string;
    readonly schemaVersion: number;
  };
  readonly steps: readonly {
    readonly id: string;
    readonly state: string;
    readonly exitCode: number | null;
  }[];
}

interface CliShellRun {
  readonly child: ChildProcess;
  readonly browser: Browser;
  readonly exitCode: Promise<number>;
}

async function stopCli(child: ChildProcess, exitCode: Promise<number>): Promise<void> {
  if (child.exitCode === null) {
    if (process.platform === 'win32' && child.pid !== undefined) {
      const taskkill = spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], {
        shell: false,
        stdio: 'ignore',
        windowsHide: true,
      });
      taskkill.once('error', () => child.kill());
    } else {
      child.kill('SIGTERM');
    }
  }

  const exited = await new Promise<boolean>((resolve) => {
    const timeout = setTimeout(() => resolve(false), 5_000);
    void exitCode.then(
      () => {
        clearTimeout(timeout);
        resolve(true);
      },
      () => {
        clearTimeout(timeout);
        resolve(true);
      },
    );
  });
  if (!exited) {
    throw new Error('the CLI shell smoke process did not terminate during cleanup');
  }
}

async function launchCliShell(
  manifest: 'success.yaml' | 'failure.yaml',
  resultPath: string,
  userData: string,
): Promise<CliShellRun> {
  await mkdir(userData, { recursive: true });
  const args = [
    cliMain,
    'run',
    join(shellFixtureDirectory, manifest),
    '--gui',
    '--result',
    resultPath,
    ...(manifest === 'success.yaml' ? ['--set', `endpoint=${endpoint}`] : []),
  ];
  const environment = {
    ...process.env,
    RUNE_GUI_SHELL: process.platform === 'linux' ? linuxLauncher : shellFixtureDirectory,
    RUNE_TEST_USER_DATA: userData,
  };
  if (process.platform === 'linux') {
    environment.RUNE_TEST_ELECTRON = electronExecutable;
    environment.RUNE_TEST_SHELL = shellFixtureDirectory;
  }
  const child = spawn(process.execPath, args, {
    cwd: packageDirectory,
    env: environment,
    stdio: ['ignore', 'ignore', 'pipe'],
    windowsHide: true,
  });
  let stderr = '';
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk: string) => {
    stderr += chunk;
  });
  const exitCode = new Promise<number>((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (code, signal) => {
      if (signal !== null) {
        reject(new Error(`CLI shell smoke ended from ${signal}`));
        return;
      }
      resolve(code ?? 70);
    });
  });
  void exitCode.catch(() => undefined);

  try {
    let debuggerUrl: string | undefined;
    await expect
      .poll(
        () => {
          debuggerUrl = stderr.match(/DevTools listening on (ws:\/\/[^\s]+)/)?.[1];
          return debuggerUrl;
        },
        { timeout: 20_000 },
      )
      .toBeTruthy();
    if (debuggerUrl === undefined) {
      throw new Error('the CLI shell did not publish a CDP endpoint');
    }
    const browser = await chromium.connectOverCDP(debuggerUrl);
    return { child, browser, exitCode };
  } catch (error) {
    await stopCli(child, exitCode);
    if (stderr.length > 0) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`${message}\nCLI shell stderr:\n${stderr.slice(-4_096)}`, { cause: error });
    }
    throw error;
  }
}

async function finishGuiRun(run: CliShellRun): Promise<void> {
  const context = run.browser.contexts()[0];
  if (context === undefined) {
    throw new Error('the CLI did not expose an Electron browser context');
  }
  const page = context.pages()[0] ?? (await context.waitForEvent('page'));
  const next = page.locator('#next');
  await expect(page.locator('.welcome h2')).toHaveText('Welcome');
  await next.click();
  const endpointField = page.locator('.field[data-id="endpoint"]');
  if ((await endpointField.count()) !== 0) {
    await expect(endpointField).toBeVisible();
    await next.click();
  }
  await expect(page.locator('.result-heading')).toHaveText('Summary');
  await next.click();
  await expect(page.locator('.result-heading')).not.toHaveText('Summary');
  await expect(next).toHaveText('Finish');
  // Finish may destroy its CDP target before Playwright receives the click response.
  // Callers still verify the CLI exit code and delivered result after both settle.
  const finishClick = next.click().catch((error: unknown) => {
    if (
      !(error instanceof Error) ||
      !error.message.startsWith('locator.click: Target page, context or browser has been closed') ||
      !error.message.includes('performing click action')
    ) {
      throw error;
    }
  });
  await Promise.all([run.exitCode, finishClick]);
}

async function readResult(path: string): Promise<GuiResult> {
  return JSON.parse(await readFile(path, 'utf8')) as GuiResult;
}

async function cleanup(run: CliShellRun | undefined, directory: string): Promise<void> {
  if (run !== undefined) {
    await stopCli(run.child, run.exitCode);
  }
  await run?.browser.close().catch(() => undefined);
  await rm(directory, { force: true, recursive: true });
}

test('drives the actual CLI GUI shell to a successful result', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'rune-cli-shell-success-'));
  const resultPath = join(directory, 'result.json');
  let run: CliShellRun | undefined;

  try {
    run = await launchCliShell('success.yaml', resultPath, join(directory, 'user-data'));
    await finishGuiRun(run);
    expect(await run.exitCode).toBe(0);

    const result = await readResult(resultPath);
    expect(result).toMatchObject({
      exitCode: 0,
      mode: 'gui',
      status: 'succeeded',
      dryRun: false,
      resultSchemaVersion: 2,
      product: { name: 'RUNE CLI shell smoke', version: '1.0.0' },
      steps: [{ id: 'cli-shell-success', state: 'SUCCEEDED', exitCode: 0 }],
    });
    expect(result.manifest).toMatchObject({ schemaVersion: 1 });
    expect(result.manifest.path).toContain('success.yaml');
    expect(result.manifest.sha256).toMatch(/^[0-9a-f]{64}$/);
  } finally {
    await cleanup(run, directory);
  }
});

test('forwards a real GUI step failure and writes its result', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'rune-cli-shell-failure-'));
  const resultPath = join(directory, 'result.json');
  let run: CliShellRun | undefined;

  try {
    run = await launchCliShell('failure.yaml', resultPath, join(directory, 'user-data'));
    await finishGuiRun(run);
    expect(await run.exitCode).toBe(1);

    const result = await readResult(resultPath);
    expect(result).toMatchObject({
      exitCode: 1,
      mode: 'gui',
      status: 'failed',
      dryRun: false,
      resultSchemaVersion: 2,
      product: { name: 'RUNE CLI shell failure smoke', version: '1.0.0' },
      steps: [{ id: 'cli-shell-failure', state: 'FAILED', exitCode: 1 }],
    });
    expect(result.manifest).toMatchObject({ schemaVersion: 1 });
    expect(result.manifest.sha256).toMatch(/^[0-9a-f]{64}$/);
  } finally {
    await cleanup(run, directory);
  }
});
