import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

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
});
