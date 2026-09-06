import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { _electron as electron, expect, test, type ElectronApplication } from '@playwright/test';

const packageDirectory = dirname(dirname(fileURLToPath(import.meta.url)));
const fixturePath = join(packageDirectory, 'tests', 'fixtures', 'smoke.yaml');
const conditionalFixturePath = join(
  packageDirectory,
  'tests',
  'fixtures',
  'conditional-input.yaml',
);
const requiredBooleanFixturePath = join(
  packageDirectory,
  'tests',
  'fixtures',
  'required-boolean.yaml',
);
const invalidSeedFixturePath = join(packageDirectory, 'tests', 'fixtures', 'invalid-seed.yaml');
const executionFixturePath = join(packageDirectory, 'tests', 'fixtures', 'execution.yaml');
const launcherPath = join(packageDirectory, 'tests', 'fixtures', 'launch.cjs');
const rendererLauncherPath = join(packageDirectory, 'tests', 'fixtures', 'renderer-launch.cjs');
const electronExecutable = createRequire(import.meta.url)('electron') as string;

interface SummaryTestControl {
  planCount(): number;
  resolvePlan(index: number, title: string): void;
  warningCount(): number;
  resolveWarnings(index: number, warnings: readonly string[]): void;
  doneCount(): number;
  emitOutput(line: string): void;
  emitStepStarted(index: number, total: number): void;
  emitFinished(): void;
  emitRunFinished(): void;
}

interface InputRaceTestControl {
  submissionCount(): number;
  rejectSubmission(index: number): void;
  resolveSubmission(index: number): void;
}

interface SmokeRunResult {
  readonly exitCode: number;
  readonly mode: string;
  readonly status: string;
  readonly steps: readonly { readonly id: string; readonly state: string }[];
}

async function readSmokeResult(path: string): Promise<SmokeRunResult> {
  return JSON.parse(await readFile(path, 'utf8')) as SmokeRunResult;
}

async function runHeadlessShell(resultPath: string): Promise<{
  readonly exitCode: number;
  readonly stderr: string;
  readonly stdout: string;
}> {
  const child = spawn(
    electronExecutable,
    [
      '--no-sandbox',
      launcherPath,
      executionFixturePath,
      '--non-interactive',
      '--result',
      resultPath,
    ],
    { cwd: packageDirectory, windowsHide: true },
  );
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
        reject(new Error(`headless Electron smoke ended from ${signal}`));
        return;
      }
      resolve(code ?? 70);
    });
  });
  return { exitCode, stderr, stdout };
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
    await expect(page).toHaveTitle('Custom shell window');
    await expect(page.locator('.welcome h2')).toHaveText('Welcome');
    await expect(page.locator('.welcome p')).toHaveText('Real Electron renderer smoke');
    await expect(page.locator('#logo')).toBeVisible();
    await expect.poll(() => page.locator('#logo').evaluate((logo) => logo.naturalWidth)).toBe(2);
    await expect(page.locator('.welcome .banner')).toBeVisible();
    await expect
      .poll(() => page.locator('.welcome .banner').evaluate((banner) => banner.naturalWidth))
      .toBe(2);
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

test('runs the real windowed shell through Result and exits successfully', async () => {
  const resultDirectory = await mkdtemp(join(tmpdir(), 'rune-windowed-smoke-'));
  const resultPath = join(resultDirectory, 'result.json');
  let application: ElectronApplication | undefined;

  try {
    application = await electron.launch({
      executablePath: electronExecutable,
      args: [launcherPath, executionFixturePath, '--result', resultPath],
      cwd: packageDirectory,
    });
    const page = await application.firstWindow();
    const next = page.locator('#next');

    await expect(page.locator('.welcome h2')).toHaveText('Welcome');
    await next.click();
    await expect(page.locator('.result-heading')).toHaveText('Summary');
    await expect(next).toHaveText('Install');
    await expect(next).toBeEnabled();
    await next.click();
    await expect(page.locator('.result-heading')).toHaveText('Setup completed successfully.');

    const exited = new Promise<number | null>((resolve) => {
      application?.process().once('exit', resolve);
    });
    await next.click();
    expect(await exited).toBe(0);
    const result = await readSmokeResult(resultPath);
    expect(result).toMatchObject({ exitCode: 0, mode: 'gui', status: 'succeeded' });
    expect(result.steps).toMatchObject([{ id: 'execution-smoke', state: 'SUCCEEDED' }]);
    application = undefined;
  } finally {
    if (application !== undefined) {
      await application.close().catch(() => undefined);
    }
    await rm(resultDirectory, { force: true, recursive: true });
  }
});

