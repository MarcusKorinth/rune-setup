import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { CancelToken, CancelledError, UsageError } from '@rune/engine';

import { run } from '../src/cli.js';
import { ExitWithCode, type CliIo } from '../src/io.js';
import type { Interaction } from '../src/prompt.js';
import { runCommand } from '../src/runCmd.js';

const gui = vi.hoisted(() => ({ launchGui: vi.fn() }));
vi.mock('../src/guiCmd.js', () => ({ launchGui: gui.launchGui }));

function capture(): CliIo & { readonly stderr: ReturnType<typeof vi.fn> } {
  return { stdout: vi.fn(), stderr: vi.fn() };
}

function interaction(forceExit = vi.fn()): Interaction {
  return {
    input: new PassThrough(),
    isTTY: false,
    write: vi.fn(),
    forceExit,
  };
}

function manifestFixture(directory: string): string {
  const manifestPath = join(directory, 'installer.yaml');
  writeFileSync(
    manifestPath,
    [
      'schemaVersion: 1',
      'product:',
      '  name: Example',
      '  version: "1.0.0"',
      'inputs: {}',
      'steps: []',
      '',
    ].join('\n'),
    'utf8',
  );
  return manifestPath;
}

afterEach(() => {
  gui.launchGui.mockReset();
  vi.restoreAllMocks();
});

describe('GUI result ownership before shell launch', () => {
  it('writes one zero-counter cancelled result when pre-shell cancellation owns the run', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'rune-gui-prelaunch-result-'));
    const manifestPath = manifestFixture(directory);
    const resultPath = join(directory, 'result.json');
    const io = capture();
    const cancel = new CancelToken();
    cancel.cancel();
    gui.launchGui.mockImplementationOnce(async (_manifest, _flags, _io, _interaction, control) => {
      expect(control.cancel).toBe(cancel);
      expect(control.cancel.isCancelled).toBe(true);
      throw new CancelledError('cancelled before the GUI shell started');
    });

    try {
      expect(
        await run(
          ['run', manifestPath, '--gui', '--result', resultPath],
          io,
          { cancel },
          interaction(),
        ),
      ).toBe(6);

      const result = JSON.parse(readFileSync(resultPath, 'utf8')) as Record<string, unknown>;
      expect(result).toMatchObject({
        mode: 'gui',
        status: 'cancelled',
        exitCode: 6,
        stepsTotal: 0,
        stepsExecuted: 0,
        nothingExecuted: true,
      });
      expect(io.stderr).toHaveBeenCalledTimes(1);
      expect(io.stderr).toHaveBeenCalledWith(`result written to ${resultPath}`);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('does not write a second result when an already-started shell exits cancelled', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'rune-gui-shell-result-owner-'));
    const resultPath = join(directory, 'result.json');
    gui.launchGui.mockRejectedValueOnce(new ExitWithCode(6));

    try {
      await expect(
        runCommand('installer.yaml', { gui: true, result: resultPath }, capture(), interaction()),
      ).rejects.toMatchObject({ code: 6 });
      expect(existsSync(resultPath)).toBe(false);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it.each([
    { name: 'a valid manifest', expectedCode: 6, expectedStatus: 'cancelled' },
    { name: 'an invalid manifest', expectedCode: 3, expectedStatus: 'config_error' },
    { name: 'invalid values', expectedCode: 4, expectedStatus: 'input_error' },
    { name: 'an invalid locale', expectedCode: 2, expectedStatus: undefined },
  ])('keeps $name authoritative with and without a result sink', async (scenario) => {
    const directory = mkdtempSync(join(tmpdir(), 'rune-gui-prelaunch-validation-'));
    const manifestPath = manifestFixture(directory);
    const valuesPath = join(directory, 'values.yaml');

    if (scenario.expectedCode === 3) {
      writeFileSync(manifestPath, 'schemaVersion: 1\nproduct:\n  name: Example\n', 'utf8');
    }
    if (scenario.expectedCode === 4) {
      writeFileSync(valuesPath, 'unknown: value\n', 'utf8');
    }

    try {
      for (const requestedResult of [false, true]) {
        const resultPath = join(directory, `result-${requestedResult}.json`);
        const args = ['run', manifestPath, '--gui'];
        if (scenario.expectedCode === 4) {
          args.push('--values', valuesPath);
        }
        if (scenario.expectedCode === 2) {
          args.push('--locale', 'definitely_invalid');
        }
        if (requestedResult) {
          args.push('--result', resultPath);
        }
        gui.launchGui.mockRejectedValueOnce(
          new CancelledError('cancelled before the GUI shell started'),
        );

        expect(await run(args, capture(), interaction())).toBe(scenario.expectedCode);
        if (scenario.expectedStatus === undefined) {
          expect(existsSync(resultPath)).toBe(false);
        } else if (requestedResult) {
          expect(JSON.parse(readFileSync(resultPath, 'utf8'))).toMatchObject({
            status: scenario.expectedStatus,
            exitCode: scenario.expectedCode,
          });
        } else {
          expect(existsSync(resultPath)).toBe(false);
        }
      }
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('does not write a result for GUI usage errors', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'rune-gui-usage-result-'));
    const resultPath = join(directory, 'result.json');
    gui.launchGui.mockRejectedValueOnce(new UsageError('GUI shell version mismatch'));

    try {
      await expect(
        runCommand('installer.yaml', { gui: true, result: resultPath }, capture(), interaction()),
      ).rejects.toBeInstanceOf(UsageError);
      expect(existsSync(resultPath)).toBe(false);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('maps a pre-shell cancellation result writer failure to exit 1', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'rune-gui-result-writer-error-'));
    const manifestPath = manifestFixture(directory);
    const io = capture();
    gui.launchGui.mockRejectedValueOnce(
      new CancelledError('cancelled before the GUI shell started'),
    );

    try {
      expect(
        await run(['run', manifestPath, '--gui', '--result', directory], io, interaction()),
      ).toBe(1);
      expect(io.stderr).toHaveBeenCalledWith(
        expect.stringContaining('could not finalize result file'),
      );
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
