import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { createLogFileSink } from '../../src/logs/logFile.js';

describe('log-file sink', () => {
  it('maps asynchronous directory preparation failures to RUNE-406', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'rune-log-'));
    const parentFile = join(directory, 'not-a-directory');
    const path = join(parentFile, 'run.log');
    writeFileSync(parentFile, 'occupied', 'utf8');

    await expect(createLogFileSink(path)).rejects.toMatchObject({
      code: 'RUNE-406',
      name: 'ExecutionError',
      message: expect.stringContaining('prepare the directory'),
      cause: expect.any(Error),
    });
  });

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

  it('keeps untrusted event text on one timestamped physical line', async () => {
    const path = join(mkdtempSync(join(tmpdir(), 'rune-log-')), 'run.log');
    const sink = await createLogFileSink(path);

    sink.observer({
      kind: 'stepStarted',
      stepId: 'install',
      index: 0,
      total: 1,
      title: 'Install\r\nforged\u2028record\u0001',
    });
    sink.observer({
      kind: 'stepOutput',
      stepId: 'install',
      stream: 'stdout',
      line: 'ordinary output',
    });
    sink.observer({
      kind: 'stepOutput',
      stepId: 'install',
      stream: 'stderr',
      line: 'output\r\nforged\u2029record\u0002',
    });
    await sink.close();

    const lines = readFileSync(path, 'utf8').trimEnd().split('\n');
    expect(lines).toHaveLength(3);
    expect(lines.every((line) => /^\d{4}-\d{2}-\d{2}T.*Z /.test(line))).toBe(true);
    expect(lines[0]).toContain('Install\\r\\nforged\\u2028record\\u0001');
    expect(lines[1]).toContain('[install:stdout] ordinary output');
    expect(lines[2]).toContain('output\\r\\nforged\\u2029record\\u0002');
  });

  it('masks a match created by the complete step-output prefix', async () => {
    const path = join(mkdtempSync(join(tmpdir(), 'rune-log-')), 'run.log');
    const marker = 'install:stdout';
    const sink = await createLogFileSink(path, (line) => line.replaceAll(marker, '***'));

    sink.observer({
      kind: 'stepOutput',
      stepId: 'install',
      stream: 'stdout',
      line: 'complete',
    });
    await sink.close();

    const log = readFileSync(path, 'utf8');
    expect(log).not.toContain(marker);
    expect(log).toContain('[***] complete');
  });
});
