import { inspect } from 'node:util';
import { resolve as resolvePath } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  composeSecretString,
  createSecretString,
  isSecretString,
  MASK,
  MIN_MASKABLE_LENGTH,
  registerSecretForMasking,
  resolveSecretPathFrom,
  secretEquals,
  secretLength,
  secretMatches,
  SecretRegistry,
} from '../../src/engine/secrets.js';

describe('SecretString', () => {
  const secret = createSecretString('hunter2');

  it('shows the mask through every path that stringifies a value', () => {
    expect(String(secret)).toBe(MASK);
    expect(`${String(secret)}`).toBe(MASK);
    expect([secret].join('')).toBe(MASK);
    expect(JSON.stringify(secret)).toBe(`"${MASK}"`);
    expect(JSON.stringify({ token: secret })).toBe(`{"token":"${MASK}"}`);
    expect(inspect(secret)).toBe(MASK);
    expect(inspect({ token: secret })).toContain(MASK);
    expect(inspect({ token: secret })).not.toContain('hunter2');
  });

  it('exposes no plaintext or oracle operations on the value itself', () => {
    const surface = new Set([
      ...Object.getOwnPropertyNames(secret),
      ...Object.getOwnPropertyNames(Object.getPrototypeOf(secret) as object),
    ]);

    expect(surface).not.toContain('reveal');
    expect(surface).not.toContain('matches');
    expect(surface).not.toContain('equals');
    expect(surface).not.toContain('isIncludedIn');
    expect(surface).not.toContain('registerForMasking');
    expect(surface).not.toContain('resolvePathFrom');
    expect(surface).not.toContain('compose');
    expect(surface).not.toContain('length');
  });

  it('keeps package-internal composed and transformed values opaque', () => {
    const composed = resolveSecretPathFrom(
      composeSecretString(['prefix-', secret, '-${env.SHOULD_NOT_BE_RESCANNED}']),
      '/project',
    );

    expect(String(composed)).toBe(MASK);
    expect(JSON.stringify(composed)).toBe(`"${MASK}"`);
    expect(inspect(composed)).toBe(MASK);
    expect(secretMatches(composed, /SHOULD_NOT_BE_RESCANNED}$/)).toBe(true);
    expect(
      secretEquals(
        composed,
        resolvePath('/project', 'prefix-hunter2-${env.SHOULD_NOT_BE_RESCANNED}'),
      ),
    ).toBe(true);
    expect(secretLength(secret)).toBe(7);
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

  it.each([[['abcdX', 'Xefgh']], [['Xefgh', 'abcdX']]])(
    'masks crossing overlaps in either registration order',
    (secrets) => {
      const registry = new SecretRegistry();
      for (const secret of secrets) {
        registry.register(secret);
      }

      expect(registry.mask('before abcdXefgh after')).toBe(`before ${MASK} after`);
    },
  );

  it('masks crossing overlaps of different lengths as one range', () => {
    const registry = new SecretRegistry();
    registry.register('abcde');
    registry.register('defghijk');

    expect(registry.mask('abcdefghijk')).toBe(MASK);
  });

  it('captures immutable mask-only snapshots with the same overlap handling', () => {
    const registry = new SecretRegistry();
    registry.register('abcde');
    registry.register('defghijk');
    const snapshot = registry.snapshot();

    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(snapshot).not.toHaveProperty('register');
    expect(snapshot).not.toHaveProperty('size');
    expect(snapshot.mask('abcdefghijk')).toBe(MASK);

    registry.register('later-secret');

    expect(registry.mask('later-secret')).toBe(MASK);
    expect(snapshot.mask('later-secret')).toBe('later-secret');
    expect(snapshot.mask('abcdefghijk')).toBe(MASK);
  });

  it('masks contained secrets as one range', () => {
    const registry = new SecretRegistry();
    registry.register('secret');
    registry.register('secret-and-more');

    expect(registry.mask('secret-and-more')).toBe(MASK);
  });

  it('merges self-overlapping occurrences', () => {
    const registry = new SecretRegistry();
    registry.register('aaaa');

    expect(registry.mask('aaaaa')).toBe(MASK);
  });

  it('keeps adjacent independent occurrences as separate masks', () => {
    const registry = new SecretRegistry();
    registry.register('abcd');
    registry.register('efgh');

    expect(registry.mask('abcdefgh')).toBe(`${MASK}${MASK}`);
  });

  it('masks dense overlaps with storage bounded by the input length', () => {
    const registry = new SecretRegistry();
    for (let length = MIN_MASKABLE_LENGTH; length < MIN_MASKABLE_LENGTH + 100; length += 1) {
      registry.register('a'.repeat(length));
    }

    expect(registry.mask('a'.repeat(64 * 1024))).toBe(MASK);
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

  it('does not register multiline secrets made only of short lines', () => {
    const registry = new SecretRegistry();

    expect(registry.register('ab\ncd')).toBe(false);
    expect(registry.size).toBe(0);
    expect(registry.mask('ab\ncd')).toBe('ab\ncd');
  });

  it('registers maskable multiline lines even when a short line leaves coverage incomplete', () => {
    const registry = new SecretRegistry();

    expect(registry.register('long-line\nno')).toBe(false);
    expect(registry.size).toBe(1);
    expect(registry.mask('long-line\nno')).toBe(`${MASK}\nno`);
  });

  it('treats CRLF and empty separator lines as logical line boundaries', () => {
    const registry = new SecretRegistry();

    expect(registry.register('first-line\r\n\r\nsecond-line\r\n')).toBe(true);
    expect(registry.size).toBe(2);
    expect(registry.mask('first-line and second-line')).toBe(`${MASK} and ${MASK}`);
  });

  it('masks a certificate-like secret line by line, which is all a sink ever sees', () => {
    const registry = new SecretRegistry();
    const key = ['-----BEGIN KEY-----', 'MIIBpayloadLine', '-----END KEY-----'].join('\n');
    expect(registerSecretForMasking(createSecretString(key), registry)).toBe(true);

    // Output is read line by line, so the whole-key string would never match anything.
    expect(registry.mask('writing MIIBpayloadLine to disk')).toBe(`writing ${MASK} to disk`);
    expect(registry.mask(key)).toBe([MASK, MASK, MASK].join('\n'));
  });

  it('counts a secret once, however often it is registered', () => {
    const registry = new SecretRegistry();
    registry.register('hunter2');
    registry.register('hunter2');

    expect(registry.size).toBe(1);
  });
});
