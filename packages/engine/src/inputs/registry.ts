/**
 * The input-type registry (docs/architecture.md §13).
 *
 * A plain name-to-handler map today, and the seam a plugin system would extend later. It is
 * the engine-side authority: a frontend renders a type it finds here, and fails fast on one
 * it does not, rather than falling back to something that only looks like it works.
 */

import { InternalError } from '../errors.js';
import type { InputType } from '../manifest/v1/schema.js';
import type { InputTypeHandler } from './base.js';
import { BUILT_IN_INPUT_TYPES } from './builtin.js';

export class InputTypeRegistry {
  readonly #handlers = new Map<string, InputTypeHandler>();

  constructor(handlers: Iterable<InputTypeHandler> = []) {
    for (const handler of handlers) {
      this.register(handler);
    }
  }

  /** Adds a handler. Registering a name twice is a bug, not a silent replacement. */
  register(handler: InputTypeHandler): void {
    const name = handler.name;
    if (this.#handlers.has(name)) {
      throw new InternalError(`the input type "${name}" is registered twice`);
    }
    Object.freeze(handler);
    this.#handlers.set(name, handler);
  }

  has(name: string): boolean {
    return this.#handlers.has(name);
  }

  /** The handler for a type. Asking for one that is not registered is a bug. */
  get(name: InputType): InputTypeHandler {
    const handler = this.#handlers.get(name);
    if (handler === undefined) {
      throw new InternalError(`no handler is registered for the input type "${name}"`);
    }
    return handler;
  }

  /** Every registered type name, for the check a frontend does when a session opens (§9.3). */
  names(): readonly string[] {
    return [...this.#handlers.keys()];
  }
}

/** The registry the engine uses: the seven types of the MVP. */
export const inputTypes = new InputTypeRegistry(BUILT_IN_INPUT_TYPES);
