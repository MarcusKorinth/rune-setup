import { describe, expect, it } from 'vitest';

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
    expect(JSON.stringify({ value })).toBe('{"value":"***"}');
    expect((value as SecretString).reveal()).toBe('hunter2');
  });

  it('never echoes the value it refuses', () => {
    const result = handler('secret').fromNative(1234, spec('secret'));

    expect(result.ok).toBe(false);
    expect(result.ok ? '' : result.message).toBe('the value is not text');
  });

  it('renders the mask, never the secret', () => {
    const value = new SecretString('hunter2');

    // A secret reaches a command as the wrapper itself and is unwrapped at spawn, inside the
    // runner — so the rendering function has no business producing its text (invariant 6).
    expect(handler('secret').render(value)).toBe('***');
  });

  it('keeps the comparison value opaque for the condition evaluator', () => {
    const value = new SecretString('hunter2');

    expect(handler('secret').compare(value)).toBe(value);
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

  it('is empty for an empty string, not a list holding one empty entry', () => {
    expect(from('multiselect', '', options)).toEqual([]);
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

  it('takes a YAML list of strings', () => {
    const result = handler('multiselect').fromNative(['git'], spec('multiselect', options));
    expect(result.ok && result.value).toEqual(['git']);
    expect(handler('multiselect').fromNative(['git', 7], spec('multiselect', options)).ok).toBe(
      false,
    );
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
