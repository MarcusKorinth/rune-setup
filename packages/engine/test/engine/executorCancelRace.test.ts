import { resolve as resolvePath } from 'node:path';

import { describe, expect, it } from 'vitest';

import { CancelToken } from '../../src/engine/cancel.js';
import { createRuntimeContext, hostPlatform } from '../../src/engine/context.js';
import type { RunEvent } from '../../src/engine/events.js';
import { executeRun } from '../../src/engine/executor.js';
import { resolveInputs } from '../../src/engine/inputs.js';
import { buildPlan, type ExecutionPlan } from '../../src/engine/plan.js';
import { parseManifestText } from '../../src/manifest/index.js';
import type { Runner, SpawnOutcome, SpawnRequest } from '../../src/runners/base.js';
import type { RunResult } from '../../src/results/model.js';
import { resultV2Schema } from '../../src/results/schema.js';

/** What a console-attached Windows child reports after a console Ctrl+C (0xC000013A). */
const STATUS_CONTROL_C_EXIT = 3221225786;

const HEAD = ['schemaVersion: 1', 'product:', '  name: Example', '  version: "1.0.0"'];
const TEST_MANIFEST_DIR = resolvePath('/project');

function planOf(lines: readonly string[]): ExecutionPlan {
  const manifest = parseManifestText([...HEAD, ...lines, ''].join('\n'), 'installer.yaml', {
    manifestDir: TEST_MANIFEST_DIR,
  });
  const context = createRuntimeContext({
    manifestDir: TEST_MANIFEST_DIR,
    product: manifest.product,
    platform: hostPlatform(),
    environment: {},
  });
  return buildPlan({
    manifest,
    resolution: resolveInputs({ manifest, context }),
    context,
    locale: 'en',
  });
}

function stubRunner(behave: (request: SpawnRequest) => SpawnOutcome): Runner {
  return { run: async (request) => behave(request) };
}

/** The fields of a result that do not depend on clocks or identifiers. */
function comparableShape(result: RunResult): unknown {
  return {
    status: result.status,
    exitCode: result.exitCode,
    error: result.error,
    stepsExecuted: result.stepsExecuted,
    stepsCancelled: result.stepsCancelled,
    stepsFailed: result.stepsFailed,
    stepsNotRun: result.stepsNotRun,
    steps: result.steps.map(({ durationMs: _durationMs, ...step }) => step),
  };
}

const TWO_STEPS = [
  'steps:',
  '  - id: running',
  '    run:',
  '      command: a',
  '  - id: after',
  '    run:',
  '      command: b',
];

describe('a step whose process ends after cancellation was requested', () => {
  it('is CANCELLED on a non-success exit, in the shape of a runner-reported cancellation', async () => {
    const cancel = new CancelToken();
    const events: RunEvent[] = [];
    let calls = 0;

    const result = await executeRun({
      plan: planOf(TWO_STEPS),
      mode: 'non-interactive',
      cancel,
      observer: (event) => events.push(event),
      runner: stubRunner((request) => {
        calls += 1;
        request.cancel.cancel();
        return { kind: 'exited', exitCode: STATUS_CONTROL_C_EXIT };
      }),
    });

    expect(calls).toBe(1);
    expect(resultV2Schema.safeParse(result).success).toBe(true);
    expect(result).toMatchObject({
      status: 'cancelled',
      exitCode: 6,
      error: { code: 'RUNE-601' },
      stepsExecuted: 1,
      stepsFailed: 0,
      stepsCancelled: 1,
      stepsNotRun: 1,
    });
    expect(result.steps.map((step) => step.state)).toEqual(['CANCELLED', 'NOT_RUN']);
    expect(result.steps[0]).toMatchObject({ state: 'CANCELLED', exitCode: null });
    expect(result.steps[0]).not.toHaveProperty('outputTail');
    expect(events.map((event) => event.kind)).toEqual([
      'runStarted',
      'stepStarted',
      'stepFinished',
      'stepFinished',
      'runFinished',
    ]);
    expect(events[2]).toMatchObject({
      kind: 'stepFinished',
      state: 'CANCELLED',
      exitCode: undefined,
    });

    const runnerReported = await executeRun({
      plan: planOf(TWO_STEPS),
      mode: 'non-interactive',
      cancel: new CancelToken(),
      runner: stubRunner((request) => {
        request.cancel.cancel();
        return { kind: 'cancelled' };
      }),
    });
    expect(comparableShape(result)).toEqual(comparableShape(runnerReported));
  });

  it('stays SUCCEEDED on a success exit, and the run is cancelled before the next step', async () => {
    const cancel = new CancelToken();

    const result = await executeRun({
      plan: planOf(TWO_STEPS),
      mode: 'non-interactive',
      cancel,
      runner: stubRunner((request) => {
        request.cancel.cancel();
        return { kind: 'exited', exitCode: 0 };
      }),
    });

    expect(resultV2Schema.safeParse(result).success).toBe(true);
    expect(result).toMatchObject({
      status: 'cancelled',
      exitCode: 6,
      stepsExecuted: 1,
      stepsSucceeded: 1,
      stepsCancelled: 0,
      stepsNotRun: 1,
    });
    expect(result.steps.map((step) => step.state)).toEqual(['SUCCEEDED', 'NOT_RUN']);
    expect(result.steps[0]).toMatchObject({ state: 'SUCCEEDED', exitCode: 0 });
  });

  it('keeps an earlier failure ahead of the cancellation without failFast', async () => {
    const cancel = new CancelToken();
    let calls = 0;

    const result = await executeRun({
      plan: planOf([
        'execution:',
        '  failFast: false',
        ...TWO_STEPS,
        '  - id: last',
        '    run:',
        '      command: c',
      ]),
      mode: 'non-interactive',
      cancel,
      runner: stubRunner((request) => {
        calls += 1;
        if (calls === 1) {
          return { kind: 'exited', exitCode: 1 };
        }
        request.cancel.cancel();
        return { kind: 'exited', exitCode: STATUS_CONTROL_C_EXIT };
      }),
    });

    expect(calls).toBe(2);
    expect(resultV2Schema.safeParse(result).success).toBe(true);
    expect(result).toMatchObject({
      status: 'failed',
      exitCode: 1,
      stepsFailed: 1,
      stepsCancelled: 1,
      stepsNotRun: 1,
    });
    expect(result.steps.map((step) => step.state)).toEqual(['FAILED', 'CANCELLED', 'NOT_RUN']);
  });
});
