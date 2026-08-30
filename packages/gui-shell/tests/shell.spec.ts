import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { _electron as electron, expect, test, type ElectronApplication } from '@playwright/test';

const packageDirectory = dirname(dirname(fileURLToPath(import.meta.url)));
const fixturePath = join(packageDirectory, 'tests', 'fixtures', 'smoke.yaml');
const launcherPath = join(packageDirectory, 'tests', 'fixtures', 'launch.cjs');
const electronExecutable = createRequire(import.meta.url)('electron') as string;

test('launches the real Node 22 shell and renders Welcome', async () => {
  let application: ElectronApplication | undefined;
  const pageErrors: string[] = [];

  try {
    application = await electron.launch({
      executablePath: electronExecutable,
      args: [launcherPath, fixturePath],
      cwd: packageDirectory,
    });

    const runtime = await application.evaluate(() => ({
      electron: process.versions['electron'],
      node: process.versions.node,
    }));
    console.log(`[shell-smoke] Electron ${runtime.electron}, embedded Node ${runtime.node}`);
    expect(runtime.node.split('.')[0]).toBe('22');

    const page = await application.firstWindow();
    page.on('pageerror', (error) => pageErrors.push(error.message));

    await expect(page.locator('#product-name')).toHaveText('RUNE Shell Smoke');
    await expect(page.locator('.welcome h2')).toHaveText('Welcome');
    await expect(page.locator('.welcome p')).toHaveText('Real Electron renderer smoke');
    console.log('[shell-smoke] Welcome rendered for RUNE Shell Smoke');
    expect(pageErrors).toEqual([]);
  } finally {
    await application?.close();
  }
});
