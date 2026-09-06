import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { _electron as electron, expect, test, type ElectronApplication } from '@playwright/test';

const packageDirectory = dirname(dirname(fileURLToPath(import.meta.url)));
const fixturePath = join(packageDirectory, 'tests', 'fixtures', 'accessibility.yaml');
const launcherPath = join(packageDirectory, 'tests', 'fixtures', 'launch.cjs');
const rendererLauncherPath = join(packageDirectory, 'tests', 'fixtures', 'renderer-launch.cjs');
const electronExecutable = createRequire(import.meta.url)('electron') as string;

test('relates field descriptions and engine validation errors to their control', async () => {
  let application: ElectronApplication | undefined;

  try {
    application = await electron.launch({
      executablePath: electronExecutable,
      args: [launcherPath, fixturePath],
      cwd: packageDirectory,
    });
    const page = await application.firstWindow();

    await expect(page.getByRole('heading', { name: 'Welcome', exact: true })).toBeFocused();
    await page.locator('#next').focus();
    await page.keyboard.press('Enter');
    await expect(page.locator('#page')).toBeFocused();
    const field = page.locator('.field[data-id="accessCode"]');
    const control = field.getByLabel('Access code');
    const description = field.locator('.description');
    const error = field.locator('.error');
    const descriptionId = await description.getAttribute('id');
    const errorId = await error.getAttribute('id');

    expect(descriptionId).not.toBeNull();
    expect(errorId).not.toBeNull();
    await expect(control).toHaveAccessibleName('Access code');
    await expect(control).toHaveAttribute('aria-invalid', 'true');
    await expect(error).toContainText('Use uppercase letters');
    await expect(control).toHaveAttribute('aria-describedby', `${descriptionId} ${errorId}`);

    await control.fill('VALID');
    await control.dispatchEvent('change');
    await expect(field).not.toHaveClass(/invalid/);
    await expect(error).toHaveCount(0);
    await expect(control).not.toHaveAttribute('aria-invalid');
    await expect(control).toHaveAttribute('aria-describedby', descriptionId ?? '');
    await expect(control).toBeFocused();

    await page.locator('#next').click();
    await expect(page.locator('.field[data-id="fifth"]')).toBeVisible();
    await expect(page.locator('#page')).toBeFocused();
    await page.locator('#back').click();
    await expect(field).toBeVisible();
    await expect(page.locator('#page')).toBeFocused();
    await page.locator('#next').click();
    await page.locator('#next').click();
    await expect(page.getByRole('heading', { name: 'Summary', exact: true })).toBeFocused();
  } finally {
    await application?.close();
  }
});

test('labels progress updates and moves focus to the result', async () => {
  let application: ElectronApplication | undefined;

  try {
    application = await electron.launch({
      executablePath: electronExecutable,
      args: [rendererLauncherPath],
      cwd: packageDirectory,
    });
    const page = await application.firstWindow();
    const next = page.locator('#next');

    await next.click();
    await expect
      .poll(() =>
        page.evaluate(() =>
          (
            window as unknown as {
              summaryTestControl: { planCount(): number };
            }
          ).summaryTestControl.planCount(),
        ),
      )
      .toBe(1);
    await page.evaluate(() =>
      (
        window as unknown as {
          summaryTestControl: { resolvePlan(index: number, title: string): void };
        }
      ).summaryTestControl.resolvePlan(0, 'ready plan'),
    );
    await expect(next).toBeEnabled();
    await expect(page.getByRole('heading', { name: 'Summary', exact: true })).toBeFocused();

    await next.click();
    const progress = page.getByRole('progressbar');
    await expect(page.getByRole('heading', { name: 'Installing', exact: true })).toBeFocused();
    await expect(progress).toHaveAccessibleName('Installing');
    await expect(page.locator('.progress-title')).toHaveAttribute('role', 'status');
    await page.evaluate(() =>
      (
        window as unknown as {
          summaryTestControl: {
            resolveWarnings(
              index: number,
              warnings: readonly { readonly message: string; readonly displayText: string }[],
            ): void;
          };
        }
      ).summaryTestControl.resolveWarnings(0, []),
    );
    await expect(
      page.getByRole('heading', { name: 'Setup completed successfully.' }),
    ).toBeFocused();
  } finally {
    await application?.close();
  }
});
