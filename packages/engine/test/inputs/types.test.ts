import { describe, expect, it, vi } from 'vitest';

import { InternalError } from '../../src/errors.js';
import { SecretString } from '../../src/engine/secrets.js';
import { InputTypeRegistry, inputTypes } from '../../src/inputs/registry.js';
import { MAX_PATTERN_INPUT_BYTES } from '../../src/inputs/builtin.js';
import type { InputTypeHandler } from '../../src/inputs/base.js';
import { INPUT_TYPES, type InputSpec, type InputType } from '../../src/manifest/v1/schema.js';

/** A spec of the given type with whatever extra fields a test needs. */
function spec(type: InputType, extra: Record<string, unknown> = {}): InputSpec {
  return { type, required: true, ...extra } as InputSpec;
}

function handler(type: InputType): InputTypeHandler {
  return inputTypes.get(type);
}

/** The value a handler produced, or the message it refused with. */
function from(type: InputType, text: string, extra?: Record<string, unknown>): unknown {
  const result = handler(type).fromString(text, spec(type, extra));
  return result.ok ? result.value : result.message;
}

describe('the registry', () => {
  it('has a handler for every type the manifest schema accepts', () => {
    expect([...inputTypes.names()].sort()).toEqual([...INPUT_TYPES].sort());
  });

  it('refuses to register a name twice, rather than replacing it silently', () => {
    const registry = new InputTypeRegistry([handler('text')]);

    expect(() => registry.register(handler('text'))).toThrow(/registered twice/);
  });

  it('snapshots every handler property once under the stable registered name', () => {
    const booleanHandler = handler('boolean');
    const registry = new InputTypeRegistry([booleanHandler]);
    const textHandler = handler('text');
    const reads = {
      name: 0,
      secret: 0,
      empty: 0,
      isAbsent: 0,
      fromString: 0,
      fromNative: 0,
      render: 0,
      compare: 0,
    };
    const firstFromString = vi.fn(textHandler.fromString);
    const replacementFromString = vi.fn(() => ({ ok: true, value: 'replacement' }) as const);
    const changingHandler: InputTypeHandler = {
      get name() {
        reads.name += 1;
        return reads.name === 1 ? 'text' : 'boolean';
      },
      get secret() {
        reads.secret += 1;
        return reads.secret === 1 ? false : true;
      },
      get empty() {
        reads.empty += 1;
        return textHandler.empty;
      },
      get isAbsent() {
        reads.isAbsent += 1;
        return textHandler.isAbsent;
      },
      get fromString() {
        reads.fromString += 1;
        return reads.fromString === 1 ? firstFromString : replacementFromString;
      },
      get fromNative() {
        reads.fromNative += 1;
        return textHandler.fromNative;
      },
      get render() {
        reads.render += 1;
        return textHandler.render;
      },
      get compare() {
        reads.compare += 1;
        return textHandler.compare;
      },
    };

    registry.register(changingHandler);
    const registered = registry.get('text');

    expect(reads).toEqual({
      name: 1,
      secret: 1,
      empty: 1,
      isAbsent: 1,
      fromString: 1,
      fromNative: 1,
      render: 1,
      compare: 1,
    });
    expect(registered).not.toBe(changingHandler);
    expect(registered.secret).toBe(false);
    expect(registry.get('text')).toBe(registered);
    expect(registered.fromString('original', spec('text'))).toEqual({
      ok: true,
      value: 'original',
    });
    expect(firstFromString).toHaveBeenCalledOnce();
    expect(replacementFromString).not.toHaveBeenCalled();
    expect(registry.get('boolean')).not.toBe(booleanHandler);
    expect(registry.get('boolean').name).toBe('boolean');
    expect(registry.names()).toEqual(['boolean', 'text']);
  });

  it('reads only a duplicate handler name and does not read its other fields', () => {
    const registry = new InputTypeRegistry([handler('text')]);
    let nameReads = 0;
    const duplicate = {
      get name() {
        nameReads += 1;
        return nameReads === 1 ? 'text' : 'boolean';
      },
    } as InputTypeHandler;
    for (const field of [
      'secret',
      'empty',
      'isAbsent',
      'fromString',
      'fromNative',
      'render',
      'compare',
    ] as const) {
      Object.defineProperty(duplicate, field, {
        get: () => {
          throw new Error(`${field} must not be read`);
        },
      });
    }

    expect(() => registry.register(duplicate)).toThrow('the input type "text" is registered twice');
    expect(nameReads).toBe(1);
    expect(registry.names()).toEqual(['text']);
  });

  it('keeps a frozen snapshot when its original handler is later changed', () => {
    const registry = new InputTypeRegistry();
    const mutableHandler = { ...handler('text') };
    const replacement = vi.fn(() => ({ ok: true, value: 'replaced' }) as const);

    registry.register(mutableHandler);
    const registered = registry.get('text');

    expect(Object.isFrozen(mutableHandler)).toBe(false);
    expect(Object.isFrozen(registered)).toBe(true);
    expect(Reflect.set(mutableHandler, 'name', 'boolean')).toBe(true);
    expect(Reflect.set(mutableHandler, 'fromString', replacement)).toBe(true);
    expect(registry.names()).toEqual(['text']);
    expect(registered.fromString('original', spec('text'))).toEqual({
      ok: true,
      value: 'original',
    });
    expect(replacement).not.toHaveBeenCalled();
  });

  it.each([
    ['secret', 'not a boolean'],
    ['empty', undefined],
    ['isAbsent', undefined],
    ['fromString', undefined],
    ['fromNative', undefined],
    ['render', undefined],
    ['compare', undefined],
  ] as const)(
    'rejects a handler with an invalid %s field without registering it',
    (field, value) => {
      const registry = new InputTypeRegistry();
      const invalid = { ...handler('text'), [field]: value } as unknown as InputTypeHandler;

      expect(() => registry.register(invalid)).toThrow(InternalError);
      expect(() => registry.register(invalid)).toThrow(`input type handler field "${field}"`);
      expect(registry.has('text')).toBe(false);
    },
  );

  it('treats asking for an unregistered type as a bug', () => {
    expect(() => new InputTypeRegistry().get('text')).toThrow(/no handler is registered/);
  });
});

