import { inspect } from 'node:util';

import { describe, expect, it } from 'vitest';

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

  it('masks the longest secret first, so a shorter one cannot split it', () => {
    const registry = new SecretRegistry();
    registry.register('secret');
    registry.register('secret-and-more');

    expect(registry.mask('secret-and-more')).toBe(MASK);
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
    registry.register(key);

    // Output is read line by line, so the whole-key string would never match anything.
    expect(registry.mask('writing MIIBpayloadLine to disk')).toBe(`writing ${MASK} to disk`);
    expect(registry.mask(key)).toBe(MASK);
  });

  it('counts a secret once, however often it is registered', () => {
    const registry = new SecretRegistry();
    registry.register('hunter2');
    registry.register('hunter2');

    expect(registry.size).toBe(1);
  });
});
