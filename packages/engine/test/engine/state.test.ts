import { describe, expect, it } from 'vitest';

import {
  isLegalTransition,
  isTerminal,
  STEP_STATES,
  transitionStepState,
  type StepState,
} from '../../src/engine/state.js';
import { InternalError } from '../../src/errors.js';

describe('step state lifecycle', () => {
  it('accepts exactly the legal transitions', () => {
    const legalTransitions = new Set([
      'PENDING->RUNNING',
      'PENDING->NOT_RUN',
      'RUNNING->SUCCEEDED',
      'RUNNING->FAILED',
      'RUNNING->CANCELLED',
    ]);

    for (const from of STEP_STATES) {
      for (const to of STEP_STATES) {
        const transition = `${from}->${to}`;
        expect(isLegalTransition(from, to), transition).toBe(legalTransitions.has(transition));
      }
    }
  });

  it('returns an allowed successor state', () => {
    expect(transitionStepState('PENDING', 'RUNNING')).toBe('RUNNING');
    expect(transitionStepState('PENDING', 'NOT_RUN')).toBe('NOT_RUN');
    expect(transitionStepState('RUNNING', 'SUCCEEDED')).toBe('SUCCEEDED');
    expect(transitionStepState('RUNNING', 'FAILED')).toBe('FAILED');
    expect(transitionStepState('RUNNING', 'CANCELLED')).toBe('CANCELLED');
  });

  it('rejects an illegal transition as an internal error', () => {
    expect(() => transitionStepState('PENDING', 'SUCCEEDED')).toThrow(InternalError);
    let caught: unknown;
    try {
      transitionStepState('SKIPPED', 'RUNNING');
    } catch (error) {
      caught = error;
    }
    expect(caught).toMatchObject({ code: 'RUNE-500' });
  });

  it('identifies exactly the terminal states', () => {
    const terminalStates = new Set<StepState>([
      'SKIPPED',
      'SUCCEEDED',
      'FAILED',
      'CANCELLED',
      'NOT_RUN',
    ]);

    for (const state of STEP_STATES) {
      expect(isTerminal(state), state).toBe(terminalStates.has(state));
    }
  });
});
