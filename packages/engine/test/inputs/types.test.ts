import { inspect } from 'node:util';

import { describe, expect, it, vi } from 'vitest';

import { InternalError } from '../../src/errors.js';
import {
  createSecretString,
  isSecretString,
  secretLength,
  secretValuesEqual,
} from '../../src/engine/secrets.js';
import { InputTypeRegistry, inputTypes } from '../../src/inputs/registry.js';
import { BUILT_IN_INPUT_TYPES, MAX_PATTERN_INPUT_BYTES } from '../../src/inputs/builtin.js';
import { FALSE_WORDS, TRUE_WORDS, type InputTypeHandler } from '../../src/inputs/base.js';
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

const DIAGNOSTIC_CONTROLS = '\n\r\u001b\u0007\u0085\u2028\u2029';
const VISIBLE_DIAGNOSTIC_ESCAPES = [
  '\\n',
  '\\r',
  '\\u001b',
  '\\u0007',
  '\\u0085',
  '\\u2028',
  '\\u2029',
] as const;

function expectSafeDiagnostic(message: string): void {
  expect(hasRawDiagnosticControl(message)).toBe(false);
  for (const visible of VISIBLE_DIAGNOSTIC_ESCAPES) {
    expect(message).toContain(visible);
  }
}

function hasRawDiagnosticControl(message: string): boolean {
  return [...message].some((character) => {
    const codePoint = character.codePointAt(0)!;
    return (
      codePoint <= 0x1f ||
      (codePoint >= 0x7f && codePoint <= 0x9f) ||
      codePoint === 0x2028 ||
      codePoint === 0x2029
    );
  });
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

  it('keeps both select coercion paths stable when the built-in handler changes', () => {
    const builtInSelect = BUILT_IN_INPUT_TYPES.find(({ name }) => name === 'select');
    if (builtInSelect === undefined) {
      throw new Error('the built-in select handler is missing');
    }
    const registered = inputTypes.get('select');
    const originalFromString = builtInSelect.fromString;
    const replacement = vi.fn(() => ({ ok: true, value: 'replacement' }) as const);
    const selectSpec = spec('select', { options: ['production'] });

    try {
      expect(Reflect.set(builtInSelect, 'fromString', replacement)).toBe(true);

      expect(registered.fromString('production', selectSpec)).toEqual({
        ok: true,
        value: 'production',
      });
      expect(registered.fromNative('production', selectSpec)).toEqual({
        ok: true,
        value: 'production',
      });
      expect(replacement).not.toHaveBeenCalled();
    } finally {
      Reflect.set(builtInSelect, 'fromString', originalFromString);
    }
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

  it('quotes values and escapes controls in patterns and hints on one physical line', () => {
    const value = `rejected${DIAGNOSTIC_CONTROLS}"\\value`;
    const patternMessage = String(
      from('text', value, { pattern: `accepted${DIAGNOSTIC_CONTROLS}` }),
    );
    const hintMessage = String(
      from('text', value, { pattern: 'accepted', patternHint: `hint${DIAGNOSTIC_CONTROLS}` }),
    );

    expectSafeDiagnostic(patternMessage);
    expectSafeDiagnostic(hintMessage);
    expect(patternMessage).toContain('\\"\\\\value" does not match accepted');
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

    expect(isSecretString(value)).toBe(true);
    expect(String(value)).toBe('***');
    expect(`${String(value)}`).not.toContain('hunter2');
    expect(JSON.stringify({ value })).toBe('{"value":"***"}');
    expect(isSecretString(value) && secretValuesEqual(value, 'hunter2')).toBe(true);
  });

  it('never echoes the value it refuses', () => {
    const result = handler('secret').fromNative(1234, spec('secret'));

    expect(result.ok).toBe(false);
    expect(result.ok ? '' : result.message).toBe('the value is not text');
  });

  it('accepts an authentic opaque value without exposing or copying it', () => {
    const supplied = createSecretString('stable-secret');
    const result = handler('secret').fromNative(supplied, spec('secret'));
    const normalized = result.ok ? result.value : undefined;

    expect(normalized).toBe(supplied);
    expect(isSecretString(normalized)).toBe(true);
    expect(isSecretString(normalized) && secretValuesEqual(normalized, 'stable-secret')).toBe(true);
  });

  it('keeps authentic values frozen with no plaintext surface to shadow', () => {
    const supplied = createSecretString('stable-secret');

    expect(Object.isFrozen(supplied)).toBe(true);
    expect(Reflect.defineProperty(supplied, 'reveal', { value: () => 'decoy-secret' })).toBe(false);
    expect(handler('secret').fromNative(supplied, spec('secret'))).toEqual({
      ok: true,
      value: supplied,
    });
  });

  it('rejects proxies and forged brands without throwing or invoking traps', () => {
    const authentic = createSecretString('proxy-secret');
    let trapCalls = 0;
    const proxied = new Proxy(authentic, {
      get: () => {
        trapCalls += 1;
        throw new Error('proxy was inspected');
      },
    });
    const forged = Object.create(Object.getPrototypeOf(authentic) as object);

    for (const value of [proxied, forged]) {
      expect(() => handler('secret').fromNative(value, spec('secret'))).not.toThrow();
      expect(handler('secret').fromNative(value, spec('secret'))).toEqual({
        ok: false,
        message: 'the value is not text',
      });
    }
    expect(trapCalls).toBe(0);
  });

  it('renders the mask, never the secret', () => {
    const value = createSecretString('hunter2');

    // A secret reaches a command as the wrapper itself and is unwrapped at spawn, inside the
    // runner — so the rendering function has no business producing its text (invariant 6).
    expect(handler('secret').render(value)).toBe('***');
  });

  it('gives conditions a normalized opaque wrapper without exposing its content', () => {
    const content = 'F049-COMPARE-SECRET';
    const value = createSecretString(content);
    const compared = handler('secret').compare(value);

    expect(isSecretString(compared)).toBe(true);
    expect(compared).toBe(value);
    expect(String(compared)).toBe('***');
    expect(`${compared}`).toBe('***');
    expect(JSON.stringify(compared)).toBe('"***"');
    expect(inspect(compared)).toBe('***');
    expect(
      [String(compared), `${compared}`, JSON.stringify(compared), inspect(compared)].join('\n'),
    ).not.toContain(content);
  });

  it('is an empty secret when nothing set it', () => {
    const empty = handler('secret').empty(spec('secret'));

    expect(isSecretString(empty)).toBe(true);
    expect(isSecretString(empty) && secretLength(empty)).toBe(0);
  });
});

describe('boolean', () => {
  it('keeps the registered vocabulary stable when callers try to mutate its exports', () => {
    const registered = handler('boolean');

    expect(Reflect.set(TRUE_WORDS, 0, 'maybe')).toBe(false);
    expect(Reflect.set(FALSE_WORDS, 0, 'perhaps')).toBe(false);
    expect(registered.fromString('yes', spec('boolean'))).toEqual({ ok: true, value: true });
    expect(registered.fromString('no', spec('boolean'))).toEqual({ ok: true, value: false });
    expect(registered.fromString('maybe', spec('boolean'))).toEqual({
      ok: false,
      message: '"maybe" is not one of true, 1, yes, false, 0, no',
    });
  });

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

describe('safe coercion diagnostics', () => {
  it('escapes controls in boolean, select, membership, and option-value rendering', () => {
    const rejected = `rejected${DIAGNOSTIC_CONTROLS}"\\value`;
    const option = `option${DIAGNOSTIC_CONTROLS}"\\value`;
    const messages = [
      String(from('boolean', rejected)),
      String(from('select', rejected, { options: [option] })),
      String(from('multiselect', rejected, { options: [option] })),
    ];

    for (const message of messages) {
      expectSafeDiagnostic(message);
      expect(message).toContain('\\"\\\\value"');
    }
  });

  it('does not expose the JSON parser reason', () => {
    const parse = vi.spyOn(JSON, 'parse').mockImplementationOnce(() => {
      throw new SyntaxError(`parser${DIAGNOSTIC_CONTROLS}reason`);
    });

    try {
      const message = String(from('multiselect', '[', { options: ['git'] }));

      expect(message).toBe(
        'starts with "[" and is therefore read as a JSON array, but it is not valid JSON',
      );
    } finally {
      parse.mockRestore();
    }
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

  it('names the supplied text once, not the pieces it was split into', () => {
    // §10: the split entries are spellings RUNE derived, so naming them would print a value
    // past masks that hold only what the supplier wrote. A native array is named per entry.
    expect(from('multiselect', 'podman,nix', options)).toBe(
      '"podman,nix" contains values that are not option values ("git", "docker", "Visual Studio, 2022")',
    );
    const native = handler('multiselect').fromNative(
      ['podman', 'nix'],
      spec('multiselect', options),
    );
    expect(native.ok ? undefined : native.message).toBe(
      '"podman", "nix" are not option values ("git", "docker", "Visual Studio, 2022")',
    );
  });

  it('keeps declared option values in their written order', () => {
    const result = from('multiselect', 'missing-last,stable,missing-first', {
      options: [
        { value: 'first', label: 'First option' },
        'stable',
        { value: 'last', label: 'Last option' },
      ],
    });

    expect(result).toBe(
      '"missing-last,stable,missing-first" contains values that are not option values ("first", "stable", "last")',
    );
  });

  it('retains duplicate native selections in their written order as a frozen snapshot', () => {
    const written = ['docker', 'git', 'docker'];
    const result = handler('multiselect').fromNative(written, spec('multiselect', options));
    const selection = result.ok ? (result.value as readonly string[]) : [];

    expect(selection).toEqual(written);
    expect(selection).not.toBe(written);
    expect(Object.isFrozen(selection)).toBe(true);
  });

  it('validates large native selections without a quadratic membership scan', () => {
    const count = 50_000;
    const values = Array.from({ length: count }, (_unused, index) => `option-${index}`);
    const selection = [...values].reverse();
    const started = Date.now();

    const result = handler('multiselect').fromNative(
      selection,
      spec('multiselect', { options: values }),
    );

    // Both the manifest-sized option list and a native values-file selection are valid. A
    // linear lookup remains comfortably below this generous guard; scanning the full option
    // list for every selection used to take multiple seconds on this shape.
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(result).toEqual({ ok: true, value: selection });
    expect(Object.isFrozen(result.ok ? result.value : undefined)).toBe(true);
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
