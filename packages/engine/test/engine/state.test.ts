import { describe, expect, it } from 'vitest';

import {
  isLegalTransition,
  isTerminal,
  STEP_STATES,
  type StepState,
} from '../../src/engine/state.js';

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
