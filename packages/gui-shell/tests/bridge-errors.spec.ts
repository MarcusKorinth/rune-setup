import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { _electron as electron, expect, test, type ElectronApplication } from '@playwright/test';

import type { BridgeError, RuneBridge } from '../src/preload/types.js';

const packageDirectory = dirname(dirname(fileURLToPath(import.meta.url)));
const electronExecutable = createRequire(import.meta.url)('electron') as string;

test('retains masked rejection metadata across the real isolated preload', async () => {
  let application: ElectronApplication | undefined;
  try {
    application = await electron.launch({
      executablePath: electronExecutable,
      args: [join(packageDirectory, 'tests/fixtures/bridge-errors-launch.cjs')],
      cwd: packageDirectory,
    });
    const page = await application.firstWindow();
    await expect(page.locator('#product-name')).toHaveText('Edit rejection smoke');
    await page.evaluate(async () => {
      await (window as unknown as { rune: RuneBridge }).rune.setValue('token', 'private-token');
    });
    const rejection = await page.evaluate(async () => {
      try {
        await (window as unknown as { rune: RuneBridge }).rune.warnings();
        return null;
      } catch (error) {
        return { error: error as BridgeError, nativeError: error instanceof Error };
      }
    });
    expect(rejection).toEqual({
      nativeError: false,
      error: {
        kind: 'rune-error',
        code: 'RUNE-202',
        exitCode: 4,
        message: 'invalid ***',
        location: { file: '***/answers.yaml', line: 7, column: 9 },
        displayText: 'RUNE-202 (exit 4): ***/answers.yaml:7:9: invalid ***',
      },
    });
    await page.evaluate(async () => {
      await (window as unknown as { rune: RuneBridge }).rune.setValue('code', 'VALID');
    });
    await expect(page.locator('#next')).toBeEnabled();
  } finally {
    await application?.close();
  }
});

test('renders structured summary diagnostics verbatim and keeps Install disabled', async () => {
  let application: ElectronApplication | undefined;
  try {
    application = await electron.launch({
      executablePath: electronExecutable,
      args: [join(packageDirectory, 'tests/fixtures/renderer-launch.cjs')],
      cwd: packageDirectory,
    });
    const page = await application.firstWindow();
    await page.locator('#next').click();
    await expect(page.locator('.result-heading')).toHaveText('Summary');
    await expect
      .poll(() =>
        page.evaluate(() =>
          (
            window as unknown as { summaryTestControl: { planCount(): number } }
          ).summaryTestControl.planCount(),
        ),
      )
      .toBe(1);
    await page.evaluate(() => {
      (
        window as unknown as { summaryTestControl: { rejectPlan(index: number): void } }
      ).summaryTestControl.rejectPlan(0);
    });
    await expect(page.locator('.error')).toHaveText(
      'Authoritative diagnostic without reconstructed metadata.',
    );
    await expect(page.locator('#next')).toBeDisabled();
    await expect(page.locator('#back')).toBeEnabled();
  } finally {
    await application?.close();
  }
});
