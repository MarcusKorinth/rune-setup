import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { _electron as electron, expect, test, type ElectronApplication } from '@playwright/test';

const packageDirectory = dirname(dirname(fileURLToPath(import.meta.url)));
const fixturePath = join(packageDirectory, 'tests', 'fixtures', 'accessibility.yaml');
const launcherPath = join(packageDirectory, 'tests', 'fixtures', 'launch.cjs');
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

    await page.locator('#next').click();
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
  } finally {
    await application?.close();
  }
});
