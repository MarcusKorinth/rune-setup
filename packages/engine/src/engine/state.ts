/**
 * Step lifecycle (docs/architecture.md §7).
 *
 * Every step reaches exactly one terminal state exactly once; the legal transitions are a
 * table rather than prose, so the executor can assert them instead of promising them.
 */

import { InternalError } from '../errors.js';

export const STEP_STATES = [
  'PENDING',
  'SKIPPED',
  'RUNNING',
  'SUCCEEDED',
  'FAILED',
  'CANCELLED',
  'NOT_RUN',
] as const;

export type StepState = (typeof STEP_STATES)[number];

/** The transitions the lifecycle allows. `SKIPPED` is assigned at plan time, terminal from birth. */
const LEGAL: ReadonlyMap<StepState, readonly StepState[]> = new Map([
  ['PENDING', ['RUNNING', 'NOT_RUN']],
  ['RUNNING', ['SUCCEEDED', 'FAILED', 'CANCELLED']],
]);

export function isLegalTransition(from: StepState, to: StepState): boolean {
  return LEGAL.get(from)?.includes(to) ?? false;
}

/**
 * Moves an executing step through the lifecycle table, failing closed when the executor
 * attempts an impossible transition.
 */
export function transitionStepState(from: StepState, to: StepState): StepState {
  if (!isLegalTransition(from, to)) {
    throw new InternalError(`illegal step state transition from ${from} to ${to}`);
  }
  return to;
}

/** A state no step leaves again. */
export function isTerminal(state: StepState): boolean {
  return state !== 'PENDING' && state !== 'RUNNING';
}
