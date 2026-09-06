import { spawn } from 'node:child_process';
import { access, mkdtemp, readFile, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  _electron as electron,
  expect,
  test,
  type ElectronApplication,
  type Page,
} from '@playwright/test';

const packageDirectory = dirname(dirname(fileURLToPath(import.meta.url)));
const lifecycleFixturePath = join(packageDirectory, 'tests', 'fixtures', 'lifecycle-flood.yaml');
const lifecycleLauncherPath = join(packageDirectory, 'tests', 'fixtures', 'lifecycle-launch.cjs');
const missingFixturePath = join(packageDirectory, 'tests', 'fixtures', 'missing-lifecycle.yaml');
const electronExecutable = createRequire(import.meta.url)('electron') as string;

interface LifecycleResult {
  readonly exitCode: number;
  readonly mode: string;
  readonly status: string;
  readonly error: { readonly code: string } | null;
  readonly steps: readonly { readonly id: string; readonly state: string }[];
}

async function readLifecycleResult(path: string): Promise<LifecycleResult> {
  return JSON.parse(await readFile(path, 'utf8')) as LifecycleResult;
}

function appExit(application: ElectronApplication): Promise<number> {
  return new Promise((resolve) => {
    application.process().once('exit', (code) => resolve(code ?? 70));
  });
}

async function launchRunningLifecycle(
  resultPath: string,
  dialogCapturePath?: string,
): Promise<{ readonly application: ElectronApplication; readonly page: Page }> {
  const application = await electron.launch({
    executablePath: electronExecutable,
    args: [lifecycleLauncherPath, lifecycleFixturePath, '--result', resultPath],
    cwd: packageDirectory,
    ...(dialogCapturePath === undefined
      ? {}
      : { env: { ...process.env, RUNE_DIALOG_CAPTURE: dialogCapturePath } }),
  });
  const page = await application.firstWindow();
  const next = page.locator('#next');

  await next.click();
  await expect(page.locator('.result-heading')).toHaveText('Summary');
  await expect(next).toBeEnabled();
  await next.click();
  await expect(page.locator('.log')).toContainText('lifecycle-flood-');

  return { application, page };
}

async function expectCancelledTopology(resultPath: string): Promise<void> {
  const result = await readLifecycleResult(resultPath);
  expect(result).toMatchObject({ exitCode: 6, mode: 'gui', status: 'cancelled' });
  expect(result.steps.map(({ id, state }) => ({ id, state }))).toEqual([
    { id: 'output-flood', state: 'CANCELLED' },
    { id: 'after-cancel', state: 'NOT_RUN' },
  ]);
}

test('cancels a real active output flood and preserves cancelled topology', async () => {
  const resultDirectory = await mkdtemp(join(tmpdir(), 'rune-lifecycle-cancel-'));
  const resultPath = join(resultDirectory, 'result.json');
  let application: ElectronApplication | undefined;

  try {
    const running = await launchRunningLifecycle(resultPath);
    application = running.application;
    const exited = appExit(application);

    await running.page.locator('#cancel').click();
    expect(await exited).toBe(6);
    await expectCancelledTopology(resultPath);
    application = undefined;
  } finally {
    await application?.close().catch(() => undefined);
    await rm(resultDirectory, { force: true, recursive: true });
  }
});

test('treats a native close during active execution as cancellation', async () => {
  const resultDirectory = await mkdtemp(join(tmpdir(), 'rune-lifecycle-close-'));
  const resultPath = join(resultDirectory, 'result.json');
  let application: ElectronApplication | undefined;

  try {
    const running = await launchRunningLifecycle(resultPath);
    application = running.application;
    const exited = appExit(application);

    await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.close());
    expect(await exited).toBe(6);
    await expectCancelledTopology(resultPath);
    application = undefined;
  } finally {
    await application?.close().catch(() => undefined);
    await rm(resultDirectory, { force: true, recursive: true });
  }
});

test('reports an actual startup RuneError with its exit code and configured result', async () => {
  const resultDirectory = await mkdtemp(join(tmpdir(), 'rune-lifecycle-open-error-'));
  const resultPath = join(resultDirectory, 'result.json');
  const dialogCapturePath = join(resultDirectory, 'fatal-dialog.json');
  let child: ReturnType<typeof spawn> | undefined;
  let childClosed = false;

  try {
    const spawned = spawn(
      electronExecutable,
      ['--no-sandbox', lifecycleLauncherPath, missingFixturePath, '--result', resultPath],
      {
        cwd: packageDirectory,
        env: { ...process.env, RUNE_DIALOG_CAPTURE: dialogCapturePath },
        stdio: 'ignore',
        windowsHide: true,
      },
    );
    child = spawned;
    const exitCode = await new Promise<number>((resolve, reject) => {
      spawned.once('error', reject);
      spawned.once('close', (code, signal) => {
        childClosed = true;
        if (signal !== null) {
          reject(new Error(`Electron lifecycle smoke ended from ${signal}`));
          return;
        }
        resolve(code ?? 70);
      });
    });

    expect(exitCode).toBe(3);
    const dialog = JSON.parse(await readFile(dialogCapturePath, 'utf8')) as { content: string };
    expect(dialog.content).toContain('RUNE-101 (exit 3)');
    expect(await readLifecycleResult(resultPath)).toMatchObject({
      exitCode: 3,
      mode: 'gui',
      status: 'config_error',
      error: { code: 'RUNE-101' },
    });
  } finally {
    if (child !== undefined && !childClosed) {
      child.kill();
      await new Promise<void>((resolve) => child?.once('close', () => resolve()));
    }
    await rm(resultDirectory, { force: true, recursive: true });
  }
});

test('maps a hard renderer crash during execution to exit 70 without a result', async () => {
  const resultDirectory = await mkdtemp(join(tmpdir(), 'rune-lifecycle-renderer-crash-'));
  const resultPath = join(resultDirectory, 'result.json');
  const dialogCapturePath = join(resultDirectory, 'fatal-dialog.json');
  let application: ElectronApplication | undefined;

  try {
    const running = await launchRunningLifecycle(resultPath, dialogCapturePath);
    application = running.application;
    const exited = appExit(application);

    await application.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0]?.webContents.forcefullyCrashRenderer(),
    );
    expect(await exited).toBe(70);
    await expect(access(resultPath)).rejects.toMatchObject({ code: 'ENOENT' });
    const dialog = JSON.parse(await readFile(dialogCapturePath, 'utf8')) as { content: string };
    expect(dialog.content).toContain('RUNE-500 (exit 70)');
    application = undefined;
  } finally {
    await application?.close().catch(() => undefined);
    await rm(resultDirectory, { force: true, recursive: true });
  }
});
