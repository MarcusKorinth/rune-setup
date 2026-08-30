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

    // A registry entry is engine-owned after registration. Read each property once so a
    // caller-owned accessor cannot make type behaviour change between resolutions.
    const snapshot = {
      name,
      secret: handler.secret,
      empty: handler.empty,
      isAbsent: handler.isAbsent,
      fromString: handler.fromString,
      fromNative: handler.fromNative,
      render: handler.render,
      compare: handler.compare,
    };

    if (typeof snapshot.secret !== 'boolean') {
      throw new InternalError('the input type handler field "secret" must be a boolean');
    }
    for (const [field, operation] of Object.entries({
      empty: snapshot.empty,
      isAbsent: snapshot.isAbsent,
      fromString: snapshot.fromString,
      fromNative: snapshot.fromNative,
      render: snapshot.render,
      compare: snapshot.compare,
    })) {
      if (typeof operation !== 'function') {
        throw new InternalError(`the input type handler field "${field}" must be a function`);
      }
    }

    this.#handlers.set(name, Object.freeze(snapshot));
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
