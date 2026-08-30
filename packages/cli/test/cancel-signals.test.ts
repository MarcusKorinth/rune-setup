import { EventEmitter } from 'node:events';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { setTimeout as delay } from 'node:timers/promises';

import { describe, expect, it, vi } from 'vitest';

import { run } from '../src/cli.js';
import type { CliIo } from '../src/io.js';
import type { CancelSignal, Interaction, SignalSource } from '../src/prompt.js';

interface Capture extends CliIo {
  readonly out: string[];
  readonly err: string[];
}

class TestSignalSource implements SignalSource {
  readonly #events = new EventEmitter();

  on(signal: CancelSignal, listener: () => void): void {
    this.#events.on(signal, listener);
  }

  removeListener(signal: CancelSignal, listener: () => void): void {
    this.#events.removeListener(signal, listener);
  }

  emit(signal: CancelSignal): void {
    this.#events.emit(signal);
  }

  listenerCount(signal: CancelSignal): number {
    return this.#events.listenerCount(signal);
  }
}

function capture(): Capture {
  const out: string[] = [];
  const err: string[] = [];
  return { out, err, stdout: (line) => out.push(line), stderr: (line) => err.push(line) };
}

function interaction(signalSource: SignalSource, forceExit: (code: number) => void): Interaction {
  return {
    input: Readable.from([]),
    isTTY: false,
    write: () => undefined,
    forceExit,
    signalSource,
  };
}

function fixture(): { readonly manifestPath: string; readonly directory: string } {
  const directory = mkdtempSync(join(tmpdir(), 'rune-cli-signals-'));
  const manifestPath = join(directory, 'installer.yaml');
  writeFileSync(
    manifestPath,
    [
      'schemaVersion: 1',
      'product:',
      '  name: Signal test',
      '  version: "1.0.0"',
      'inputs: {}',
      'steps:',
      '  - id: long-running',
      '    title: Long running',
      '    run:',
      '      command: node',
      `      args: ["-e", "console.log('ready'); setInterval(() => undefined, 1000)"]`,
      '  - id: later',
      '    title: Later',
      '    run:',
      '      command: node',
      '      args: ["-e", "process.exit(0)"]',
      '',
    ].join('\n'),
    'utf8',
  );
  return { manifestPath, directory };
}

async function waitUntil(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (!predicate()) {
    if (Date.now() >= deadline) {
      throw new Error('timed out waiting for the long-running step');
    }
    await delay(10);
  }
}

function listenerCounts(signals: TestSignalSource): readonly [number, number] {
  return [signals.listenerCount('SIGINT'), signals.listenerCount('SIGTERM')];
}

function parsedResult(io: Capture): {
  readonly status: string;
  readonly exitCode: number;
  readonly stepsExecuted: number;
  readonly stepsCancelled: number;
  readonly stepsNotRun: number;
  readonly steps: readonly { readonly id: string; readonly state: string }[];
} {
  return JSON.parse(io.out.join('\n')) as ReturnType<typeof parsedResult>;
}

