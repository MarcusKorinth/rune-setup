import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

const logSink = vi.hoisted(() => {
  const state: {
    closeError: Error | undefined;
    closeCalled: boolean;
  } = { closeError: undefined, closeCalled: false };
  return {
    state,
    observer: vi.fn(),
    close: vi.fn(async () => {
      state.closeCalled = true;
      if (state.closeError !== undefined) {
        throw state.closeError;
      }
    }),
  };
});

vi.mock('../../src/logs/logFile.js', () => ({
  createLogFileSink: vi.fn(() => ({
    observer: logSink.observer,
    close: logSink.close,
  })),
}));

import { Session } from '../../src/engine/session.js';
import type { RunEvent } from '../../src/engine/events.js';
import type { Runner } from '../../src/runners/base.js';

const SECRET = 'finalization-secret';
const fixtureDirectories = new Set<string>();

function fixture(): string {
  const directory = mkdtempSync(join(tmpdir(), 'rune-log-finalization-'));
  fixtureDirectories.add(directory);
  const manifestPath = join(directory, 'installer.yaml');
  writeFileSync(
    manifestPath,
    [
      'schemaVersion: 1',
      'product:',
      '  name: Example',
      '  version: "1.0.0"',
      'inputs:',
      '  token:',
      '    type: secret',
      'steps:',
      '  - id: install',
      '    run:',
      '      command: node',
      '',
    ].join('\n'),
    'utf8',
  );
  return manifestPath;
}

beforeEach(() => {
  logSink.state.closeError = undefined;
  logSink.state.closeCalled = false;
  logSink.observer.mockClear();
  logSink.close.mockClear();
});

afterAll(() => {
  for (const directory of fixtureDirectories) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe('post-execution log finalization', () => {
  it('returns the real run as internal_error and publishes one matching final event', async () => {
    const manifestPath = fixture();
    const session = await Session.open(manifestPath, {
      environment: {},
      overrides: { token: SECRET },
      logFile: join(manifestPath, '..', 'run.log'),
      runner: { run: async () => ({ kind: 'exited', exitCode: 0 }) },
    });
    const events: RunEvent[] = [];
    const finalizedAfterClose: boolean[] = [];
    logSink.state.closeError = new Error(`flush failed for ${SECRET}`);

    const result = await session.execute((event) => {
      events.push(event);
      if (event.kind === 'runFinished') {
        finalizedAfterClose.push(logSink.state.closeCalled);
        throw new Error('observer failure');
      }
    });

    expect(result).toMatchObject({
      status: 'internal_error',
      exitCode: 70,
      stepsTotal: 1,
      stepsExecuted: 1,
      stepsSucceeded: 1,
      stepsFailed: 0,
      stepsNotRun: 0,
      nothingExecuted: false,
      steps: [{ id: 'install', state: 'SUCCEEDED' }],
      inputs: [{ id: 'token', value: null, secret: true }],
    });
    expect(result.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(result.startedAt).not.toBe('');
    expect(result.finishedAt).not.toBe('');
    expect(events.map((event) => event.kind)).toEqual([
      'runStarted',
      'stepStarted',
      'stepFinished',
      'runFinished',
    ]);
    const finalEvents = events.filter((event) => event.kind === 'runFinished');
    expect(finalEvents).toHaveLength(1);
    expect(finalEvents[0]?.result).toBe(result);
    expect(finalizedAfterClose).toEqual([true]);
    expect(session.warnings()).toEqual([
      expect.stringMatching(/could not finalize log file .*flush failed for \*\*\*/),
    ]);
    expect(session.warnings().join(' ')).not.toContain(SECRET);

    logSink.state.closeError = undefined;
    await expect(session.execute()).resolves.toMatchObject({ status: 'succeeded', exitCode: 0 });
    expect(session.warnings()).toEqual([]);
  });

  it('preserves a primary runner error when log close also fails', async () => {
    const primary = new Error('primary runner failure');
    const runner: Runner = {
      run: async () => {
        throw primary;
      },
    };
    const manifestPath = fixture();
    const session = await Session.open(manifestPath, {
      environment: {},
      overrides: { token: SECRET },
      logFile: join(manifestPath, '..', 'run.log'),
      runner,
    });
    logSink.state.closeError = new Error(`flush failed for ${SECRET}`);

    await expect(session.execute()).rejects.toBe(primary);

    expect(logSink.close).toHaveBeenCalledOnce();
    expect(session.warnings().join(' ')).toMatch(/flush failed for \*\*\*/);
    expect(session.warnings().join(' ')).not.toContain(SECRET);
  });
});
