import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { _electron as electron, expect, test, type ElectronApplication } from '@playwright/test';

const packageDirectory = dirname(dirname(fileURLToPath(import.meta.url)));
const launcherPath = join(packageDirectory, 'tests', 'fixtures', 'launch.cjs');
const manifestFixturePath = join(
  packageDirectory,
  'tests',
  'fixtures',
  'empty-strings-manifest.yaml',
);
const overlayFixturePath = join(
  packageDirectory,
  'tests',
  'fixtures',
  'empty-strings-overlay',
  'installer.yaml',
);
const electronExecutable = createRequire(import.meta.url)('electron') as string;

async function expectEmptyStrings(application: ElectronApplication): Promise<void> {
  const page = await application.firstWindow();
  const next = page.locator('#next');

  await expect(page.locator('.welcome p')).toHaveText('');
  await next.click();

  const textField = page.locator('.field[data-id="textValue"]');
  const selectField = page.locator('.field[data-id="selectValue"]');
  const multiselectField = page.locator('.field[data-id="multiselectValue"]');

  await expect(textField.locator('label')).toHaveText('');
  await expect(textField.locator('.description')).toHaveCount(0);
  await expect(selectField.locator('label')).toHaveText('');
  await expect(selectField.locator('.description')).toHaveCount(0);
  await expect(selectField.locator('option[value="select-value"]')).toHaveText('');
  await expect(multiselectField.locator('label')).toHaveText('');
  await expect(multiselectField.locator('.description')).toHaveCount(0);
  await expect(multiselectField.locator('.option-row span')).toHaveText('');

  const textInput = textField.locator('input');
  await textInput.fill('invalid');
  await textInput.dispatchEvent('change');
  await expect(textField).toHaveClass(/invalid/);
  await expect(textField.locator('.error')).toHaveText('');
}

test('renders empty manifest strings without local fallbacks', async () => {
  let application: ElectronApplication | undefined;

  try {
    application = await electron.launch({
      executablePath: electronExecutable,
      args: [launcherPath, manifestFixturePath],
      cwd: packageDirectory,
    });
    await expectEmptyStrings(application);
  } finally {
    await application?.close();
  }
});

test('renders empty localized overlay strings without local fallbacks', async () => {
  let application: ElectronApplication | undefined;

  try {
    application = await electron.launch({
      executablePath: electronExecutable,
      args: [launcherPath, overlayFixturePath, '--locale', 'de'],
      cwd: packageDirectory,
    });
    await expectEmptyStrings(application);
  } finally {
    await application?.close();
  }
});