describe('CLI execution signals', () => {
  it('cancels an active run on the first SIGINT and returns the cancelled result', async () => {
    const { manifestPath, directory } = fixture();
    const localesDirectory = join(directory, 'locales');
    mkdirSync(localesDirectory);
    writeFileSync(
      join(localesDirectory, 'de.yaml'),
      'rune.run.cancelling: Abbruch wird ausgeführt\n',
      'utf8',
    );
    const io = capture();
    const signals = new TestSignalSource();
    const unrelatedSigint = (): void => undefined;
    const unrelatedSigterm = (): void => undefined;
    signals.on('SIGINT', unrelatedSigint);
    signals.on('SIGTERM', unrelatedSigterm);
    const before = listenerCounts(signals);
    const forceExit = vi.fn<(code: number) => void>();

    const completion = run(
      ['run', manifestPath, '--non-interactive', '--locale', 'de', '--result', '-'],
      io,
      interaction(signals, forceExit),
    );
    await waitUntil(() => io.err.includes('  ready'));
    expect(listenerCounts(signals)).toEqual([before[0] + 1, before[1] + 1]);

    signals.emit('SIGINT');
    const code = await completion;

    expect(code).toBe(6);
    expect(forceExit).not.toHaveBeenCalled();
    expect(io.err.filter((line) => line === 'Abbruch wird ausgeführt')).toHaveLength(1);
    expect(parsedResult(io)).toMatchObject({
      status: 'cancelled',
      exitCode: 6,
      stepsExecuted: 1,
      stepsCancelled: 1,
      stepsNotRun: 1,
      steps: [
        { id: 'long-running', state: 'CANCELLED' },
        { id: 'later', state: 'NOT_RUN' },
      ],
    });
    expect(listenerCounts(signals)).toEqual(before);
  });

  it('force-exits exactly once on a second SIGINT', async () => {
    const { manifestPath } = fixture();
    const io = capture();
    const signals = new TestSignalSource();
    const before = listenerCounts(signals);
    const forceExit = vi.fn<(code: number) => void>();

    const completion = run(
      ['run', manifestPath, '--non-interactive', '--result', '-'],
      io,
      interaction(signals, forceExit),
    );
    await waitUntil(() => io.err.includes('  ready'));

    signals.emit('SIGINT');
    signals.emit('SIGINT');
    const code = await completion;

    expect(code).toBe(6);
    expect(forceExit).toHaveBeenCalledTimes(1);
    expect(forceExit).toHaveBeenCalledWith(6);
    expect(listenerCounts(signals)).toEqual(before);
  });

  it('routes repeated SIGTERM through cancellation without force-exiting', async () => {
    const { manifestPath } = fixture();
    const io = capture();
    const signals = new TestSignalSource();
    const before = listenerCounts(signals);
    const forceExit = vi.fn<(code: number) => void>();

    const completion = run(
      ['run', manifestPath, '--non-interactive', '--result', '-'],
      io,
      interaction(signals, forceExit),
    );
    await waitUntil(() => io.err.includes('  ready'));

    signals.emit('SIGTERM');
    signals.emit('SIGTERM');
    const code = await completion;

    expect(code).toBe(6);
    expect(forceExit).not.toHaveBeenCalled();
    expect(parsedResult(io)).toMatchObject({
      status: 'cancelled',
      exitCode: 6,
      stepsCancelled: 1,
      stepsNotRun: 1,
    });
    expect(listenerCounts(signals)).toEqual(before);
  });

  it('force-exits only on the second SIGINT after SIGTERM requested cancellation', async () => {
    const { manifestPath } = fixture();
    const io = capture();
    const signals = new TestSignalSource();
    const before = listenerCounts(signals);
    const forceExit = vi.fn<(code: number) => void>();

    const completion = run(
      ['run', manifestPath, '--non-interactive', '--result', '-'],
      io,
      interaction(signals, forceExit),
    );
    await waitUntil(() => io.err.includes('  ready'));

    signals.emit('SIGTERM');
    signals.emit('SIGINT');
    expect(forceExit).not.toHaveBeenCalled();
    signals.emit('SIGINT');
    const code = await completion;

    expect(code).toBe(6);
    expect(forceExit).toHaveBeenCalledTimes(1);
    expect(forceExit).toHaveBeenCalledWith(6);
    expect(listenerCounts(signals)).toEqual(before);
  });

  it('removes both listeners when session execution rejects', async () => {
    const { manifestPath, directory } = fixture();
    const io = capture();
    const signals = new TestSignalSource();
    const before = listenerCounts(signals);
    const forceExit = vi.fn<(code: number) => void>();
    const logParentFile = join(directory, 'not-a-directory');
    writeFileSync(logParentFile, 'blocks recursive directory creation', 'utf8');

    const code = await run(
      ['run', manifestPath, '--non-interactive', '--log-file', join(logParentFile, 'run.log')],
      io,
      interaction(signals, forceExit),
    );

    expect(code).toBe(70);
    expect(io.err.join('\n')).toContain('internal error:');
    expect(listenerCounts(signals)).toEqual(before);
  });
});