describe('text', () => {
  it('takes any text when no pattern constrains it', () => {
    expect(from('text', 'anything at all')).toBe('anything at all');
  });

  it('matches a pattern whole, not merely somewhere', () => {
    expect(from('text', '8080', { pattern: '[0-9]{2,5}' })).toBe('8080');
    expect(from('text', 'port 8080', { pattern: '[0-9]{2,5}' })).toBe(
      '"port 8080" does not match [0-9]{2,5}',
    );
  });

  it('says what the author wanted when a hint is given', () => {
    expect(from('text', 'x', { pattern: '[0-9]+', patternHint: 'digits only' })).toBe(
      '"x": digits only',
    );
  });

  it('refuses an over-long value before the pattern runs, without echoing it', () => {
    const long = 'a'.repeat(MAX_PATTERN_INPUT_BYTES + 1);
    const message = from('text', long, { pattern: '(a+)+$' });

    expect(message).toBe(
      `the value is longer than the ${MAX_PATTERN_INPUT_BYTES} bytes a checked value may have`,
    );
    expect(String(message)).not.toContain('aaaa');
  });

  it('is empty when nothing set it', () => {
    expect(handler('text').empty(spec('text'))).toBe('');
  });
});

describe('secret', () => {
  it('wraps its value so it cannot be printed by accident', () => {
    const result = handler('secret').fromString('hunter2', spec('secret'));
    const value = result.ok ? result.value : undefined;

    expect(value).toBeInstanceOf(SecretString);
    expect(String(value)).toBe('***');
    expect(`${String(value)}`).not.toContain('hunter2');
    expect(JSON.stringify({ value })).toBe('{"value":null}');
    expect((value as SecretString).reveal()).toBe('hunter2');
  });

  it('never echoes the value it refuses', () => {
    const result = handler('secret').fromNative(1234, spec('secret'));

    expect(result.ok).toBe(false);
    expect(result.ok ? '' : result.message).toBe('the value is not text');
  });

  it('copies a subclass private value without calling its changing reveal override', () => {
    let revealCalls = 0;
    class ChangingSecret extends SecretString {
      override reveal(): string {
        revealCalls += 1;
        return revealCalls === 1 ? 'alpha-secret' : 'omega-secret';
      }
    }
    const supplied = new ChangingSecret('stable-secret');
    const result = handler('secret').fromNative(supplied, spec('secret'));
    const normalized = result.ok ? result.value : undefined;

    expect(normalized).toBeInstanceOf(SecretString);
    expect(normalized).not.toBe(supplied);
    expect(Object.getPrototypeOf(normalized)).toBe(SecretString.prototype);
    expect((normalized as SecretString).reveal()).toBe('stable-secret');
    expect(revealCalls).toBe(0);
  });

  it('copies the private value without reading shadowed reveal or length properties', () => {
    const supplied = new SecretString('stable-secret');
    let revealCalls = 0;
    Object.defineProperty(supplied, 'reveal', {
      value: () => {
        revealCalls += 1;
        return 'decoy-secret';
      },
    });
    Object.defineProperty(supplied, 'length', {
      get: () => {
        throw new Error('must not read shadowed length');
      },
    });

    const result = handler('secret').fromNative(supplied, spec('secret'));
    const normalized = result.ok ? result.value : undefined;

    expect((normalized as SecretString).reveal()).toBe('stable-secret');
    expect(revealCalls).toBe(0);
  });

  it('rejects proxies, forged brands, and non-string private values without throwing', () => {
    const proxied = new Proxy(new SecretString('proxy-secret'), {});
    const forged = Object.create(SecretString.prototype) as SecretString;
    const nonString = new SecretString(1234 as unknown as string);

    for (const value of [proxied, forged, nonString]) {
      expect(() => handler('secret').fromNative(value, spec('secret'))).not.toThrow();
      expect(handler('secret').fromNative(value, spec('secret'))).toEqual({
        ok: false,
        message: 'the value is not text',
      });
    }
  });

  it('renders the mask, never the secret', () => {
    const value = new SecretString('hunter2');

    // A secret reaches a command as the wrapper itself and is unwrapped at spawn, inside the
    // runner — so the rendering function has no business producing its text (invariant 6).
    expect(handler('secret').render(value)).toBe('***');
  });

  it('compares the value behind the wrapper, because a condition only yields a boolean', () => {
    expect(handler('secret').compare(new SecretString('hunter2'))).toBe('hunter2');
  });

  it('is an empty secret when nothing set it', () => {
    const empty = handler('secret').empty(spec('secret'));

    expect(empty).toBeInstanceOf(SecretString);
    expect((empty as SecretString).reveal()).toBe('');
  });
});

