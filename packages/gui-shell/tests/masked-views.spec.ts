import { mkdtempSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
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

function derivedProductFixture(): { manifestPath: string; productName: string } {
  const dir = mkdtempSync(join(tmpdir(), 'rune-gui-derived-product-'));
  const manifestPath = join(dir, 'installer.yaml');
  const productName = resolve(dir, relativeSecret);
  writeFileSync(
    manifestPath,
    [
      'schemaVersion: 1',
      'product:',
      `  name: ${JSON.stringify(productName)}`,
      '  version: "1.0.0"',
      'inputs:',
      '  workingDirectory:',
      '    type: secret',
      'steps:',
      '  - id: masked-path',
      '    run:',
      '      command: echo',
      '      cwd: "${workingDirectory}"',
      '',
    ].join('\n'),
    'utf8',
  );
  return { manifestPath, productName };
}

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
    await expect(page.locator('#product-name')).toHaveText('Secret details');
    await expect(page.locator('#product-version')).toHaveText('display-only');
    await expect(page.locator('.welcome p')).toHaveText('Secret details display-only');
    await page.locator('#next').click();

    const field = page.locator('.field[data-id="displaySecret"]');
    await expect(field.locator('label')).toHaveText('Secret details');
    await field.locator('input').fill('Secret details');
    await field.locator('input').dispatchEvent('change');

    await expect(field.locator('label')).toHaveText('***');
    await expect(page.locator('#product-name')).toHaveText('***');
    await expect(page.locator('#product-version')).toHaveText('display-only');
    await expect.poll(() => page.title()).toBe('***');
    await page.locator('#back').click();
    await expect(page.locator('.welcome p')).toHaveText('*** display-only');
    await expect(page.locator('body')).not.toContainText('Secret details');
  } finally {
    await application?.close();
  }
});

test('masks seeded product name and version in the persistent header and welcome page', async () => {
  let application: ElectronApplication | undefined;

  try {
    application = await electron.launch({
      executablePath: electronExecutable,
      args: [
        launcherPath,
        fixturePath,
        '--set',
        'displaySecret=Secret details',
        '--set',
        'workingDirectory=display-only',
      ],
      cwd: packageDirectory,
    });
    const page = await application.firstWindow();

    await expect(page.locator('#product-name')).toHaveText('***');
    await expect(page.locator('#product-version')).toHaveText('***');
    await expect(page.locator('.welcome p')).toHaveText('*** ***');
    await expect(page.locator('body')).not.toContainText('Secret details');
    await expect(page.locator('body')).not.toContainText('display-only');
  } finally {
    await application?.close();
  }
});

test('refreshes product display after planning derives a full-path secret', async () => {
  const { manifestPath, productName } = derivedProductFixture();
  let application: ElectronApplication | undefined;

  try {
    application = await electron.launch({
      executablePath: electronExecutable,
      args: [launcherPath, manifestPath],
      cwd: packageDirectory,
    });
    const page = await application.firstWindow();
    const next = page.locator('#next');

    await expect(page.locator('#product-name')).toHaveText(productName);
    await next.click();
    const input = page.locator('.field[data-id="workingDirectory"] input');
    await input.fill(relativeSecret);
    await input.dispatchEvent('change');
    await expect(input).toHaveValue('');
    await expect(page.locator('#product-name')).toHaveText(productName);
    await next.click();

    await expect(page.locator('.result-heading')).toHaveText('Summary');
    await expect(page.locator('#product-name')).toHaveText('***');
    await expect(page.locator('body')).not.toContainText(productName);
  } finally {
    await application?.close();
  }
});

test('refreshes product display when Back overtakes the plan response', async () => {
  const { manifestPath, productName } = derivedProductFixture();
  let application: ElectronApplication | undefined;

  try {
    application = await electron.launch({
      executablePath: electronExecutable,
      args: [launcherPath, manifestPath],
      cwd: packageDirectory,
    });
    const page = await application.firstWindow();
    const next = page.locator('#next');
    const back = page.locator('#back');

    await next.click();
    const input = page.locator('.field[data-id="workingDirectory"] input');
    await input.fill(relativeSecret);
    await input.dispatchEvent('change');
    await expect(input).toHaveValue('');
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

    await expect(page.locator('.field[data-id="workingDirectory"]')).toBeVisible();
    await expect(page.locator('#product-name')).toHaveText('***');
    await back.click();
    await expect(page.locator('.welcome p')).toHaveText('*** 1.0.0');
    await expect(page.locator('body')).not.toContainText(productName);
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

test('blocks Install while Back refreshes a ready Summary', async () => {
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

    const controlsImmediately = await page.evaluate(() => {
      const capture = { runStarted: 0 };
      (
        window as unknown as {
          summaryBackRaceCapture: { runStarted: number };
        }
      ).summaryBackRaceCapture = capture;
      window.rune.onEvent((event) => {
        if (event.kind === 'runStarted') {
          capture.runStarted += 1;
        }
      });

      const backButton = document.querySelector('#back');
      const nextButton = document.querySelector('#next');
      if (
        !(backButton instanceof HTMLButtonElement) ||
        !(nextButton instanceof HTMLButtonElement)
      ) {
        throw new Error('wizard navigation controls did not render');
      }
      backButton.click();
      const controls = {
        backDisabled: backButton.disabled,
        installDisabled: nextButton.disabled,
      };
      nextButton.click();
      return controls;
    });

    expect(controlsImmediately).toEqual({ backDisabled: true, installDisabled: true });
    await expect(page.locator('.field[data-id="publicPath"] input')).toHaveValue('***');
    await page.evaluate(
      () =>
        new Promise<void>((resolveFrame) => {
          requestAnimationFrame(() => requestAnimationFrame(() => resolveFrame()));
        }),
    );
    expect(
      await page.evaluate(
        () =>
          (
            window as unknown as {
              summaryBackRaceCapture: { runStarted: number };
            }
          ).summaryBackRaceCapture.runStarted,
      ),
    ).toBe(0);
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