test('runs the real non-interactive shell and writes a successful result', async () => {
  const resultDirectory = await mkdtemp(join(tmpdir(), 'rune-headless-smoke-'));
  const resultPath = join(resultDirectory, 'result.json');

  try {
    const run = await runHeadlessShell(resultPath);
    expect(run.exitCode).toBe(0);
    expect(run.stderr).toContain('running 1 steps');

    const result = await readSmokeResult(resultPath);
    expect(result).toMatchObject({ exitCode: 0, mode: 'non-interactive', status: 'succeeded' });
    expect(result.steps).toMatchObject([{ id: 'execution-smoke', state: 'SUCCEEDED' }]);
  } finally {
    await rm(resultDirectory, { force: true, recursive: true });
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

test('waits for Result warnings before allowing Finish', async () => {
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
            window as unknown as { summaryTestControl: SummaryTestControl }
          ).summaryTestControl.planCount(),
        ),
      )
      .toBe(1);
    await page.evaluate(() =>
      (
        window as unknown as { summaryTestControl: SummaryTestControl }
      ).summaryTestControl.resolvePlan(0, 'warning plan'),
    );
    await expect(next).toBeEnabled();
    await next.click();
    await expect
      .poll(() =>
        page.evaluate(() =>
          (
            window as unknown as { summaryTestControl: SummaryTestControl }
          ).summaryTestControl.warningCount(),
        ),
      )
      .toBe(1);

    await expect(page.locator('.progress-track')).toBeVisible();
    await expect(page.locator('.result-badge')).toHaveCount(0);
    await expect(next).toBeDisabled();
    expect(
      await page.evaluate(() =>
        (
          window as unknown as { summaryTestControl: SummaryTestControl }
        ).summaryTestControl.doneCount(),
      ),
    ).toBe(0);

    await page.evaluate(() =>
      (
        window as unknown as { summaryTestControl: SummaryTestControl }
      ).summaryTestControl.resolveWarnings(0, ['A required warning']),
    );
    await expect(page.locator('.result-heading')).toHaveText('Setup completed successfully.');
    await expect(page.locator('.result-sub')).toContainText([
      'succeeded: 1 succeeded, 0 failed, 0 skipped, 0 cancelled, 0 not run (exit 0)',
      'warning: A required warning',
    ]);
    await expect(next).toHaveText('Finish');
    await expect(next).toBeEnabled();
    await next.click();
    await expect
      .poll(() =>
        page.evaluate(() =>
          (
            window as unknown as { summaryTestControl: SummaryTestControl }
          ).summaryTestControl.doneCount(),
        ),
      )
      .toBe(1);
  } finally {
    await application?.close();
  }
});

