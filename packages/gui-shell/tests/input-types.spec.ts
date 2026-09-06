import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { _electron as electron, expect, test, type ElectronApplication } from '@playwright/test';

const packageDirectory = dirname(dirname(fileURLToPath(import.meta.url)));
const fixturePath = join(packageDirectory, 'tests', 'fixtures', 'all-input-types.yaml');
const launcherPath = join(packageDirectory, 'tests', 'fixtures', 'launch.cjs');
const electronExecutable = createRequire(import.meta.url)('electron') as string;

test('submits every enabled input type through the real Electron shell', async () => {
  const releaseName = 'release-42';
  const accessToken = 'secret-token-42';
  const sourceFile = join(packageDirectory, 'tests', 'fixtures', 'execution-step.cjs');
  const targetDirectory = join(packageDirectory, 'tests', 'fixtures');
  let application: ElectronApplication | undefined;

  try {
    application = await electron.launch({
      executablePath: electronExecutable,
      args: [launcherPath, fixturePath],
      cwd: packageDirectory,
    });
    const page = await application.firstWindow();
    const next = page.locator('#next');

    await next.click();

    const release = page.locator('.field[data-id="releaseName"] input');
    const token = page.locator('.field[data-id="accessToken"] input');
    const continueSelect = page.locator('.field[data-id="continue"] select');
    const channel = page.locator('.field[data-id="channel"] select');
    const components = page.locator('.field[data-id="components"]');

    await expect(release).toHaveAccessibleName('Release name');
    await expect(token).toHaveAccessibleName('Access token');
    await expect(continueSelect).toHaveAccessibleName('Continue');
    await expect(channel).toHaveAccessibleName('Channel');
    await expect(components.getByRole('group')).toHaveAccessibleName('Components');
    await expect(components.getByRole('checkbox', { name: 'Core component' })).toBeVisible();
    await expect(components.getByRole('checkbox', { name: 'Extra component' })).toBeVisible();

    for (const [field, control] of [
      [page.locator('.field[data-id="releaseName"]'), release],
      [page.locator('.field[data-id="accessToken"]'), token],
      [page.locator('.field[data-id="continue"]'), continueSelect],
      [page.locator('.field[data-id="channel"]'), channel],
    ] as const) {
      await field.locator('label').first().click();
      await expect(control).toBeFocused();
    }

    await expect(token).toHaveAttribute('type', 'password');
    await expect(channel.locator('option[value="stable-value"]')).toHaveText('Stable channel');
    await expect(components).toContainText('Core component');
    await expect(components).not.toContainText('core-value');

    await release.fill(releaseName);
    await release.dispatchEvent('change');
    await token.fill(accessToken);
    await token.dispatchEvent('change');
    await continueSelect.selectOption('false');
    await channel.selectOption('stable-value');
    await components.getByText('Core component', { exact: true }).click();
    await expect(components.getByRole('checkbox', { name: 'Core component' })).toBeChecked();
    await components.getByText('Extra component', { exact: true }).click();
    await expect(components.getByRole('checkbox', { name: 'Extra component' })).toBeChecked();
    await expect(next).toBeEnabled();
    await next.click();

    const file = page.locator('.field[data-id="sourceFile"] input');
    const directory = page.locator('.field[data-id="targetDirectory"] input');
    await expect(file).toHaveAccessibleName('Source file');
    await expect(directory).toHaveAccessibleName('Target directory');
    await page.locator('.field[data-id="sourceFile"] label').click();
    await expect(file).toBeFocused();
    await page.locator('.field[data-id="targetDirectory"] label').click();
    await expect(directory).toBeFocused();
    await expect(file).toHaveAttribute('type', 'text');
    await expect(directory).toHaveAttribute('type', 'text');
    await file.fill(sourceFile);
    await file.dispatchEvent('change');
    await directory.fill(targetDirectory);
    await directory.dispatchEvent('change');
    await expect(next).toBeEnabled();
    await next.click();

    const summary = page.locator('.summary-step');
    await expect(page.locator('.result-heading')).toHaveText('Summary');
    await expect(summary).toContainText(releaseName);
    await expect(summary).toContainText('false');
    await expect(summary).toContainText('stable-value');
    await expect(summary).toContainText('core-value,extras-value');
    await expect(summary).toContainText(JSON.stringify(sourceFile));
    await expect(summary).toContainText(JSON.stringify(targetDirectory));
    await expect(summary).toContainText('***');
    await expect(summary).not.toContainText(accessToken);

    await next.click();
    await expect(page.locator('.result-heading')).toHaveText('Setup completed successfully.');
  } finally {
    await application?.close();
  }
});
