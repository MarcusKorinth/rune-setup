/**
 * The log-file sink (docs/architecture.md §10): one of the two sinks off the one event
 * stream. Timestamped lines, step output prefixed `[stepId:stdout]`. Lines arrive already
 * masked — the executor masks before any observer sees them.
 */

import { createWriteStream, mkdirSync, type WriteStream } from 'node:fs';
import { dirname } from 'node:path';

import type { EngineObserver, RunEvent } from '../engine/events.js';

export interface LogFileSink {
  readonly observer: EngineObserver;
  /** Flushes and closes the file; call once, after the run settled. */
  close(): Promise<void>;
}

export function createLogFileSink(path: string): LogFileSink {
  mkdirSync(dirname(path), { recursive: true });
  const stream: WriteStream = createWriteStream(path, { flags: 'a', encoding: 'utf8' });

  return {
    observer: (event) => {
      stream.write(`${new Date().toISOString()} ${describe(event)}\n`);
    },
    close: () =>
      new Promise((resolve) => {
        stream.end(() => resolve());
      }),
  };
}

function describe(event: RunEvent): string {
  switch (event.kind) {
    case 'runStarted':
      return `run started: ${event.plan.steps.length} steps, platform ${event.plan.platform}`;
    case 'stepStarted':
      return `[${event.stepId}] started (${event.index + 1}/${event.total}): ${event.title}`;
    case 'stepOutput':
      return `[${event.stepId}:${event.stream}] ${event.line}`;
    case 'stepFinished':
      return `[${event.stepId}] ${event.state}${
        event.exitCode === undefined ? '' : ` (exit ${event.exitCode})`
      } after ${event.durationMs}ms`;
    case 'runFinished':
      return `run finished: ${event.result.status} (exit ${event.result.exitCode})`;
  }
}
