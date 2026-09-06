import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { _electron as electron, expect, test, type ElectronApplication } from '@playwright/test';

const packageDirectory = dirname(dirname(fileURLToPath(import.meta.url)));
const executionFixturePath = join(packageDirectory, 'tests', 'fixtures', 'execution.yaml');
const launcherPath = join(packageDirectory, 'tests', 'fixtures', 'launch.cjs');
const electronExecutable = createRequire(import.meta.url)('electron') as string;

interface SmokeRunResult {
  readonly exitCode: number;
  readonly mode: string;
  readonly status: string;
  readonly steps: readonly { readonly id: string; readonly state: string }[];
}

test('native close on Result preserves the configured result and exit code', async () => {
  const resultDirectory = await mkdtemp(join(tmpdir(), 'rune-windowed-native-close-'));
  const resultPath = join(resultDirectory, 'result.json');
  let application: ElectronApplication | undefined;

  try {
    application = await electron.launch({
      executablePath: electronExecutable,
      args: [launcherPath, executionFixturePath, '--result', resultPath],
      cwd: packageDirectory,
    });
    const page = await application.firstWindow();
    const next = page.locator('#next');

    await next.click();
    await expect(page.locator('.result-heading')).toHaveText('Summary');
    await expect(next).toHaveText('Install');
    await expect(next).toBeEnabled();
    await next.click();
    await expect(page.locator('.result-heading')).toHaveText('Setup completed successfully.');

    const exited = new Promise<number | null>((resolve) => {
      application?.process().once('exit', resolve);
    });
    await application.evaluate(({ BrowserWindow }) => {
      BrowserWindow.getAllWindows()[0]?.close();
    });

    expect(await exited).toBe(0);
    const result = JSON.parse(await readFile(resultPath, 'utf8')) as SmokeRunResult;
    expect(result).toMatchObject({ exitCode: 0, mode: 'gui', status: 'succeeded' });
    expect(result.steps).toMatchObject([{ id: 'execution-smoke', state: 'SUCCEEDED' }]);
    application = undefined;
  } finally {
    if (application !== undefined) {
      await application.close().catch(() => undefined);
    }
    await rm(resultDirectory, { force: true, recursive: true });
  }
});
