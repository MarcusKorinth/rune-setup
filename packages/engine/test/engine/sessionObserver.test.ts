import * as fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Writable, type WritableOptions } from 'node:stream';

import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockedFs = vi.hoisted(() => ({
  streamFactory: undefined as ((path: string) => unknown) | undefined,
}));

// Only the log file's stream is replaceable, so one test can make the engine-owned sink fail
// at finalization; every other test writes the real log file.
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof fs>();
  return {
    ...actual,
    createWriteStream(path: string, options?: Parameters<typeof actual.createWriteStream>[1]) {
      const factory = mockedFs.streamFactory;
      return factory === undefined ? actual.createWriteStream(path, options) : factory(path);
    },
  };
});

import { createSessionOptionsForTesting, Session } from '../../src/engine/session.js';
import type { RunEvent } from '../../src/engine/events.js';
import type { Runner } from '../../src/runners/base.js';

const okRunner: Runner = { run: async () => ({ kind: 'exited', exitCode: 0 }) };

/** Which events the broken frontend observer throws on. */
const brokenObservers = [
  ['the terminal event', (event: RunEvent) => event.kind === 'runFinished'],
  ['every event', () => true],
] as const;

function fixture(): { manifestPath: string; logPath: string } {
  const directory = fs.mkdtempSync(join(tmpdir(), 'rune-session-observer-'));
  const manifestPath = join(directory, 'installer.yaml');
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
  return { manifestPath, logPath: join(directory, 'run.log') };
}

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

beforeEach(() => {
  mockedFs.streamFactory = undefined;
});

describe('Session terminal delivery to a throwing observer', () => {
  it.each(brokenObservers)(
    'swallows an observer exception on %s (invariant 15) without changing the result or the log',
    async (_which, throwsOn) => {
      const { manifestPath, logPath } = fixture();
      const session = await Session.open(
        manifestPath,
        createSessionOptionsForTesting({ environment: {}, logFile: logPath }, okRunner),
      );
      const events: RunEvent[] = [];

      const result = await session.execute((event) => {
        events.push(event);
        if (throwsOn(event)) {
          throw new Error('broken renderer');
        }
      });

      expect(result).toMatchObject({
        status: 'succeeded',
        exitCode: 0,
        stepsTotal: 1,
        stepsExecuted: 1,
        stepsSucceeded: 1,
        stepsFailed: 0,
        nothingExecuted: false,
        steps: [{ id: 'install', state: 'SUCCEEDED', exitCode: 0 }],
      });
      expect(events.map((event) => event.kind)).toEqual([
        'runStarted',
        'stepStarted',
        'stepFinished',
        'runFinished',
      ]);
      const terminals = events.filter((event) => event.kind === 'runFinished');
      expect(terminals).toHaveLength(1);
      expect(terminals[0]?.result).toBe(result);
      const log = fs.readFileSync(logPath, 'utf8');
      expect(log).toContain('[install] SUCCEEDED');
      expect(log).toContain('run finished: succeeded (exit 0)');
    },
  );

  it.each(brokenObservers)(
    'keeps the RUNE-406 finalization failure when the observer throws on %s (invariant 15)',
    async (_which, throwsOn) => {
      const { manifestPath, logPath } = fixture();
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
        createSessionOptionsForTesting({ environment: {}, logFile: logPath }, okRunner),
      );
      const events: RunEvent[] = [];
      let thrown: unknown;

      try {
        await session.execute((event) => {
          events.push(event);
          if (throwsOn(event)) {
            throw new Error('broken renderer');
          }
        });
      } catch (error) {
        thrown = error;
      }

      expect(thrown).toMatchObject({
        code: 'RUNE-406',
        name: 'ExecutionError',
        cause: expect.any(Error),
      });
      expect(String((thrown as Error).message)).not.toContain('broken renderer');
      expect(events.map((event) => event.kind)).toEqual([
        'runStarted',
        'stepStarted',
        'stepFinished',
        'runFinished',
      ]);
      const terminals = events.filter((event) => event.kind === 'runFinished');
      expect(terminals).toHaveLength(1);
      expect(terminals[0]?.result).toMatchObject({
        status: 'failed',
        exitCode: 1,
        error: { code: 'RUNE-406' },
        stepsTotal: 1,
        stepsExecuted: 1,
        stepsSucceeded: 1,
        stepsFailed: 0,
        nothingExecuted: false,
        steps: [{ id: 'install', state: 'SUCCEEDED', exitCode: 0 }],
      });
    },
  );
});
