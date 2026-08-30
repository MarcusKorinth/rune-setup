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

import { run, type CliIo } from '../src/cli.js';

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

describe('late log finalization failure', () => {
  it('writes the engine terminal result with the actually executed step topology', async () => {
    const directory = fs.mkdtempSync(join(tmpdir(), 'rune-cli-log-'));
    const manifestPath = join(directory, 'installer.yaml');
    const logPath = join(directory, 'run.log');
    const resultPath = join(directory, 'result.json');
    fs.writeFileSync(
      manifestPath,
      [
        'schemaVersion: 1',
        'product:',
        '  name: Example',
        '  version: "1.0.0"',
        'steps:',
        '  - id: install',
        '    run:',
        '      command: node',
        '      args: ["-e", "process.exit(0)"]',
        '',
      ].join('\n'),
      'utf8',
    );
    mockedFs.streamFactory = (target) =>
      openedWritable(target, {
        write(_chunk, _encoding, callback) {
          callback();
        },
        final(callback) {
          callback(new Error('close failed'));
        },
      });
    const stdout: string[] = [];
    const stderr: string[] = [];
    const io: CliIo = {
      stdout: (line) => stdout.push(line),
      stderr: (line) => stderr.push(line),
    };

    const code = await run(
      ['run', manifestPath, '--non-interactive', '--log-file', logPath, '--result', resultPath],
      io,
    );

    expect(code).toBe(1);
    const result = JSON.parse(fs.readFileSync(resultPath, 'utf8')) as Record<string, unknown>;
    expect(result).toMatchObject({
      status: 'failed',
      exitCode: 1,
      stepsTotal: 1,
      stepsExecuted: 1,
      stepsSucceeded: 1,
      stepsFailed: 0,
      stepsSkipped: 0,
      stepsNotRun: 0,
      nothingExecuted: false,
      steps: [{ id: 'install', state: 'SUCCEEDED' }],
    });
    expect(stderr.join('\n')).toContain('failed: 1 succeeded');
    expect(stdout).toEqual([]);
  });
});
