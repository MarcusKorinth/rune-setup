import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  _electron as electron,
  expect,
  test,
  type ElectronApplication,
  type Page,
} from '@playwright/test';

const packageDirectory = dirname(dirname(fileURLToPath(import.meta.url)));
const fixturePath = join(packageDirectory, 'tests', 'fixtures', 'masked-views.yaml');
const launcherPath = join(packageDirectory, 'tests', 'fixtures', 'launch.cjs');
const electronExecutable = createRequire(import.meta.url)('electron') as string;
const relativeSecret = 'private/../secret-target';
const derivedSecret = resolve(dirname(fixturePath), relativeSecret);

async function answerMaskingInputs(page: Page): Promise<void> {
  const displaySecret = page.locator('.field[data-id="displaySecret"] input');
  await displaySecret.fill('display-only');
  await displaySecret.dispatchEvent('change');
  await expect(displaySecret).toHaveValue('');

  const workingDirectory = page.locator('.field[data-id="workingDirectory"] input');
  await workingDirectory.fill(relativeSecret);
  await workingDirectory.dispatchEvent('change');
  await expect(workingDirectory).toHaveValue('');

  const publicPath = page.locator('.field[data-id="publicPath"] input');
  await publicPath.fill(derivedSecret);
  await publicPath.dispatchEvent('change');
  await expect(publicPath).toHaveValue(derivedSecret);
}

test('refreshes masked display strings after an accepted secret answer', async () => {
  let application: ElectronApplication | undefined;

  try {
    application = await electron.launch({
      executablePath: electronExecutable,
      args: [launcherPath, fixturePath],
      cwd: packageDirectory,
    });
    const page = await application.firstWindow();
    await page.locator('#next').click();

    const field = page.locator('.field[data-id="displaySecret"]');
    await expect(field.locator('label')).toHaveText('Secret details');
    await field.locator('input').fill('Secret details');
    await field.locator('input').dispatchEvent('change');

    await expect(field.locator('label')).toHaveText('***');
    await expect.poll(() => page.title()).toBe('***');
  } finally {
    await application?.close();
  }
});

test('refreshes plan-masked inputs before Back can render them', async () => {
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
    await answerMaskingInputs(page);
    await expect(next).toBeEnabled();
    await next.click();

    await expect(page.locator('.result-heading')).toHaveText('Summary');
    await expect(next).toHaveText('Install');
    await expect(next).toBeEnabled();
    await page.locator('#back').click();

    await expect(page.locator('.field[data-id="publicPath"] input')).toHaveValue('***');
  } finally {
    await application?.close();
  }
});

test('refreshes masked inputs when Back overtakes a pending plan response', async () => {
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
    await answerMaskingInputs(page);
    await expect(next).toBeEnabled();

    await page.evaluate(() => {
      const nextButton = document.querySelector('#next');
      const backButton = document.querySelector('#back');
      if (
        !(nextButton instanceof HTMLButtonElement) ||
        !(backButton instanceof HTMLButtonElement)
      ) {
        throw new Error('wizard navigation controls did not render');
      }
      nextButton.click();
      backButton.click();
    });

    await expect(page.locator('.field[data-id="publicPath"] input')).toHaveValue('***');
  } finally {
    await application?.close();
  }
});
