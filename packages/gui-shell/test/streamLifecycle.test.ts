import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough, Writable } from 'node:stream';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({
  app: {
    exit: vi.fn(),
    getAppPath: vi.fn(() => 'C:\\rune-shell'),
    isPackaged: false,
    whenReady: vi.fn(),
  },
  BrowserWindow: class {},
  dialog: { showErrorBox: vi.fn() },
  ipcMain: { handle: vi.fn() },
}));

import { app } from 'electron';

import { main, type SigtermSource } from '../src/main/index.js';
import { LOST_STDOUT_DIAGNOSTIC } from '../src/main/streams.js';

const signals: SigtermSource = {
  on: () => undefined,
  off: () => undefined,
};

function systemError(code: string, message: string): NodeJS.ErrnoException {
  return Object.assign(new Error(`${code}: ${message}, write`), { code, syscall: 'write' });
}

function failingSink(error: Error): { readonly stream: Writable; readonly attempts: string[] } {
  const attempts: string[] = [];
  const stream = new Writable({
    write(chunk: Buffer, _encoding, callback) {
      attempts.push(chunk.toString());
      callback(error);
    },
  });
  return { stream, attempts };
}

function asynchronouslyFailingSink(error: Error): {
  readonly stream: Writable;
  readonly attempts: string[];
} {
  const attempts: string[] = [];
  const stream = new Writable({
    write(chunk: Buffer, _encoding, callback) {
      attempts.push(chunk.toString());
      setImmediate(() => callback(error));
    },
  });
  return { stream, attempts };
}

function collector(): { readonly stream: PassThrough; readonly text: () => string } {
  const chunks: string[] = [];
  const stream = new PassThrough();
  stream.on('data', (chunk: Buffer) => chunks.push(chunk.toString()));
  return { stream, text: () => chunks.join('') };
}

const listenersDrained = (): Promise<void> =>
  new Promise((resolve) => setImmediate(() => setImmediate(resolve)));

function manifest(): string {
  const directory = mkdtempSync(join(tmpdir(), 'rune-shell-streams-'));
  const path = join(directory, 'installer.yaml');
  writeFileSync(
    path,
    [
      'schemaVersion: 1',
      'product:',
      '  name: Stream contract',
      '  version: 1.0.0',
      'inputs: {}',
      'steps: []',
      '',
    ].join('\n'),
    'utf8',
  );
  return path;
}

afterEach(() => {
  vi.restoreAllMocks();
});

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(app.whenReady).mockResolvedValue();
});

describe('the GUI shell stream contract', () => {
  it('exits 70 and reports one fixed line when result stdout fails', async () => {
    const raw = systemError('ENOSPC', 'private device details');
    const stdout = failingSink(raw);
    const stderr = collector();

    await main([manifest(), '--non-interactive', '--result', '-'], signals, {
      stdout: stdout.stream,
      stderr: stderr.stream,
    });

    expect(app.exit).toHaveBeenCalledOnce();
    expect(app.exit).toHaveBeenCalledWith(70);
    expect(stdout.attempts).toHaveLength(1);
    expect(stderr.text().match(new RegExp(LOST_STDOUT_DIAGNOSTIC, 'gu'))).toHaveLength(1);
    expect(stderr.text()).not.toContain(raw.message);
    await listenersDrained();
    expect(stdout.stream.listenerCount('error')).toBe(0);
    expect(stderr.stream.listenerCount('error')).toBe(0);
  });

  it.each(['EPIPE', 'ECONNRESET'])(
    'preserves the run exit code when stdout ends with %s',
    async (code) => {
      const stdout = failingSink(systemError(code, 'consumer went away'));
      const stderr = collector();

      await main([manifest(), '--non-interactive', '--result', '-'], signals, {
        stdout: stdout.stream,
        stderr: stderr.stream,
      });

      expect(app.exit).toHaveBeenCalledOnce();
      expect(app.exit).toHaveBeenCalledWith(0);
      expect(stdout.attempts).toHaveLength(1);
      expect(stderr.text()).not.toContain(LOST_STDOUT_DIAGNOSTIC);
    },
  );

  it('keeps a startup exit code while an asynchronous stderr failure drains', async () => {
    const stdout = collector();
    const raw = systemError('EIO', 'private diagnostic details');
    const stderr = asynchronouslyFailingSink(raw);

    await main(['installer.yaml', '--unknown'], signals, {
      stdout: stdout.stream,
      stderr: stderr.stream,
    });

    expect(app.whenReady).not.toHaveBeenCalled();
    expect(app.exit).toHaveBeenCalledOnce();
    expect(app.exit).toHaveBeenCalledWith(2);
    expect(stdout.text()).toBe('');
    expect(stderr.attempts).toEqual(['unknown flag --unknown\n']);
    expect(stderr.stream.listenerCount('error')).toBe(1);

    await listenersDrained();
    expect(stderr.stream.listenerCount('error')).toBe(0);
  });
});
