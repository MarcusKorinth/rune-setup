import { describe, expect, it, vi } from 'vitest';

import { CancelToken } from '../../src/engine/cancel.js';

describe('CancelToken', () => {
  it('removes a listener through an idempotent disposer', () => {
    const token = new CancelToken();
    const listener = vi.fn();

    const unsubscribe = token.onCancel(listener);
    unsubscribe();
    unsubscribe();
    token.cancel();

    expect(listener).not.toHaveBeenCalled();
  });

  it('delivers cancellation once and clears the registered listeners', () => {
    const token = new CancelToken();
    const first = vi.fn();
    const second = vi.fn();
    const unsubscribeFirst = token.onCancel(first);
    token.onCancel(second);

    token.cancel();
    token.cancel();
    unsubscribeFirst();

    expect(first).toHaveBeenCalledOnce();
    expect(second).toHaveBeenCalledOnce();
  });

  it('runs an already-cancelled subscription immediately and returns a no-op disposer', () => {
    const token = new CancelToken();
    const listener = vi.fn();
    token.cancel();

    const unsubscribe = token.onCancel(listener);
    unsubscribe();
    unsubscribe();

    expect(listener).toHaveBeenCalledOnce();
  });
});
