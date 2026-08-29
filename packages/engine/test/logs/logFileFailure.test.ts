import * as fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Writable, type WritableOptions } from 'node:stream';

import { describe, expect, it, vi } from 'vitest';

const mockedFs = vi.hoisted(() => ({
  streamFactory: undefined as ((path: string) => unknown) | undefined,
}));

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof fs>();
  return {
    ...actual,
    createWriteStream(path: string) {
      const factory = mockedFs.streamFactory;
      if (factory === undefined) {
        throw new Error('test stream factory was not configured');
      }
      return factory(path);
    },
  };
});

import { createLogFileSink } from '../../src/logs/logFile.js';

function openedWritable(path: string, options: WritableOptions): fs.WriteStream {
  const fd = fs.openSync(path, 'a');
  let closed = false;
  const stream = new Writable({
    ...options,
    destroy(cause, callback) {
      if (!closed) {
        fs.closeSync(fd);
        closed = true;
      }
      callback(cause);
    },
  });
  queueMicrotask(() => stream.emit('open', fd));
  return stream as fs.WriteStream;
}

describe('log-file sink failures', () => {
  it('settles with a controlled error when a buffered write fails', async () => {
    const path = join(fs.mkdtempSync(join(tmpdir(), 'rune-log-')), 'run.log');
    mockedFs.streamFactory = (target) =>
      openedWritable(target, {
        write(_chunk, _encoding, callback) {
          callback(new Error('disk full'));
        },
      });
    const sink = await createLogFileSink(path);

    sink.observer({
      kind: 'stepOutput',
      stepId: 'install',
      stream: 'stderr',
      line: 'failed',
    });

    await expect(sink.close()).rejects.toMatchObject({ code: 'RUNE-500' });
  });

  it('settles with a controlled error when finalizing the stream fails', async () => {
    const path = join(fs.mkdtempSync(join(tmpdir(), 'rune-log-')), 'run.log');
    mockedFs.streamFactory = (target) =>
      openedWritable(target, {
        final(callback) {
          callback(new Error('close failed'));
        },
      });
    const sink = await createLogFileSink(path);

    await expect(sink.close()).rejects.toMatchObject({ code: 'RUNE-500' });
  });
});
