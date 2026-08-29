import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { createLogFileSink } from '../../src/logs/logFile.js';

describe('log-file sink', () => {
  it('flushes buffered events before close settles', async () => {
    const path = join(mkdtempSync(join(tmpdir(), 'rune-log-')), 'run.log');
    const sink = await createLogFileSink(path);

    sink.observer({
      kind: 'stepOutput',
      stepId: 'install',
      stream: 'stdout',
      line: 'complete',
    });
    await sink.close();
    await sink.close();

    expect(readFileSync(path, 'utf8')).toContain('[install:stdout] complete');
  });
});
