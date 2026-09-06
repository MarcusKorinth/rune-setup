import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { _electron as electron, expect, test, type ElectronApplication } from '@playwright/test';

const packageDirectory = dirname(dirname(fileURLToPath(import.meta.url)));
const fixturePath = join(
  packageDirectory,
  'tests',
  'fixtures',
  'localized-chrome',
  'installer.yaml',
);
const launcherPath = join(packageDirectory, 'tests', 'fixtures', 'launch.cjs');
const electronExecutable = createRequire(import.meta.url)('electron') as string;
const invocation = [
  '--no-sandbox',
  launcherPath,
  fixturePath,
  '--locale',
  'de',
  '--set',
  'token=localized-secret',
];

test('renders localized progress, result counters, and warnings', async () => {
  let application: ElectronApplication | undefined;

  try {
    application = await electron.launch({
      executablePath: electronExecutable,
      args: invocation.slice(1),
      cwd: packageDirectory,
    });
    const page = await application.firstWindow();
    const next = page.locator('#next');

    await next.click();
    await expect(page.locator('.field[data-id="token"]')).toBeVisible();
    await expect(next).toBeEnabled();
    await next.click();
    await expect(page.locator('.result-heading')).toHaveText('Summary');
    await expect(next).toBeEnabled();
    await page.evaluate(() => {
      const capture = { runStarted: '', stepFinished: '' };
      (
        window as unknown as {
          localizedChromeCapture: typeof capture;
          rune: {
            onEvent(listener: (event: { kind: string }) => void): void;
          };
        }
      ).localizedChromeCapture = capture;
      (
        window as unknown as {
          rune: {
            onEvent(listener: (event: { kind: string }) => void): void;
          };
        }
      ).rune.onEvent((event) => {
        if (event.kind === 'runStarted') {
          capture.runStarted = document.querySelector('.progress-title')?.textContent ?? '';
        }
        if (event.kind === 'stepFinished') {
          const log = document.querySelector('.log');
          requestAnimationFrame(() => {
            capture.stepFinished = log?.textContent ?? '';
          });
        }
      });
    });
    await next.click();

    await expect(page.locator('.progress-title')).toHaveText(
      'LOKAL SCHRITT 1/2: Localized step title',
    );
    await expect(page.locator('.log')).toContainText('LOKAL AUSGABE localized child output');
    await expect(page.locator('.result-heading')).toHaveText('LOKAL ERFOLG');
    await expect(page.locator('.result-sub').first()).toHaveText(
      'LOKAL BILANZ succeeded 1/0/1/0/0 CODE 0',
    );
    await expect(page.locator('.result-sub').nth(1)).toContainText(
      'LOKAL WARNUNG steps[0].run.args[1] interpolates secret input "token"',
    );
    await expect
      .poll(() =>
        page.evaluate(
          () =>
            (
              window as unknown as {
                localizedChromeCapture: { runStarted: string; stepFinished: string };
              }
            ).localizedChromeCapture,
        ),
      )
      .toMatchObject({
        runStarted: expect.stringMatching(/^LOKAL START 2 \w+$/),
        stepFinished: expect.stringMatching(
          /LOKAL ENDE SUCCEEDED CODE 0 ZEIT \d+(?:\.\d+)?\nLOKAL ENDE SKIPPED OHNE CODE ZEIT \d+(?:\.\d+)?/,
        ),
      });
  } finally {
    await application?.close();
  }
});

test('writes localized progress and warnings to headless stderr', async () => {
  const child = spawn(electronExecutable, [...invocation, '--non-interactive'], {
    cwd: packageDirectory,
    windowsHide: true,
  });
  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (chunk: string) => {
    stdout += chunk;
  });
  child.stderr.on('data', (chunk: string) => {
    stderr += chunk;
  });

  const exitCode = await new Promise<number>((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (code, signal) => {
      if (signal !== null) {
        reject(new Error(`localized headless smoke ended from ${signal}`));
        return;
      }
      resolve(code ?? 70);
    });
  });

  expect(exitCode).toBe(0);
  expect(stdout.trim()).toBe('');
  expect(stderr).toMatch(/LOKAL START 2 \w+/);
  expect(stderr).toContain('LOKAL SCHRITT 1/2: Localized step title');
  expect(stderr).toContain('LOKAL AUSGABE localized child output');
  expect(stderr).toMatch(/LOKAL ENDE SUCCEEDED CODE 0 ZEIT \d+(?:\.\d+)?/);
  expect(stderr).toMatch(/LOKAL ENDE SKIPPED OHNE CODE ZEIT \d+(?:\.\d+)?/);
  expect(stderr).toContain('LOKAL WARNUNG steps[0].run.args[1] interpolates secret input "token"');
});
