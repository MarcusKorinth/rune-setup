/**
 * Run events (docs/architecture.md §9.1).
 *
 * Engine events are in-process objects consumed by frontends and downstream sinks. A
 * transport such as the Electron IPC bridge projects them at its own serialization boundary.
 * Delivery is serial and awaited; `RunStarted` is first, `RunFinished` is last,
 * exactly once each.
 */

import type { ExecutionPlan } from './plan.js';
import type { RunResult } from '../results/model.js';

export interface RunStarted {
  readonly kind: 'runStarted';
  readonly plan: ExecutionPlan;
}

export interface StepStarted {
  readonly kind: 'stepStarted';
  readonly stepId: string;
  /** Position in the plan, counting every planned step — skipped ones included. */
  readonly index: number;
  readonly total: number;
  readonly title: string;
}

export interface StepOutput {
  readonly kind: 'stepOutput';
  readonly stepId: string;
  readonly stream: 'stdout' | 'stderr';
  /** Already masked: a secret never reaches an observer (§10). */
  readonly line: string;
}

interface StepFinishedBase {
  readonly kind: 'stepFinished';
  readonly stepId: string;
  readonly durationMs: number;
}

/** A terminal step event; its exit code is correlated with its terminal state. */
export type StepFinished =
  | (StepFinishedBase & {
      readonly state: 'SUCCEEDED';
      readonly exitCode: number;
    })
  | (StepFinishedBase & {
      readonly state: 'FAILED';
      readonly exitCode: number | undefined;
    })
  | (StepFinishedBase & {
      readonly state: 'SKIPPED' | 'CANCELLED' | 'NOT_RUN';
      readonly exitCode: undefined;
    });

export interface RunFinished {
  readonly kind: 'runFinished';
  readonly result: RunResult;
}

export type RunEvent = RunStarted | StepStarted | StepOutput | StepFinished | RunFinished;

/**
 * A returned native Promise delays the next event and applies backpressure to child
 * output. Other return values are ignored. Throws and rejections are contained per sink.
 */
export type EngineObserver = (event: RunEvent) => unknown;
