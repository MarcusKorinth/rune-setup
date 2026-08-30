import { existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { Session } from '@rune/engine';

const electronHarness = vi.hoisted(() => ({
  handlers: new Map<string, (...args: unknown[]) => unknown>(),
  duringLoad: undefined as (() => Promise<void>) | undefined,
  closeDuringLoad: false,
}));

vi.mock('electron', () => {
  class FakeBrowserWindow {
    readonly webContents = { send: vi.fn() };
    readonly #listeners = new Map<string, Array<(...args: unknown[]) => void>>();

    once(event: string, listener: (...args: unknown[]) => void): void {
      this.on(event, listener);
    }

    on(event: string, listener: (...args: unknown[]) => void): void {
      const listeners = this.#listeners.get(event) ?? [];
      listeners.push(listener);
      this.#listeners.set(event, listeners);
    }

    show(): void {}

    close(): void {
      let prevented = false;
      this.#emit('close', {
        preventDefault: () => {
          prevented = true;
        },
      });
      if (!prevented) {
        this.#emit('closed');
      }
    }

    async loadFile(): Promise<void> {
      if (electronHarness.closeDuringLoad) {
        this.close();
      }
      await electronHarness.duringLoad?.();
    }

    #emit(event: string, ...args: unknown[]): void {
      for (const listener of this.#listeners.get(event) ?? []) {
        listener(...args);
      }
    }
  }

  return {
    app: {
      exit: vi.fn(),
      getAppPath: vi.fn(() => 'C:\\rune-shell'),
      isPackaged: false,
      whenReady: vi.fn(async () => undefined),
    },
    BrowserWindow: FakeBrowserWindow,
    ipcMain: {
      handle: vi.fn((channel: string, handler: (...args: unknown[]) => unknown) => {
        electronHarness.handlers.set(channel, (...args: unknown[]) => handler({}, ...args));
      }),
    },
  };
});

import { app } from 'electron';

import { headlessRun, main } from '../src/main/index.js';
import type { ShellInvocation } from '../src/main/argv.js';

afterEach(() => {
  vi.restoreAllMocks();
});

beforeEach(() => {
  vi.clearAllMocks();
  electronHarness.handlers.clear();
  electronHarness.duringLoad = undefined;
  electronHarness.closeDuringLoad = false;
});

describe('the GUI shell stderr diagnostics', () => {
  it('masks registered secrets in headless warnings', async () => {
    const manifestPath = manifest([
      'inputs:',
      '  enabled:',
      '    type: boolean',
      '    default: false',
      '  token:',
      '    type: secret',
      '  warningInput:',
      '    type: text',
      '    when: "${enabled}"',
      'steps: []',
    ]);
    const session = await Session.open(manifestPath, {
      environment: {},
      mode: 'non-interactive',
      overrides: { token: 'warningInput', warningInput: 'discarded' },
    });
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);

    await expect(headlessRun(session, invocation(manifestPath))).resolves.toBe(0);

    const output = stderr.mock.calls.map(([text]) => String(text)).join('');
    expect(output).toContain('warning: *** was set from --set');
    expect(output).not.toContain('warningInput');
  });

  it('masks registered secrets when a headless run rejects', async () => {
    const manifestPath = manifest([
      'inputs:',
      '  token:',
      '    type: secret',
      'steps:',
      '  - id: fail',
      '    run:',
      '      command: fail',
    ]);
    const session = await Session.open(manifestPath, {
      environment: {},
      mode: 'non-interactive',
      overrides: { token: 'headless-secret' },
      runner: {
        run: async () => {
          throw new Error('runner rejected headless-secret');
        },
      },
    });
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);

    await expect(headlessRun(session, invocation(manifestPath))).resolves.toBe(70);

    expect(stderr).toHaveBeenCalledWith('runner rejected ***\n');
    expect(stderr.mock.calls.flat().join('')).not.toContain('headless-secret');
  });

  it('masks registered secrets when windowed result delivery rejects', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'rune-shell-windowed-diagnostic-'));
    const manifestPath = manifest(['inputs:', '  token:', '    type: secret', 'steps: []'], dir);
    const secret = 'windowed-secret';
    const blockedDirectory = join(dir, `blocked-${secret}`);
    writeFileSync(blockedDirectory, 'not a directory', 'utf8');
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    electronHarness.duringLoad = async () => {
      const execute = electronHarness.handlers.get('rune:execute');
      if (execute === undefined) {
        throw new Error('the execute handler was not registered');
      }
      try {
        await execute();
      } catch {
        // The bridge also rejects to the renderer; main has already handled the fatal error.
      }
    };

    await main([
      manifestPath,
      '--set',
      `token=${secret}`,
      '--result',
      join(blockedDirectory, 'result.json'),
    ]);

    const output = stderr.mock.calls.map(([text]) => String(text)).join('');
    expect(app.exit).toHaveBeenCalledWith(70);
    expect(output).toContain('blocked-***');
    expect(output).not.toContain(secret);
  });

  it('turns failed pre-Proceed result delivery into a masked fatal exit', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'rune-shell-close-diagnostic-'));
    const manifestPath = manifest(['inputs:', '  token:', '    type: secret', 'steps: []'], dir);
    const secret = 'close-secret';
    const blockedDirectory = join(dir, `blocked-${secret}`);
    const resultPath = join(blockedDirectory, 'cancelled.json');
    writeFileSync(blockedDirectory, 'not a directory', 'utf8');
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    electronHarness.closeDuringLoad = true;

    await expect(
      main([manifestPath, '--set', `token=${secret}`, '--result', resultPath]),
    ).resolves.toBeUndefined();

    const output = stderr.mock.calls.map(([text]) => String(text)).join('');
    expect(app.exit).toHaveBeenCalledOnce();
    expect(app.exit).toHaveBeenCalledWith(70);
    expect(output).toContain('blocked-***');
    expect(output).not.toContain(secret);
    expect(existsSync(resultPath)).toBe(false);
  });
});

function manifest(lines: readonly string[], directory?: string): string {
  const dir = directory ?? mkdtempSync(join(tmpdir(), 'rune-shell-diagnostic-'));
  const path = join(dir, 'installer.yaml');
  writeFileSync(
    path,
    [
      'schemaVersion: 1',
      'product:',
      '  name: Diagnostic fixture',
      '  version: 1.0.0',
      ...lines,
      '',
    ].join('\n'),
    'utf8',
  );
  return path;
}

function invocation(manifestPath: string): ShellInvocation {
  return {
    manifestPath,
    values: [],
    overrides: {},
    locale: undefined,
    result: undefined,
    logFile: undefined,
    nonInteractive: true,
  };
}
