/**
 * Cooperative cancellation (docs/architecture.md §7).
 *
 * One flow for every frontend: the GUI's Cancel button, the CLI's first Ctrl+C and a
 * headless SIGTERM all end up here. The engine is async on the event loop, so a flag and a
 * listener list are all that is needed — no threads, no signals of its own.
 */

export class CancelToken {
  #cancelled = false;
  readonly #listeners = new Set<() => void>();

  get isCancelled(): boolean {
    return this.#cancelled;
  }

  /** Requests cancellation. Idempotent: the second call is a no-op, not a second event. */
  cancel(): void {
    if (this.#cancelled) {
      return;
    }
    this.#cancelled = true;
    const listeners = [...this.#listeners];
    this.#listeners.clear();
    for (const listener of listeners) {
      invokeListener(listener);
    }
  }

  /**
   * Runs `listener` on cancellation — immediately, when it already happened — and returns an
   * idempotent disposer for callers whose lifetime is shorter than the token's.
   */
  onCancel(listener: () => void): () => void {
    if (this.#cancelled) {
      invokeListener(listener);
      return () => undefined;
    }
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  }
}

/** Cancellation is best-effort: one cleanup failure must not block another. */
function invokeListener(listener: () => void): void {
  try {
    listener();
  } catch {
    // Listener errors have no cancellation recovery path and must not escape this boundary.
  }
}