describe('boolean', () => {
  it.each([
    ['true', true],
    ['TRUE', true],
    ['1', true],
    ['yes', true],
    [' Yes ', true],
    ['false', false],
    ['0', false],
    ['no', false],
  ])('reads %s as %s', (text, expected) => {
    expect(from('boolean', text)).toBe(expected);
  });

  it('refuses a word it does not know', () => {
    expect(from('boolean', 'maybe')).toBe('"maybe" is not one of true, 1, yes, false, 0, no');
  });

  it('takes a YAML boolean as itself', () => {
    const result = handler('boolean').fromNative(true, spec('boolean'));
    expect(result.ok && result.value).toBe(true);
    expect(handler('boolean').fromNative('true', spec('boolean')).ok).toBe(false);
  });

  it('renders as the word a command line expects', () => {
    expect(handler('boolean').render(true)).toBe('true');
    expect(handler('boolean').render(false)).toBe('false');
  });

  it('is false when nothing set it', () => {
    expect(handler('boolean').empty(spec('boolean'))).toBe(false);
  });
});

describe('select', () => {
  const options = { options: ['dev', { value: 'prod', label: 'Production' }] };

  it('matches option values', () => {
    expect(from('select', 'prod', options)).toBe('prod');
  });

  it('never matches a label, however much it looks like the answer', () => {
    expect(from('select', 'Production', options)).toBe(
      '"Production" is not one of the option values ("dev", "prod")',
    );
  });

  it('is empty when nothing set it', () => {
    expect(handler('select').empty(spec('select', options))).toBe('');
  });
});

