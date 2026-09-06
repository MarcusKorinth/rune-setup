import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { _electron as electron, expect, test, type ElectronApplication } from '@playwright/test';

const packageDirectory = dirname(dirname(fileURLToPath(import.meta.url)));
const fixturePath = join(
  packageDirectory,
  'tests',
  'fixtures',
  'composed-display',
  'installer.yaml',
);
const launcherPath = join(packageDirectory, 'tests', 'fixtures', 'launch.cjs');
const electronExecutable = createRequire(import.meta.url)('electron') as string;
const secrets = [
  'running 1',
  'Step 1',
  'Output hello',
  'failed: 0',
  'Warning steps',
  'node boundary-step.cjs',
  'Install (exit 9)',
] as const;
const secretIds = [
  'runStartedBoundary',
  'stepStartedBoundary',
  'outputBoundary',
  'summaryBoundary',
  'warningBoundary',
  'commandBoundary',
  'titleBoundary',
] as const;

test('keeps accepted secrets out of composed Summary, Progress, and Result text', async () => {
  let application: ElectronApplication | undefined;

  try {
    application = await electron.launch({
      executablePath: electronExecutable,
      args: [launcherPath, fixturePath, '--locale', 'de'],
      cwd: packageDirectory,
    });
    const page = await application.firstWindow();
    const next = page.locator('#next');

    await next.click();
    for (const [index, secret] of secrets.entries()) {
      if (index === 5) {
        await expect(next).toBeEnabled();
        await next.click();
      }
      const input = page.locator(`.field[data-id="${secretIds[index]}"] input`);
      await input.fill(secret);
      await input.dispatchEvent('change');
    }
    await expect(next).toBeEnabled();
    await next.click();
    await expect(page.locator('.result-heading')).toHaveText('Summary');
    await expect(page.locator('.summary-step .command')).toHaveText('*** ***');
    await expect(page.locator('#page')).not.toContainText(secrets[5]);

    await page.evaluate(() => {
      const values = { runStarted: '', stepStarted: '' };
      (
        window as unknown as {
          composedDisplayCapture: typeof values;
        }
      ).composedDisplayCapture = values;
      (
        window as unknown as {
          rune: { onEvent(listener: (event: { kind: string }) => void): void };
        }
      ).rune.onEvent((event) => {
        if (event.kind === 'runStarted') {
          values.runStarted = document.querySelector('.progress-title')?.textContent ?? '';
        }
        if (event.kind === 'stepStarted') {
          values.stepStarted = document.querySelector('.progress-title')?.textContent ?? '';
        }
      });
    });

    await next.click();
    await expect(page.locator('.progress-title')).toHaveText('*** of 1: Install');
    await expect(page.locator('.log')).toContainText('*** output');
    await expect(page.locator('.result-heading')).toHaveText('Setup failed.');
    await expect(page.locator('.result-sub').first()).toContainText('*** succeeded');
    await expect(page.locator('.result-sub').nth(1)).toContainText('***[0].run.args[1]');
    await expect(page.locator('.result-step strong')).toHaveText('***');

    const captured = await page.evaluate(
      () =>
        (
          window as unknown as {
            composedDisplayCapture: { runStarted: string; stepStarted: string };
          }
        ).composedDisplayCapture,
    );
    expect(captured.runStarted).toMatch(/^\*\*\* steps on (?:windows|linux)$/);
    expect(captured.stepStarted).toBe('*** of 1: Install');
    const rendered = await page.locator('#page').textContent();
    for (const secret of secrets) {
      expect(rendered).not.toContain(secret);
    }
  } finally {
    await application?.close();
  }
});
