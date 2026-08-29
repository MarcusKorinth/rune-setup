/**
 * Cooperative cancellation (docs/architecture.md §7).
 *
 * One flow for every frontend: the GUI's Cancel button, the CLI's first Ctrl+C and a
 * headless SIGTERM all end up here. The engine is async on the event loop, so a flag and a
 * listener list are all that is needed — no threads, no signals of its own.
 */

export class CancelToken {
  #cancelled = false;
  readonly #listeners: Array<() => void> = [];

  get cancelled(): boolean {
    return this.#cancelled;
  }

  /** Requests cancellation. Idempotent: the second call is a no-op, not a second event. */
  cancel(): void {
    if (this.#cancelled) {
      return;
    }
    this.#cancelled = true;
    for (const listener of this.#listeners.splice(0)) {
      listener();
    }
  }

  /** Runs `listener` on cancellation — immediately, when it already happened. */
  onCancel(listener: () => void): void {
    if (this.#cancelled) {
      listener();
      return;
    }
    this.#listeners.push(listener);
  }
}
