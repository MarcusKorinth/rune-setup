import {
  closeSync,
  createWriteStream,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type * as Fs from 'node:fs';

import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { RunFinished } from '../../src/engine/events.js';
import { createLogFileSink } from '../../src/logs/logFile.js';

vi.mock('node:fs', async (importOriginal) => {
  const fs = await importOriginal<typeof Fs>();
  return {
    ...fs,
    closeSync: vi.fn(fs.closeSync),
    createWriteStream: vi.fn(fs.createWriteStream),
  };
});

const closeSyncMock = vi.mocked(closeSync);
const createWriteStreamMock = vi.mocked(createWriteStream);
const finalEvent = {
  kind: 'runFinished',
  result: { status: 'succeeded', exitCode: 0 } as RunFinished['result'],
} satisfies RunFinished;

describe('log-file sink lifecycle', () => {
  beforeEach(() => {
    closeSyncMock.mockClear();
    createWriteStreamMock.mockClear();
  });

  it('returns one close promise and settles it after the stream closes', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'rune-log-file-'));
    const sink = createLogFileSink(join(directory, 'run.log'));

    try {
      const close = sink.close();

      expect(sink.close()).toBe(close);
      await expect(close).resolves.toBeUndefined();
      expect(closeSyncMock).toHaveBeenCalledTimes(1);
    } finally {
      await sink.close().catch(() => undefined);
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('writes an optional final event once while keeping close idempotent', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'rune-log-file-'));
    const path = join(directory, 'run.log');
    const sink = createLogFileSink(path);

    try {
      const close = sink.close(finalEvent);

      expect(sink.close(finalEvent)).toBe(close);
      await expect(close).resolves.toBeUndefined();
      expect(readFileSync(path, 'utf8').match(/run finished:/g)).toHaveLength(1);
      expect(readFileSync(path, 'utf8')).toContain('run finished: succeeded (exit 0)');
      expect(closeSyncMock).toHaveBeenCalledTimes(1);
    } finally {
      await sink.close().catch(() => undefined);
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('keeps history and the terminal event on the opened file after path replacement', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'rune-log-file-'));
    const path = join(directory, 'run.log');
    const rotatedPath = join(directory, 'run.log.1');
    const sink = createLogFileSink(path);

    try {
      sink.observer({
        kind: 'stepOutput',
        stepId: 'configure',
        stream: 'stdout',
        line: 'original history',
      });
      renameSync(path, rotatedPath);
      writeFileSync(path, 'replacement target\n', 'utf8');

      await expect(sink.close(finalEvent)).resolves.toBeUndefined();

      expect(readFileSync(rotatedPath, 'utf8')).toContain('[configure:stdout] original history');
      expect(readFileSync(rotatedPath, 'utf8')).toContain('run finished: succeeded (exit 0)');
      expect(readFileSync(path, 'utf8')).toBe('replacement target\n');
      expect(closeSyncMock).toHaveBeenCalledTimes(1);
    } finally {
      await sink.close().catch(() => undefined);
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('rejects a stream failure without writing success or replacing the primary error', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'rune-log-file-'));
    const path = join(directory, 'run.log');
    const sink = createLogFileSink(path);
    const stream = createWriteStreamMock.mock.results[0]?.value;
    if (stream === undefined) {
      throw new Error('write stream was not created');
    }
    const writeError = new Error('stream write failed');
    const closeError = new Error('descriptor close failed');
    const actualFs = await vi.importActual<typeof Fs>('node:fs');
    closeSyncMock.mockImplementationOnce((descriptor) => {
      actualFs.closeSync(descriptor);
      throw closeError;
    });

    try {
      const observedError = new Promise<void>((resolve) => stream.once('error', () => resolve()));
      stream.destroy(writeError);
      await observedError;

      const close = sink.close(finalEvent);
      expect(sink.close(finalEvent)).toBe(close);
      await expect(close).rejects.toBe(writeError);
      expect(readFileSync(path, 'utf8')).not.toContain('run finished: succeeded');
      expect(closeSyncMock).toHaveBeenCalledTimes(1);
    } finally {
      await sink.close().catch(() => undefined);
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