test('blocks Next while the engine is validating an edited input', async () => {
  let application: ElectronApplication | undefined;

  try {
    application = await electron.launch({
      executablePath: electronExecutable,
      args: [rendererLauncherPath, '--input-race'],
      cwd: packageDirectory,
    });
    const page = await application.firstWindow();
    const next = page.locator('#next');

    await next.click();
    const field = page.locator('.field[data-id="code"]');
    await expect(field.locator('input')).toHaveValue('GOOD');
    await expect(next).toBeEnabled();

    const disabledImmediately = await page.evaluate(() => {
      const input = document.querySelector('.field[data-id="code"] input');
      const nextButton = document.querySelector('#next');
      if (!(input instanceof HTMLInputElement) || !(nextButton instanceof HTMLButtonElement)) {
        throw new Error('input race fixture did not render its controls');
      }
      input.value = 'bad';
      input.dispatchEvent(new Event('change', { bubbles: true }));
      const disabled = nextButton.disabled;
      nextButton.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      return disabled;
    });

    expect(disabledImmediately).toBe(true);
    await expect
      .poll(() =>
        page.evaluate(() =>
          (
            window as unknown as { inputRaceTestControl: InputRaceTestControl }
          ).inputRaceTestControl.submissionCount(),
        ),
      )
      .toBe(1);
    await expect(field).toBeVisible();
    await expect(page.locator('.result-heading')).toHaveCount(0);
    await expect(next).toBeDisabled();

    await page.evaluate(() =>
      (
        window as unknown as { inputRaceTestControl: InputRaceTestControl }
      ).inputRaceTestControl.rejectSubmission(0),
    );
    await expect(field).toHaveClass(/invalid/);
    await expect(field.locator('.error')).toHaveText('Use uppercase letters');
    await expect(field.locator('input')).toHaveValue('bad');
    await expect(next).toBeDisabled();
    await expect(page.locator('.result-heading')).toHaveCount(0);

    await page.evaluate(() => {
      const input = document.querySelector('.field[data-id="code"] input');
      const nextButton = document.querySelector('#next');
      if (!(input instanceof HTMLInputElement) || !(nextButton instanceof HTMLButtonElement)) {
        throw new Error('input race fixture did not render its controls');
      }
      input.value = 'GOOD';
      input.dispatchEvent(new Event('change', { bubbles: true }));
      nextButton.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    await expect
      .poll(() =>
        page.evaluate(() =>
          (
            window as unknown as { inputRaceTestControl: InputRaceTestControl }
          ).inputRaceTestControl.submissionCount(),
        ),
      )
      .toBe(2);
    await page.evaluate(() =>
      (
        window as unknown as { inputRaceTestControl: InputRaceTestControl }
      ).inputRaceTestControl.resolveSubmission(1),
    );
    await expect(page.locator('.result-heading')).toHaveText('Summary');
  } finally {
    await application?.close();
  }
});

test('does not retain a pending Next request after navigating Back', async () => {
  let application: ElectronApplication | undefined;

  try {
    application = await electron.launch({
      executablePath: electronExecutable,
      args: [rendererLauncherPath, '--input-race'],
      cwd: packageDirectory,
    });
    const page = await application.firstWindow();
    const next = page.locator('#next');
    const field = page.locator('.field[data-id="code"]');

    await next.click();
    await expect(field).toBeVisible();
    await page.evaluate(() => {
      const input = document.querySelector('.field[data-id="code"] input');
      const nextButton = document.querySelector('#next');
      if (!(input instanceof HTMLInputElement) || !(nextButton instanceof HTMLButtonElement)) {
        throw new Error('input race fixture did not render its controls');
      }
      input.value = 'bad';
      input.dispatchEvent(new Event('change', { bubbles: true }));
      nextButton.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    await expect
      .poll(() =>
        page.evaluate(() =>
          (
            window as unknown as { inputRaceTestControl: InputRaceTestControl }
          ).inputRaceTestControl.submissionCount(),
        ),
      )
      .toBe(1);

    await page.locator('#back').click();
    await expect(page.locator('.welcome h2')).toHaveText('Welcome');
    await page.evaluate(() =>
      (
        window as unknown as { inputRaceTestControl: InputRaceTestControl }
      ).inputRaceTestControl.rejectSubmission(0),
    );

    await next.click();
    await expect(field).toBeVisible();
    await page.evaluate(() => {
      const input = document.querySelector('.field[data-id="code"] input');
      if (!(input instanceof HTMLInputElement)) {
        throw new Error('input race fixture did not render its controls');
      }
      input.value = 'GOOD';
      input.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await expect
      .poll(() =>
        page.evaluate(() =>
          (
            window as unknown as { inputRaceTestControl: InputRaceTestControl }
          ).inputRaceTestControl.submissionCount(),
        ),
      )
      .toBe(2);
    await page.evaluate(() =>
      (
        window as unknown as { inputRaceTestControl: InputRaceTestControl }
      ).inputRaceTestControl.resolveSubmission(1),
    );
    await expect(next).toBeEnabled();
    await expect(next).toHaveText('Next');
    await expect(field).toBeVisible();
    await expect(page.locator('.result-heading')).toHaveCount(0);
  } finally {
    await application?.close();
  }
});

test('bounds the live Progress log while retaining its newest output', async () => {
  const liveLogCap = 20_000;
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
    await expect
      .poll(() =>
        page.evaluate(() =>
          (
            window as unknown as { summaryTestControl: SummaryTestControl }
          ).summaryTestControl.planCount(),
        ),
      )
      .toBe(1);
    await page.evaluate(() =>
      (
        window as unknown as { summaryTestControl: SummaryTestControl }
      ).summaryTestControl.resolvePlan(0, 'progress plan'),
    );
    await expect(install).toBeEnabled();
    await install.click();
    await expect(page.locator('.log')).toBeVisible();

    const logUpdates = await page.evaluate(async (cap) => {
      const control = (window as unknown as { summaryTestControl: SummaryTestControl })
        .summaryTestControl;
      const log = document.querySelector('.log');
      if (log === null) {
        throw new Error('Progress log did not render');
      }
      let mutationCount = 0;
      const observer = new MutationObserver((records) => {
        mutationCount += records.length;
      });
      observer.observe(log, { childList: true });
      control.emitOutput('discard-this-old-head');
      for (let index = 0; index < 30; index += 1) {
        control.emitOutput(`intermediate-${index}-${'x'.repeat(1_000)}`);
      }
      control.emitOutput(`${'x'.repeat(cap + 100)}keep-this-newest-tail`);
      control.emitFinished();
      const beforeFrameText = log.textContent;
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
      await Promise.resolve();
      observer.disconnect();
      return { beforeFrameText, mutationCount };
    }, liveLogCap);

    await expect.poll(() => page.locator('.log').textContent()).toContain('keep-this-newest-tail');
    const log = await page.locator('.log').textContent();
    expect(logUpdates.beforeFrameText).toBe('');
    expect(logUpdates.mutationCount).toBe(1);
    expect(log).not.toContain('discard-this-old-head');
    expect(log).toContain('  -> SUCCEEDED after 1ms');
    expect(log.length).toBeLessThanOrEqual(liveLogCap);
  } finally {
    await application?.close();
  }
});

test('advances Progress without CSP-blocked inline styles', async () => {
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
    await expect
      .poll(() =>
        page.evaluate(() =>
          (
            window as unknown as { summaryTestControl: SummaryTestControl }
          ).summaryTestControl.planCount(),
        ),
      )
      .toBe(1);
    await page.evaluate(() =>
      (
        window as unknown as { summaryTestControl: SummaryTestControl }
      ).summaryTestControl.resolvePlan(0, 'progress plan'),
    );
    await expect(install).toBeEnabled();
    await install.click();

    const progress = page.locator('progress.progress-track');
    await expect(progress).toHaveJSProperty('value', 0);
    await page.evaluate(() =>
      (
        window as unknown as { summaryTestControl: SummaryTestControl }
      ).summaryTestControl.emitStepStarted(1, 0),
    );
    await expect(progress).toHaveJSProperty('value', 0);
    await page.evaluate(() =>
      (
        window as unknown as { summaryTestControl: SummaryTestControl }
      ).summaryTestControl.emitStepStarted(1, 2),
    );
    await expect(progress).toHaveJSProperty('value', 0.5);
    await page.evaluate(() =>
      (
        window as unknown as { summaryTestControl: SummaryTestControl }
      ).summaryTestControl.emitRunFinished(),
    );
    await expect(progress).toHaveJSProperty('value', 1);
    await expect(progress).not.toHaveAttribute('style');
  } finally {
    await application?.close();
  }
});

test('lets a required boolean be answered directly as false', async () => {
  let application: ElectronApplication | undefined;

  try {
    application = await electron.launch({
      executablePath: electronExecutable,
      args: [launcherPath, requiredBooleanFixturePath],
      cwd: packageDirectory,
    });
    const page = await application.firstWindow();
    const next = page.locator('#next');

    await next.click();
    const boolean = page.locator('.field[data-id="continue"] select');
    await expect(boolean).toHaveValue('');
    await expect(boolean.locator('option:checked')).toHaveText('(not set)');
    await expect(next).toBeDisabled();

    await boolean.selectOption('false');
    await expect(boolean).toHaveValue('false');
    await expect(boolean.locator('option:checked')).toHaveText('false');
    await expect(next).toBeEnabled();
  } finally {
    await application?.close();
  }
});

test('disables conditional controls natively across input pages', async () => {
  let application: ElectronApplication | undefined;

  try {
    application = await electron.launch({
      executablePath: electronExecutable,
      args: [launcherPath, conditionalFixturePath],
      cwd: packageDirectory,
    });
    const page = await application.firstWindow();
    const next = page.locator('#next');
    const controller = page.locator('.field[data-id="enableDetails"] select');
    const dependent = page.locator('.field[data-id="details"] input');

    await expect(page.locator('.welcome h2')).toHaveText('Welcome');
    await next.click();
    await expect(controller).toHaveValue('true');
    await expect(page.locator('.field[data-id="selectDetails"] select')).toHaveValue('');
    await dependent.fill('invalid');
    await dependent.dispatchEvent('change');
    await expect(page.locator('.field[data-id="details"]')).toHaveClass(/invalid/);
    await expect(next).toBeDisabled();

    await controller.selectOption('false');
    await expect(page.locator('.field[data-id="details"]')).toHaveClass(/disabled/);
    await expect(page.locator('.field[data-id="details"]')).not.toHaveClass(/invalid/);
    await expect(controller).toBeEnabled();
    // The generic input path renders text, secret, file, and directory controls.
    await expect(page.locator('.field[data-id="details"] input')).toBeDisabled();
    await expect(page.locator('.field[data-id="secretDetails"] input')).toBeDisabled();
    await expect(page.locator('.field[data-id="booleanDetails"] select')).toBeDisabled();
    await expect(page.locator('.field[data-id="selectDetails"] select')).toBeDisabled();
    await expect(next).toBeEnabled();

    await next.click();
    await expect(page.locator('.field[data-id="multiselectDetails"] input').nth(0)).toBeDisabled();
    await expect(page.locator('.field[data-id="multiselectDetails"] input').nth(1)).toBeDisabled();
    await expect(page.locator('.field[data-id="fileDetails"] input')).toBeDisabled();
    await expect(page.locator('.field[data-id="directoryDetails"] input')).toBeDisabled();
  } finally {
    await application?.close();
  }
});

test('prefills an invalid seed and blocks Next until the engine accepts a correction', async () => {
  let application: ElectronApplication | undefined;

  try {
    application = await electron.launch({
      executablePath: electronExecutable,
      args: [launcherPath, invalidSeedFixturePath],
      cwd: packageDirectory,
    });
    const page = await application.firstWindow();
    const next = page.locator('#next');

    await expect(page.locator('.welcome h2')).toHaveText('Welcome');
    await next.click();

    const field = page.locator('.field[data-id="code"]');
    const input = field.locator('input');
    await expect(input).toHaveValue('bad-value');
    await expect(field).toHaveClass(/invalid/);
    await expect(field.locator('.error')).toHaveText('Use uppercase letters');
    await expect(next).toBeDisabled();

    await input.fill('GOOD');
    await input.dispatchEvent('change');
    await expect(field).not.toHaveClass(/invalid/);
    await expect(input).toHaveValue('GOOD');
    await expect(next).toBeEnabled();
  } finally {
    await application?.close();
  }
});
