import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { _electron as electron, expect, test, type ElectronApplication } from '@playwright/test';

const packageDirectory = dirname(dirname(fileURLToPath(import.meta.url)));
const fixturePath = join(packageDirectory, 'tests', 'fixtures', 'smoke.yaml');
const launcherPath = join(packageDirectory, 'tests', 'fixtures', 'launch.cjs');
const rendererLauncherPath = join(packageDirectory, 'tests', 'fixtures', 'renderer-launch.cjs');
const electronExecutable = createRequire(import.meta.url)('electron') as string;

interface SummaryTestControl {
  planCount(): number;
  resolvePlan(index: number, title: string): void;
}

test('launches the real Node 22 shell and renders Welcome', async () => {
  let application: ElectronApplication | undefined;
  const pageErrors: string[] = [];
  const consoleErrors: string[] = [];

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
    page.on('console', (message) => {
      if (message.type() === 'error') {
        consoleErrors.push(message.text());
      }
    });

    await expect(page.locator('#product-name')).toHaveText('RUNE Shell Smoke');
    await expect(page.locator('.welcome h2')).toHaveText('Welcome');
    await expect(page.locator('.welcome p')).toHaveText('Real Electron renderer smoke');
    await expect(page.locator('#logo')).toBeVisible();
    await expect.poll(() => page.locator('#logo').evaluate((logo) => logo.naturalWidth)).toBe(2);
    await expect
      .poll(() =>
        page.evaluate(() =>
          getComputedStyle(document.documentElement).getPropertyValue('--rune-accent').trim(),
        ),
      )
      .toBe('#d946ef');
    await expect
      .poll(() =>
        page.evaluate(() =>
          getComputedStyle(document.documentElement)
            .getPropertyValue('--rune-smoke-theme-loaded')
            .trim(),
        ),
      )
      .toBe('yes');
    console.log('[shell-smoke] Welcome rendered for RUNE Shell Smoke');
    expect(pageErrors).toEqual([]);
    expect(consoleErrors).toEqual([]);
  } finally {
    await application?.close();
  }
});

test('keeps Install disabled for the current summary plan only', async () => {
  let application: ElectronApplication | undefined;

  try {
    application = await electron.launch({
      executablePath: electronExecutable,
      args: [rendererLauncherPath],
      cwd: packageDirectory,
    });
    const page = await application.firstWindow();
    const install = page.locator('#next');

    await install.click();
    await expect(page.locator('.result-heading')).toHaveText('Summary');
    await expect(install).toBeDisabled();
    await expect
      .poll(() =>
        page.evaluate(() =>
          (
            window as unknown as { summaryTestControl: SummaryTestControl }
          ).summaryTestControl.planCount(),
        ),
      )
      .toBe(1);

    await page.locator('#back').click();
    await expect(page.locator('.welcome h2')).toHaveText('Welcome');
    await install.click();
    await expect
      .poll(() =>
        page.evaluate(() =>
          (
            window as unknown as { summaryTestControl: SummaryTestControl }
          ).summaryTestControl.planCount(),
        ),
      )
      .toBe(2);
    await expect(install).toBeDisabled();

    await page.evaluate(() =>
      (
        window as unknown as { summaryTestControl: SummaryTestControl }
      ).summaryTestControl.resolvePlan(0, 'stale plan'),
    );
    await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(resolve)));
    await expect(page.locator('.summary-step')).toHaveCount(0);
    await expect(install).toBeDisabled();

    await page.evaluate(() =>
      (
        window as unknown as { summaryTestControl: SummaryTestControl }
      ).summaryTestControl.resolvePlan(1, 'current plan'),
    );
    await expect(page.locator('.summary-step')).toHaveText('current planecho current plan');
    await expect(install).toBeEnabled();
  } finally {
    await application?.close();
  }
});
