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
import { createSessionOptionsForTesting, Session } from '../../src/engine/session.js';
import type { RunEvent } from '../../src/engine/events.js';
import { InternalError } from '../../src/errors.js';
import { resultV2Schema } from '../../src/results/schema.js';

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

    await expect(sink.close()).rejects.toMatchObject({
      code: 'RUNE-406',
      name: 'ExecutionError',
      cause: expect.any(Error),
    });
  });

  it('settles with a controlled error when finalizing the stream fails', async () => {
    const path = join(fs.mkdtempSync(join(tmpdir(), 'rune-log-')), 'run.log');
    mockedFs.streamFactory = (target) =>
      openedWritable(target, {
        write(_chunk, _encoding, callback) {
          callback();
        },
        final(callback) {
          callback(new Error('close failed'));
        },
      });
    const sink = await createLogFileSink(path);

    await expect(sink.close()).rejects.toMatchObject({
      code: 'RUNE-406',
      name: 'ExecutionError',
      cause: expect.any(Error),
    });
  });

  it('publishes one failure terminal with the actual topology after a late close failure', async () => {
    const directory = fs.mkdtempSync(join(tmpdir(), 'rune-log-'));
    const manifestPath = join(directory, 'installer.yaml');
    const logPath = join(directory, 'run.log');
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
    const session = await Session.open(
      manifestPath,
      createSessionOptionsForTesting(
        { environment: {}, logFile: logPath },
        {
          run: async (request) => {
            request.onOutput('stdout', 'installed');
            return { kind: 'exited', exitCode: 0 };
          },
        },
      ),
    );
    const events: RunEvent[] = [];

    await expect(session.execute((event) => events.push(event))).rejects.toMatchObject({
      code: 'RUNE-406',
      name: 'ExecutionError',
      cause: expect.any(Error),
    });

    expect(events.map((event) => event.kind)).toEqual([
      'runStarted',
      'stepStarted',
      'stepOutput',
      'stepFinished',
      'runFinished',
    ]);
    const terminals = events.filter((event) => event.kind === 'runFinished');
    expect(terminals).toHaveLength(1);
    const result = terminals[0]?.result;
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
      steps: [{ id: 'install', state: 'SUCCEEDED', command: ['node'] }],
    });
    expect(() => resultV2Schema.parse(result)).not.toThrow();
    expect(Object.isFrozen(result)).toBe(true);
    expect(terminals.some((event) => event.result.status === 'succeeded')).toBe(false);
  });

  it('preserves a runner contract failure when cleanup close also fails', async () => {
    const directory = fs.mkdtempSync(join(tmpdir(), 'rune-log-'));
    const manifestPath = join(directory, 'installer.yaml');
    const logPath = join(directory, 'run.log');
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
    const session = await Session.open(
      manifestPath,
      createSessionOptionsForTesting(
        { environment: {}, logFile: logPath },
        {
          run: async (request) => {
            request.onOutput('stdout', 'installed');
            return { kind: 'exited', exitCode: Number.NaN };
          },
        },
      ),
    );
    const events: RunEvent[] = [];
    let thrown: unknown;

    try {
      await session.execute((event) => events.push(event));
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(InternalError);
    expect(thrown).toMatchObject({ code: 'RUNE-500', name: InternalError.name });
    expect(events.map((event) => event.kind)).toEqual([
      'runStarted',
      'stepStarted',
      'stepOutput',
      'stepOutput',
      'stepFinished',
      'runFinished',
    ]);
    const terminals = events.filter((event) => event.kind === 'runFinished');
    expect(terminals).toHaveLength(1);
    const result = terminals[0]?.result;
    expect(result).toMatchObject({
      status: 'internal_error',
      exitCode: 70,
      error: { code: 'RUNE-500' },
      stepsTotal: 1,
      stepsExecuted: 1,
      stepsSucceeded: 0,
      stepsFailed: 1,
      stepsCancelled: 0,
      stepsSkipped: 0,
      stepsNotRun: 0,
      nothingExecuted: false,
      steps: [
        {
          id: 'install',
          state: 'FAILED',
          exitCode: null,
          command: ['node'],
          outputTail: [
            { stream: 'stdout', line: 'installed' },
            {
              stream: 'stderr',
              line: 'RUNE-500 runner returned an invalid outcome for step "install"',
            },
          ],
        },
      ],
    });
    expect(() => resultV2Schema.parse(result)).not.toThrow();
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result?.steps)).toBe(true);
    expect(Object.isFrozen(result?.steps[0]?.outputTail)).toBe(true);
    expect(terminals.some((event) => event.result.error?.code === 'RUNE-406')).toBe(false);
  });
});
