import { inspect } from 'node:util';

import { describe, expect, it, vi } from 'vitest';

import {
  isSecretString,
  MASK,
  MIN_MASKABLE_LENGTH,
  SecretRegistry,
  SecretString,
} from '../../src/engine/secrets.js';

describe('SecretString', () => {
  const secret = new SecretString('hunter2');

  it('shows the mask through every path that stringifies a value', () => {
    expect(String(secret)).toBe(MASK);
    expect(`${String(secret)}`).toBe(MASK);
    expect([secret].join('')).toBe(MASK);
    expect(JSON.stringify(secret)).toBe('null');
    expect(JSON.stringify({ token: secret })).toBe('{"token":null}');
    expect(inspect(secret)).toBe(MASK);
    expect(inspect({ token: secret })).toContain(MASK);
    expect(inspect({ token: secret })).not.toContain('hunter2');
  });

  it('gives up its value only when asked outright', () => {
    expect(secret.reveal()).toBe('hunter2');
    expect(secret.length).toBe(7);
  });

  it('is recognisable', () => {
    expect(isSecretString(secret)).toBe(true);
    expect(isSecretString('hunter2')).toBe(false);
  });
});

describe('SecretRegistry', () => {
  it('removes a registered secret from text, wherever it appears', () => {
    const registry = new SecretRegistry();
    registry.register('hunter2');

    expect(registry.mask('connecting with hunter2 …')).toBe(`connecting with ${MASK} …`);
    expect(registry.mask('hunter2hunter2')).toBe(`${MASK}${MASK}`);
    expect(registry.mask('nothing to see')).toBe('nothing to see');
  });

  it('masks a secret containing another secret as one range', () => {
    const registry = new SecretRegistry();
    registry.register('secret');
    registry.register('secret-and-more');

    expect(registry.mask('secret-and-more')).toBe(MASK);
  });

  it.each([
    ['abcdef', 'defghi'],
    ['defghi', 'abcdef'],
  ])('masks overlapping secrets completely when registered as %s then %s', (first, second) => {
    const registry = new SecretRegistry();
    registry.register(first);
    registry.register(second);

    expect(registry.mask('abcdefghi')).toBe(MASK);
  });

  it('unites overlaps between differently sized secrets without exposing either remainder', () => {
    const registry = new SecretRegistry();
    registry.register('abcde');
    registry.register('defghi');

    expect(registry.mask('abcdefghij')).toBe(`${MASK}j`);
  });

  it('unites self-overlapping occurrences of the same secret', () => {
    const registry = new SecretRegistry();
    registry.register('aaaa');

    expect(registry.mask('aaaaa')).toBe(MASK);
  });

  it('compresses many self-overlapping occurrences before sorting them', () => {
    const registry = new SecretRegistry();
    registry.register('aaaa');

    expect(registry.mask('a'.repeat(1_000_000))).toBe(MASK);
  });

  it('keeps adjacent occurrences of the same secret as separate masks', () => {
    const registry = new SecretRegistry();
    registry.register('abcd');

    expect(registry.mask('abcdabcd')).toBe(`${MASK}${MASK}`);
  });

  it('masks many adjacent occurrences without retaining every match', () => {
    const registry = new SecretRegistry();
    registry.register('abcd');

    expect(registry.mask('abcd'.repeat(1_000_000))).toBe(MASK.repeat(1_000_000));
  });

  it('unites a chain of overlaps across different secrets', () => {
    const registry = new SecretRegistry();
    registry.register('abcdef');
    registry.register('defghi');
    registry.register('ghijkl');

    expect(registry.mask('abcdefghijkl')).toBe(MASK);
  });

  it('keeps adjacent occurrences of different secrets as separate masks', () => {
    const registry = new SecretRegistry();
    registry.register('abcd');
    registry.register('efgh');

    expect(registry.mask('abcdefgh')).toBe(`${MASK}${MASK}`);
  });

  it('orders matches by text position rather than registration order', () => {
    const registry = new SecretRegistry();
    registry.register('aaaa');
    registry.register('bbbb');
    registry.register('cccc');
    registry.register('dddd');

    expect(registry.mask('aaaa----ccccddddbbbb')).toBe(`${MASK}----${MASK}${MASK}${MASK}`);
  });

  it('leaves empty text unchanged', () => {
    const registry = new SecretRegistry();
    registry.register('secret');

    expect(registry.mask('')).toBe('');
  });

  it('keeps separate matches and their surrounding text unchanged', () => {
    const registry = new SecretRegistry();
    registry.register('secret');
    registry.register('secret-and-more');

    expect(registry.mask('before secret-and-more between secret after')).toBe(
      `before ${MASK} between ${MASK} after`,
    );
  });

  it('refuses to register a value too short to mask safely, and says so', () => {
    const registry = new SecretRegistry();

    expect(registry.register('ab')).toBe(false);
    expect(registry.size).toBe(0);
    // Masking "ab" would black out every "ab" in every line, which hides more than it saves.
    expect(registry.mask('a table of absolute values')).toBe('a table of absolute values');
    expect(registry.register('a'.repeat(MIN_MASKABLE_LENGTH))).toBe(true);
  });

  it('refuses a value that is only whitespace, however long it is', () => {
    const registry = new SecretRegistry();

    // Masking four spaces would black out the indentation of every line a child prints.
    expect(registry.register('    ')).toBe(false);
    expect(registry.mask('    indented output')).toBe('    indented output');
  });

  it('masks a secret that spans several lines line by line, which is all a sink ever sees', () => {
    const registry = new SecretRegistry();
    const key = ['-----BEGIN KEY-----', 'MIIBpayloadLine', '-----END KEY-----'].join('\n');
    expect(registry.register(key)).toBe(true);

    // Output is read line by line, so the whole-key string would never match anything.
    expect(registry.mask('writing MIIBpayloadLine to disk')).toBe(`writing ${MASK} to disk`);
    expect(registry.mask(key)).toBe(MASK);
  });

  it('reports a multiline secret as incomplete when any content line is too short', () => {
    const registry = new SecretRegistry();
    const secret = 'long-secret\nabc';

    expect(registry.register(secret)).toBe(false);
    expect(registry.mask('value: long-secret')).toBe(`value: ${MASK}`);
    expect(registry.mask('value: abc')).toBe('value: abc');
    expect(registry.mask(secret)).toBe(MASK);
  });

  it('reports incomplete lines even when only the combined value is maskable', () => {
    const registry = new SecretRegistry();
    const secret = 'ab\ncd';

    expect(registry.register(secret)).toBe(false);
    expect(registry.mask(secret)).toBe(MASK);
    expect(registry.mask('ab')).toBe('ab');
    expect(registry.mask('cd')).toBe('cd');
  });

  it('masks bare-CR multiline secrets line by line', () => {
    const registry = new SecretRegistry();
    const secret = 'first-long\rsecond-long';

    expect(registry.register(secret)).toBe(true);
    expect(registry.mask('value: first-long')).toBe(`value: ${MASK}`);
    expect(registry.mask('value: second-long')).toBe(`value: ${MASK}`);
  });

  it('reports bare-CR secrets as incomplete when a content line is too short', () => {
    const registry = new SecretRegistry();
    const secret = 'first-long\rabc';

    expect(registry.register(secret)).toBe(false);
    expect(registry.mask('value: first-long')).toBe(`value: ${MASK}`);
    expect(registry.mask('value: abc')).toBe('value: abc');
  });

  it('does not treat blank CRLF lines as unmaskable content', () => {
    const registry = new SecretRegistry();
    const secret = 'first-long\r\n   \r\nsecond-long';

    expect(registry.register(secret)).toBe(true);
    expect(registry.mask('first-long')).toBe(MASK);
    expect(registry.mask('second-long')).toBe(MASK);
  });

  it('counts a secret once, however often it is registered', () => {
    const registry = new SecretRegistry();
    registry.register('hunter2');
    registry.register('hunter2');

    expect(registry.size).toBe(1);
  });

  it('replaces its contents from a private snapshot of another registry', () => {
    const target = new SecretRegistry();
    target.register('previous-secret');
    expect(target.mask('previous-secret')).toBe(MASK);

    const source = new SecretRegistry();
    source.register('current-secret');
    target.replaceWith(source);
    source.register('later-secret');

    expect(target.size).toBe(1);
    expect(target.mask('previous-secret')).toBe('previous-secret');
    expect(target.mask('current-secret')).toBe(MASK);
    expect(target.mask('later-secret')).toBe('later-secret');
  });

  it('sorts registered secrets only before masking after the set changes', () => {
    const registry = new SecretRegistry();
    const sort = vi.spyOn(Array.prototype, 'sort');
    const registeredSorts = (): number =>
      sort.mock.contexts.filter(
        (value): value is string[] =>
          Array.isArray(value) &&
          value.length > 0 &&
          value.every((item) => typeof item === 'string'),
      ).length;

    try {
      for (let index = 0; index < 100; index += 1) {
        registry.register(`secret-${index}`);
      }
      expect(sort).not.toHaveBeenCalled();

      expect(registry.mask('secret-99')).toBe(MASK);
      expect(registeredSorts()).toBe(1);

      registry.mask('secret-99');
      registry.register('secret-99');
      registry.mask('secret-99');
      expect(registeredSorts()).toBe(1);

      registry.register('secret-new');
      registry.mask('secret-new');
      expect(registeredSorts()).toBe(2);
    } finally {
      sort.mockRestore();
    }
  });
});
