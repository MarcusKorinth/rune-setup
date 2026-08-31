import { describe, expect, it, vi } from 'vitest';

import { CancelToken } from '../../src/engine/cancel.js';

const _checkCancelListenerReturnContract = (): void => {
  const token = new CancelToken();
  token.onCancel(() => undefined);
  // @ts-expect-error async listeners violate the synchronous cancellation contract
  token.onCancel(async () => undefined);
};
void _checkCancelListenerReturnContract;

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

  it.each(['first', 'middle'] as const)(
    'continues synchronous listener delivery when the %s listener throws',
    (throwingPosition) => {
      const token = new CancelToken();
      const first = vi.fn();
      const throwing = vi.fn(() => {
        throw new Error('listener failed');
      });
      const healthy = vi.fn();

      if (throwingPosition === 'first') {
        token.onCancel(throwing);
      } else {
        token.onCancel(first);
        token.onCancel(throwing);
      }
      token.onCancel(healthy);

      expect(() => token.cancel()).not.toThrow();
      expect(first).toHaveBeenCalledTimes(throwingPosition === 'middle' ? 1 : 0);
      expect(throwing).toHaveBeenCalledOnce();
      expect(healthy).toHaveBeenCalledOnce();
    },
  );

  it('contains a rejected promise from a registered listener and continues synchronously', () => {
    const token = new CancelToken();
    const order: string[] = [];
    const rejection = Promise.reject(new Error('listener failed'));
    const then = vi.spyOn(rejection, 'then');
    const rejected = vi.fn(() => {
      order.push('rejected');
      return rejection;
    });
    const healthy = vi.fn(() => {
      order.push('healthy');
      return undefined;
    });

    token.onCancel(rejected as unknown as () => undefined);
    token.onCancel(healthy);

    expect(() => token.cancel()).not.toThrow();
    expect(order).toEqual(['rejected', 'healthy']);
    expect(rejected).toHaveBeenCalledOnce();
    expect(healthy).toHaveBeenCalledOnce();
    expect(then).toHaveBeenCalledWith(undefined, expect.any(Function));
  });

  it('runs an already-cancelled subscription immediately and returns a no-op disposer', () => {
    const token = new CancelToken();
    const listener = vi.fn();
    expect(token.isCancelled).toBe(false);
    token.cancel();
    expect(token.isCancelled).toBe(true);

    const unsubscribe = token.onCancel(listener);
    unsubscribe();
    unsubscribe();

    expect(listener).toHaveBeenCalledOnce();
  });

  it('contains a throwing listener subscribed after cancellation and returns its disposer', () => {
    const token = new CancelToken();
    const listener = vi.fn(() => {
      throw new Error('listener failed');
    });
    token.cancel();

    let unsubscribe: (() => void) | undefined;
    expect(() => {
      unsubscribe = token.onCancel(listener);
    }).not.toThrow();
    expect(listener).toHaveBeenCalledOnce();
    expect(unsubscribe).toBeTypeOf('function');
    expect(() => unsubscribe?.()).not.toThrow();
  });

  it('contains a rejected promise delivered after cancellation and returns immediately', () => {
    const token = new CancelToken();
    token.cancel();
    const rejection = Promise.reject(new Error('listener failed'));
    const then = vi.spyOn(rejection, 'then');
    const rejected = vi.fn(() => rejection);
    const healthy = vi.fn(() => undefined);

    const unsubscribe = token.onCancel(rejected as unknown as () => undefined);
    token.onCancel(healthy);

    expect(rejected).toHaveBeenCalledOnce();
    expect(healthy).toHaveBeenCalledOnce();
    expect(then).toHaveBeenCalledWith(undefined, expect.any(Function));
    expect(unsubscribe).toBeTypeOf('function');
    expect(() => unsubscribe()).not.toThrow();
  });
});
