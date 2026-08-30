import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import type { RunFinished } from '../../src/engine/events.js';
import { createLogFileSink } from '../../src/logs/logFile.js';

describe('log-file sink lifecycle', () => {
  it('returns one close promise and settles it after the stream closes', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'rune-log-file-'));
    const sink = createLogFileSink(join(directory, 'run.log'));

    try {
      const close = sink.close();

      expect(sink.close()).toBe(close);
      await expect(close).resolves.toBeUndefined();
    } finally {
      await sink.close().catch(() => undefined);
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('writes an optional final event once while keeping close idempotent', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'rune-log-file-'));
    const path = join(directory, 'run.log');
    const sink = createLogFileSink(path);
    const finalEvent = {
      kind: 'runFinished',
      result: { status: 'succeeded', exitCode: 0 } as RunFinished['result'],
    } satisfies RunFinished;

    try {
      const close = sink.close(finalEvent);

      expect(sink.close(finalEvent)).toBe(close);
      await expect(close).resolves.toBeUndefined();
      expect(readFileSync(path, 'utf8').match(/run finished:/g)).toHaveLength(1);
      expect(readFileSync(path, 'utf8')).toContain('run finished: succeeded (exit 0)');
    } finally {
      await sink.close().catch(() => undefined);
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