describe('multiselect', () => {
  const options = { options: ['git', 'docker', 'Visual Studio, 2022'] };

  it('splits on commas and trims what surrounds them', () => {
    expect(from('multiselect', 'git, docker', options)).toEqual(['git', 'docker']);
  });

  it('checks an explicit empty string against options', () => {
    expect(from('multiselect', '', options)).toBe(
      '"" is not one of the option values ("git", "docker", "Visual Studio, 2022")',
    );
    expect(from('multiselect', '', { options: ['', 'git'] })).toEqual(['']);
  });

  it('reads a JSON array, which is how a value containing a comma is written', () => {
    expect(from('multiselect', '["Visual Studio, 2022","git"]', options)).toEqual([
      'Visual Studio, 2022',
      'git',
    ]);
  });

  it('never falls back to comma-splitting when the JSON is broken', () => {
    expect(String(from('multiselect', '["git",', options))).toContain('not valid JSON');
  });

  it('names every entry that is not an option value', () => {
    expect(from('multiselect', 'podman,nix', options)).toBe(
      '"podman", "nix" are not option values ("git", "docker", "Visual Studio, 2022")',
    );
  });

  it('takes a YAML list of strings as an immutable snapshot', () => {
    const written = ['git'];
    const result = handler('multiselect').fromNative(written, spec('multiselect', options));
    const selection = result.ok ? (result.value as readonly string[]) : [];

    expect(selection).toEqual(['git']);
    expect(selection).not.toBe(written);

    written.push('podman');
    expect(selection).toEqual(['git']);
    expect(Object.isFrozen(selection)).toBe(true);
    expect(() => (selection as string[]).push('docker')).toThrow(TypeError);
    expect(selection).toEqual(['git']);

    expect(handler('multiselect').fromNative(['git', 7], spec('multiselect', options)).ok).toBe(
      false,
    );
  });

  it('reads array subclasses without invoking their collection hooks', () => {
    class HookedSelection extends Array<string> {}

    const written = new HookedSelection();
    Object.defineProperty(written, '0', {
      value: 'git',
      writable: true,
      enumerable: true,
      configurable: true,
    });
    written.length = 1;

    const hooks = ['some', 'filter', 'map'] as const;
    const spies = hooks.map((name) => {
      const hook = vi.fn(() => {
        throw new Error(`${name} must not be called`);
      });
      Object.defineProperty(written, name, { value: hook });
      return hook;
    });
    const iterator = vi.fn(() => {
      throw new Error('iterator must not be called');
    });
    Object.defineProperty(written, Symbol.iterator, { value: iterator });

    const result = handler('multiselect').fromNative(written, spec('multiselect', options));

    expect(result).toEqual({ ok: true, value: ['git'] });
    expect(Object.isFrozen(result.ok ? result.value : undefined)).toBe(true);
    expect(spies.every((spy) => spy.mock.calls.length === 0)).toBe(true);
    expect(iterator).not.toHaveBeenCalled();
  });

  it('rejects sparse and accessor entries without reading through them', () => {
    const sparse = new Array<string>(1);
    const accessor = ['decoy'];
    let getterCalls = 0;
    Object.defineProperty(accessor, '0', {
      get: () => {
        getterCalls += 1;
        return 'git';
      },
      enumerable: true,
      configurable: true,
    });

    expect(handler('multiselect').fromNative(sparse, spec('multiselect', options))).toEqual({
      ok: false,
      message: 'array is not a list of option values',
    });
    expect(handler('multiselect').fromNative(accessor, spec('multiselect', options))).toEqual({
      ok: false,
      message: 'array is not a list of option values',
    });
    expect(getterCalls).toBe(0);
  });

  it('rejects throwing and revoked proxies without invoking their traps or throwing', () => {
    let descriptorCalls = 0;
    const throwing = new Proxy(['git'], {
      getOwnPropertyDescriptor: () => {
        descriptorCalls += 1;
        throw new Error('descriptor trap must not escape');
      },
    });
    const revocable = Proxy.revocable(['git'], {});
    revocable.revoke();

    for (const value of [throwing, revocable.proxy]) {
      expect(() =>
        handler('multiselect').fromNative(value, spec('multiselect', options)),
      ).not.toThrow();
      expect(handler('multiselect').fromNative(value, spec('multiselect', options)).ok).toBe(false);
    }
    expect(descriptorCalls).toBe(0);
  });

  it('also freezes selections parsed from text and the type-provided empty value', () => {
    const parsed = handler('multiselect').fromString('git,docker', spec('multiselect', options));
    const selection = parsed.ok ? parsed.value : undefined;
    const parsedEmpty = handler('multiselect').fromString('[]', spec('multiselect', options));
    const emptySelection = parsedEmpty.ok ? parsedEmpty.value : undefined;
    const nativeEmpty = handler('multiselect').fromNative([], spec('multiselect', options));
    const nativeEmptySelection = nativeEmpty.ok ? nativeEmpty.value : undefined;
    const empty = handler('multiselect').empty(spec('multiselect', options));

    expect(selection).toEqual(['git', 'docker']);
    expect(Object.isFrozen(selection)).toBe(true);
    expect(emptySelection).toEqual([]);
    expect(Object.isFrozen(emptySelection)).toBe(true);
    expect(nativeEmptySelection).toEqual([]);
    expect(Object.isFrozen(nativeEmptySelection)).toBe(true);
    expect(empty).toEqual([]);
    expect(Object.isFrozen(empty)).toBe(true);
  });

  it('renders comma-joined, the way it is written', () => {
    expect(handler('multiselect').render(['git', 'docker'])).toBe('git,docker');
  });

  it('is an empty list when nothing set it', () => {
    expect(handler('multiselect').empty(spec('multiselect', options))).toEqual([]);
  });
});

describe('values written in their own type, as a values file may', () => {
  it('takes text as text and refuses anything else, naming what was written', () => {
    expect(handler('text').fromNative('plain', spec('text'))).toEqual({
      ok: true,
      value: 'plain',
    });
    expect(handler('text').fromNative(7, spec('text'))).toEqual({
      ok: false,
      message: '7 is not text',
    });
    expect(handler('text').fromNative(['a'], spec('text')).ok).toBe(false);
  });

  it('checks a native text value against the pattern too', () => {
    expect(handler('text').fromNative('x', spec('text', { pattern: '[0-9]+' })).ok).toBe(false);
  });

  it('takes a select value as text and checks its membership', () => {
    const options = { options: ['dev', 'prod'] };
    expect(handler('select').fromNative('prod', spec('select', options)).ok).toBe(true);
    expect(handler('select').fromNative(true, spec('select', options))).toEqual({
      ok: false,
      message: 'true is not text',
    });
    expect(handler('select').fromNative('staging', spec('select', options)).ok).toBe(false);
  });

  it.each(['file', 'directory'] as const)('takes a %s path as text and nothing else', (type) => {
    expect(handler(type).fromNative('/opt/app', spec(type)).ok).toBe(true);
    expect(handler(type).fromNative(42, spec(type))).toEqual({
      ok: false,
      message: '42 is not a path',
    });
  });

  it.each(['text', 'boolean', 'select', 'multiselect', 'file', 'directory'] as const)(
    'refuses unsupported native values for %s without throwing',
    (type) => {
      const cyclicObject: { self?: unknown } = {};
      cyclicObject.self = cyclicObject;
      const cyclicArray: unknown[] = [];
      cyclicArray.push(cyclicArray);
      let toJSONCalls = 0;
      const withThrowingToJSON = {
        toJSON(): never {
          toJSONCalls += 1;
          throw new Error('must not be called');
        },
      };
      const values = [
        1n,
        Symbol('value'),
        () => undefined,
        cyclicObject,
        cyclicArray,
        withThrowingToJSON,
      ];
      const inputSpec = spec(
        type,
        type === 'select' || type === 'multiselect' ? { options: ['option'] } : undefined,
      );

      for (const value of values) {
        const result = handler(type).fromNative(value, inputSpec);
        expect(result.ok).toBe(false);
      }
      expect(toJSONCalls).toBe(0);
    },
  );

  it('describes unsupported values deterministically', () => {
    expect(handler('text').fromNative(1n, spec('text'))).toEqual({
      ok: false,
      message: 'bigint is not text',
    });

    const cyclicObject: { self?: unknown } = {};
    cyclicObject.self = cyclicObject;
    expect(handler('text').fromNative(cyclicObject, spec('text'))).toEqual({
      ok: false,
      message: 'object is not text',
    });

    const cyclicArray: unknown[] = [];
    cyclicArray.push(cyclicArray);
    expect(
      handler('multiselect').fromNative(cyclicArray, spec('multiselect', { options: [] })),
    ).toEqual({
      ok: false,
      message: 'array is not a list of option values',
    });

    expect(handler('text').fromNative(Symbol('value'), spec('text'))).toEqual({
      ok: false,
      message: 'symbol is not text',
    });
    expect(handler('text').fromNative(() => undefined, spec('text'))).toEqual({
      ok: false,
      message: 'function is not text',
    });

    const { proxy, revoke } = Proxy.revocable([], {});
    revoke();
    expect(handler('text').fromNative(proxy, spec('text'))).toEqual({
      ok: false,
      message: 'object is not text',
    });
  });
});

describe('what counts as no answer at all', () => {
  it.each(['text', 'secret', 'select', 'file', 'directory'] as const)(
    'treats an empty %s as no answer',
    (type) => {
      expect(handler(type).isAbsent(handler(type).empty(spec(type)))).toBe(true);
      expect(handler(type).isAbsent('something')).toBe(false);
    },
  );

  it('treats an empty selection as no answer', () => {
    expect(handler('multiselect').isAbsent([])).toBe(true);
    expect(handler('multiselect').isAbsent(['git'])).toBe(false);
  });

  it('never treats a boolean as absent, because false is an answer', () => {
    expect(handler('boolean').isAbsent(false)).toBe(false);
    expect(handler('boolean').isAbsent(true)).toBe(false);
  });
});

describe('file and directory', () => {
  it.each(['file', 'directory'] as const)('takes any path as %s and checks nothing', (type) => {
    expect(from(type, '/does/not/exist')).toBe('/does/not/exist');
    expect(from(type, 'C:\\Program Files\\App')).toBe('C:\\Program Files\\App');
    expect(handler(type).empty(spec(type))).toBe('');
  });
});
