import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, resolve as resolvePath, sep } from 'node:path';
import { inspect } from 'node:util';
import { fileURLToPath } from 'node:url';

import ts from 'typescript';
import { describe, expect, it, vi } from 'vitest';

import { InputError } from '../../src/errors.js';
import {
  composeSecretString,
  createSecretString,
  isSecretString,
  MASK,
  MAX_SECRET_REGISTRY_CODE_UNITS,
  MIN_MASKABLE_LENGTH,
  resolveSecretPathFrom,
  secretLength,
  secretMatches,
  SecretRegistry,
  secretValuesEqual,
} from '../../src/engine/secrets.js';

describe('SecretString', () => {
  const secret = createSecretString('hunter2');

  it('shows the mask through every path that stringifies a value', () => {
    expect(String(secret)).toBe(MASK);
    expect(`${String(secret)}`).toBe(MASK);
    expect([secret].join('')).toBe(MASK);
    expect(JSON.stringify(secret)).toBe('"***"');
    expect(JSON.stringify({ token: secret })).toBe('{"token":"***"}');
    const structured = JSON.stringify({
      command: ['deploy', secret],
      env: { RUNE_TOKEN: secret },
      nested: [{ token: secret }],
    });
    expect(structured).toBe(
      '{"command":["deploy","***"],"env":{"RUNE_TOKEN":"***"},"nested":[{"token":"***"}]}',
    );
    expect(structured).not.toContain('hunter2');
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

  it('keeps composed and transformed values opaque', () => {
    const composed = resolveSecretPathFrom(
      composeSecretString(['prefix-', secret, '-${env.SHOULD_NOT_BE_RESCANNED}']),
      '/project',
      'linux',
    );

    expect(String(composed)).toBe(MASK);
    expect(JSON.stringify(composed)).toBe(`"${MASK}"`);
    expect(inspect(composed)).toBe(MASK);
    expect(secretMatches(composed, /SHOULD_NOT_BE_RESCANNED}$/)).toBe(true);
    expect(
      secretValuesEqual(
        composed,
        resolvePath('/project', `.${sep}prefix-hunter2-\${env.SHOULD_NOT_BE_RESCANNED}`),
      ),
    ).toBe(true);
    expect(secretLength(secret)).toBe(7);
  });

  it('recognises only wrappers with an authentic private brand', () => {
    const forged = Object.create(Object.getPrototypeOf(secret) as object);
    const proxied = new Proxy(createSecretString('proxy-secret'), {});
    const { proxy: revoked, revoke } = Proxy.revocable(createSecretString('revoked-secret'), {});
    revoke();

    expect(isSecretString(secret)).toBe(true);
    for (const value of ['hunter2', forged, proxied, revoked]) {
      expect(() => isSecretString(value)).not.toThrow();
      expect(isSecretString(value)).toBe(false);
    }
  });
});

describe('SecretRegistry', () => {
  it('registers opaque candidates without invoking supplied traps or methods', () => {
    const authentic = createSecretString('F049-AUTHENTIC-SECRET');

    let proxyCalls = 0;
    const proxy = new Proxy(createSecretString('F049-PROXY-DECOY'), {
      get: () => {
        proxyCalls += 1;
        throw new Error('proxy candidate was inspected');
      },
      getPrototypeOf: () => {
        proxyCalls += 1;
        throw new Error('proxy candidate prototype was inspected');
      },
    });
    const { proxy: revoked, revoke } = Proxy.revocable(
      createSecretString('F049-REVOKED-DECOY'),
      {},
    );
    revoke();
    const forged = Object.create(Object.getPrototypeOf(authentic) as object);
    let accessorReads = 0;
    const accessor = Object.create(null, {
      reveal: {
        get: () => {
          accessorReads += 1;
          return () => 'F049-ACCESSOR-DECOY';
        },
      },
    });
    const registry = new SecretRegistry();

    expect(registry.registerCandidate('F049-STRING-SECRET')).toBe(true);
    expect(registry.registerCandidate(authentic)).toBe(true);
    for (const candidate of [proxy, revoked, forged, accessor]) {
      expect(() => registry.registerCandidate(candidate)).not.toThrow();
      expect(registry.registerCandidate(candidate)).toBeUndefined();
    }

    expect(accessorReads).toBe(0);
    expect(proxyCalls).toBe(0);
    expect(registry.size).toBe(2);
    expect(registry.mask('F049-STRING-SECRET/F049-AUTHENTIC-SECRET')).toBe('***/***');
    expect(registry.mask('F049-ACCESSOR-DECOY/F049-PROXY-DECOY')).toBe(
      'F049-ACCESSOR-DECOY/F049-PROXY-DECOY',
    );
  });

  it('captures immutable mask-only snapshots', () => {
    const registry = new SecretRegistry();
    registry.register('first-secret');
    const snapshot = registry.snapshot();

    registry.register('later-secret');

    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(snapshot).not.toHaveProperty('register');
    expect(snapshot.mask('first-secret/later-secret')).toBe('***/later-secret');
    expect(registry.mask('first-secret/later-secret')).toBe('***/***');
  });

  it('caches a fallback marker per registry version and immutable snapshot', () => {
    const registry = new SecretRegistry();
    const first = String.fromCodePoint(0x10000);
    const second = String.fromCodePoint(0x10001);
    const [secondHigh, secondLow] = [second.charAt(0), second.charAt(1)];

    expect(registry.safeFallbackMarker()).toBe(first);
    const initialSnapshot = registry.snapshot();
    registry.register(first.repeat(4));
    expect(registry.safeFallbackMarker()).toBe(second);
    registry.register(`${secondLow}\\n${secondHigh}`);
    const laterSnapshot = registry.snapshot();

    expect(initialSnapshot.safeFallbackMarker()).toBe(first);
    expect(laterSnapshot.safeFallbackMarker()).toBe(String.fromCodePoint(0x10002));
    expect(registry.safeFallbackMarker()).toBe(String.fromCodePoint(0x10002));
  });

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

  it('masks a secret created by replacing text immediately before it', () => {
    const registry = new SecretRegistry();
    registry.register('abcdef');
    registry.register('***ghi');

    expect(registry.mask('abcdefghi')).toBe(MASK);
  });

  it('masks a secret created by replacing text immediately after it', () => {
    const registry = new SecretRegistry();
    registry.register('abcdef');
    registry.register('ghi***');

    expect(registry.mask('ghiabcdef')).toBe(MASK);
  });

  it('masks a secret jointly created by two replacements', () => {
    const registry = new SecretRegistry();
    registry.register('abcdef');
    registry.register('ghijkl');
    registry.register('***middle***');

    expect(registry.mask('abcdefmiddleghijkl')).toBe(MASK);
  });

  it('continues masking until no replacement creates another secret', () => {
    const registry = new SecretRegistry();
    registry.register('abcdef');
    registry.register('***ghi');
    registry.register('***JKLM');

    expect(registry.mask('abcdefghiJKLM')).toBe(MASK);
  });

  it.each([
    ['right', '***0', `visible:base${'0'.repeat(100_000)}`],
    ['left', '0***', `${'0'.repeat(100_000)}base:visible`],
  ])('fails closed for a long %s-directed replacement cascade', (_direction, cascade, text) => {
    const registry = new SecretRegistry();
    registry.register('base');
    registry.register(cascade);

    // Full convergence would retain the visible text; MASK proves budget exhaustion masks
    // the whole input rather than returning a potentially revealing intermediate value.
    expect(registry.mask(text)).toBe(MASK);
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

  it('refuses two astral code points even though they occupy four UTF-16 code units', () => {
    const registry = new SecretRegistry();
    const secret = '🔑🔑';

    expect(registry.register(secret)).toBe(false);
    expect(registry.size).toBe(0);
    expect(registry.mask(`value: ${secret}`)).toBe(`value: ${secret}`);
  });

  it('registers and masks four astral code points', () => {
    const registry = new SecretRegistry();
    const secret = '🔑🔑🔑🔑';

    expect(registry.register(secret)).toBe(true);
    expect(registry.mask(`value: ${secret}`)).toBe(`value: ${MASK}`);
  });

  it('counts combining marks as code points for the masking threshold', () => {
    const registry = new SecretRegistry();
    const secret = 'e\u0301xy';

    expect(registry.register(secret)).toBe(true);
    expect(registry.mask(`value: ${secret}`)).toBe(`value: ${MASK}`);
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

  it('partially masks multiline astral secrets and reports short lines as incomplete', () => {
    const registry = new SecretRegistry();
    const shortLine = '🔑🔑';
    const longLine = '🔑🔑🔑🔑';
    const secret = `${shortLine}\r\n${longLine}`;

    expect(registry.register(secret)).toBe(false);
    expect(registry.mask(`short: ${shortLine}`)).toBe(`short: ${shortLine}`);
    expect(registry.mask(`long: ${longLine}`)).toBe(`long: ${MASK}`);
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

  it('accepts exactly the snapshot budget and rejects one more unique part atomically', () => {
    const registry = new SecretRegistry();
    const patterns = nestedPatternsForBudget(MAX_SECRET_REGISTRY_CODE_UNITS, 'x');
    for (const pattern of patterns) {
      expect(registry.register(pattern)).toBe(true);
    }
    expect(patterns.reduce((total, pattern) => total + pattern.length, 0)).toBe(
      MAX_SECRET_REGISTRY_CODE_UNITS,
    );
    expect(registry.size).toBe(patterns.length);

    const longest = patterns.at(-1)!;
    expect(registry.mask(longest)).toBe(MASK);
    const transitionWrite = vi.spyOn(Map.prototype, 'set');
    const size = registry.size;
    try {
      expect(registry.register(patterns[0]!)).toBe(true);
      const error = capacityErrorFrom(() => registry.register('yyyy'));

      expect(error.code).toBe('RUNE-202');
      expect(error.message).toBe(
        'the total size of secret input values exceeds the masking safety limit',
      );
      expect(registry.size).toBe(size);
      expect(registry.mask(longest)).toBe(MASK);
      expect(registry.mask('yyyy')).toBe('yyyy');
      expect(transitionWrite).not.toHaveBeenCalled();
    } finally {
      transitionWrite.mockRestore();
    }
  });

  it('preflights every multiline part without leaving a partial registration', () => {
    const registry = new SecretRegistry();
    const patterns = nestedPatternsForBudget(MAX_SECRET_REGISTRY_CODE_UNITS - 15, 'x');
    for (const pattern of patterns) {
      registry.register(pattern);
    }
    const size = registry.size;
    const error = capacityErrorFrom(() => registry.register('alpha\nbravo'));

    expect(error.code).toBe('RUNE-202');
    expect(registry.size).toBe(size);
    expect(registry.mask('alpha/bravo')).toBe('alpha/bravo');
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

  it('keeps combined registries independent from later source mutations', () => {
    const left = new SecretRegistry();
    left.register('left-secret');
    const right = new SecretRegistry();
    right.register('right-secret');

    const combined = left.combinedWith(right);
    left.register('new-left-value');
    right.replaceWith(new SecretRegistry());

    expect(combined.size).toBe(2);
    expect(combined.mask('left-secret/right-secret')).toBe('***/***');
    expect(combined.mask('new-left-value')).toBe('new-left-value');
    expect(left.mask('new-left-value')).toBe(MASK);
    expect(right.mask('right-secret')).toBe('right-secret');
  });

  it('rejects an over-budget registry union before building or publishing it', () => {
    const left = new SecretRegistry();
    const right = new SecretRegistry();
    const half = MAX_SECRET_REGISTRY_CODE_UNITS / 2;
    for (const pattern of nestedPatternsForBudget(half, 'x')) {
      left.register(pattern);
    }
    for (const pattern of nestedPatternsForBudget(half + 1, 'y')) {
      right.register(pattern);
    }
    const transitionWrite = vi.spyOn(Map.prototype, 'set');

    try {
      const error = capacityErrorFrom(() => left.combinedWith(right));

      expect(error.code).toBe('RUNE-202');
      expect(error.message).toBe(
        'the total size of secret input values exceeds the masking safety limit',
      );
      expect(transitionWrite).not.toHaveBeenCalled();
      expect(left.size).toBe(nestedPatternsForBudget(half, 'x').length);
      expect(right.size).toBe(nestedPatternsForBudget(half + 1, 'y').length);
    } finally {
      transitionWrite.mockRestore();
    }
  });

  it('caches one immutable matcher per registry snapshot', () => {
    const registry = new SecretRegistry();
    registry.register('abcdef');
    registry.register('***ghi');
    const transitionWrite = vi.spyOn(Map.prototype, 'set');
    const measuredMask = (target: SecretRegistry, text: string): readonly [string, number] => {
      const before = transitionWrite.mock.calls.length;
      const result = target.mask(text);
      return [result, transitionWrite.mock.calls.length - before];
    };

    try {
      const [empty, emptyWrites] = measuredMask(new SecretRegistry(), 'empty snapshot');
      expect(empty).toBe('empty snapshot');
      expect(emptyWrites).toBe(0);

      const [primed, initialWrites] = measuredMask(registry, 'no match here');
      expect(primed).toBe('no match here');
      expect(initialWrites).toBeGreaterThan(0);

      const [collision, collisionWrites] = measuredMask(registry, 'abcdefghi');
      expect(collision).toBe(MASK);
      expect(collisionWrites).toBe(0);

      registry.register('abcdef');
      const [duplicate, duplicateWrites] = measuredMask(registry, 'abcdef');
      expect(duplicate).toBe(MASK);
      expect(duplicateWrites).toBe(0);

      registry.register('unique-secret');
      const [unique, rebuiltWrites] = measuredMask(registry, 'unique-secret');
      expect(unique).toBe(MASK);
      expect(rebuiltWrites).toBeGreaterThan(0);

      const replacement = new SecretRegistry();
      replacement.register('replacement-secret');
      replacement.mask('prime replacement snapshot');
      registry.replaceWith(replacement);
      const [replaced, replacementWrites] = measuredMask(registry, 'replacement-secret');
      expect(replaced).toBe(MASK);
      expect(replacementWrites).toBe(0);

      replacement.register('independent-later-value');
      expect(registry.mask('independent-later-value')).toBe('independent-later-value');
    } finally {
      transitionWrite.mockRestore();
    }
  });

  it('shares a lazily built matcher across equivalent unions and replacements', () => {
    const source = new SecretRegistry();
    source.register('shared-snapshot-secret');
    const combined = new SecretRegistry().combinedWith(source);
    const replacement = new SecretRegistry();
    replacement.register('shared-snapshot-secret');
    const transitionWrite = vi.spyOn(Map.prototype, 'set');
    const measuredMask = (target: SecretRegistry, text: string): readonly [string, number] => {
      const before = transitionWrite.mock.calls.length;
      const result = target.mask(text);
      return [result, transitionWrite.mock.calls.length - before];
    };

    try {
      const [combinedResult, initialWrites] = measuredMask(combined, 'shared-snapshot-secret');
      expect(combinedResult).toBe(MASK);
      expect(initialWrites).toBeGreaterThan(0);

      const [sourceResult, sourceWrites] = measuredMask(source, 'shared-snapshot-secret');
      expect(sourceResult).toBe(MASK);
      expect(sourceWrites).toBe(0);

      replacement.replaceWith(source);
      const [replacementResult, replacementWrites] = measuredMask(
        replacement,
        'shared-snapshot-secret',
      );
      expect(replacementResult).toBe(MASK);
      expect(replacementWrites).toBe(0);
    } finally {
      transitionWrite.mockRestore();
    }
  });

  it('detaches a shared matcher cache before a later set mutation', () => {
    const source = new SecretRegistry();
    source.register('original-shared-secret');
    const combined = new SecretRegistry().combinedWith(source);
    expect(combined.mask('original-shared-secret')).toBe(MASK);
    const transitionWrite = vi.spyOn(Map.prototype, 'set');
    const writes = (): number => transitionWrite.mock.calls.length;

    try {
      source.register('later-source-secret');
      const beforeRebuild = writes();
      expect(source.mask('original-shared-secret/later-source-secret')).toBe('***/***');
      expect(writes()).toBeGreaterThan(beforeRebuild);

      const beforeCombinedMask = writes();
      expect(combined.mask('original-shared-secret/later-source-secret')).toBe(
        '***/later-source-secret',
      );
      expect(writes()).toBe(beforeCombinedMask);
    } finally {
      transitionWrite.mockRestore();
    }
  });

  it('matches an obvious reference across deterministic overlap and collision cases', () => {
    const cases: { readonly patterns: readonly string[]; readonly texts: readonly string[] }[] = [
      {
        patterns: ['abcd', 'bcde', 'cdef', 'defg'],
        texts: ['zabcdefgz', 'abcdbcdecdefdefg', 'nothing'],
      },
      {
        patterns: ['abcde', 'bcde', 'cdefg'],
        texts: ['abcde', 'zabcdefg', 'abcdebcde'],
      },
      {
        patterns: ['abcd', 'efgh', 'cdef'],
        texts: ['abcdefgh', 'abcdefghabcd', 'abcd-efgh'],
      },
      {
        patterns: ['aaaa', 'aaaab', 'baaaa'],
        texts: ['aaaaa', 'baaaab', 'aaaaaaaaaaaa'],
      },
      {
        patterns: ['🔑🔑🔑🔑', 'a🔑b🔑', 'a\ud83db\udc00'],
        texts: ['x🔑🔑🔑🔑y', 'a🔑b🔑a\ud83db\udc00', '\ud83da\ud83db\udc00\udc00'],
      },
      {
        patterns: ['abcdef', 'ghijkl', '***ghi', 'ghi***', '***middle***'],
        texts: ['abcdefghi', 'ghiabcdef', 'abcdefmiddleghijkl'],
      },
    ];

    for (let seed = 0; seed < 32; seed += 1) {
      const patterns = [
        deterministicText(seed * 3 + 1, 4),
        deterministicText(seed * 5 + 2, 5),
        deterministicText(seed * 7 + 3, 6),
      ];
      cases.push({
        patterns,
        texts: [
          deterministicText(seed * 11, 18),
          `x${patterns[0]}${patterns[1]}y`,
          `${patterns[2]}-${patterns[0]}-${patterns[2]}`,
          patterns[0]!.slice(0, 3) + patterns[1] + patterns[0]!.slice(3),
        ],
      });
    }

    for (const { patterns, texts } of cases) {
      const registry = new SecretRegistry();
      for (const pattern of patterns) {
        registry.register(pattern);
      }
      for (const text of texts) {
        expect(registry.mask(text), `${JSON.stringify(patterns)} in ${JSON.stringify(text)}`).toBe(
          referenceMask(text, patterns),
        );
      }
    }
  });

  it('scans 10k diagnostics independently of a 10k-secret registry', () => {
    const registry = new SecretRegistry();
    for (let index = 0; index < 10_000; index += 1) {
      registry.register(`F050-${index.toString().padStart(5, '0')}-value`);
    }
    registry.mask('prime the cached matcher');

    const diagnostics = Array.from(
      { length: 10_000 },
      (_, index) => `warning: disabled input ${index.toString().padStart(5, '0')}`,
    );
    const expectedCodeUnits = diagnostics.reduce(
      (total, diagnostic) => total + diagnostic.length,
      0,
    );
    const charCodeAt = vi.spyOn(String.prototype, 'charCodeAt');
    const indexOf = vi.spyOn(String.prototype, 'indexOf').mockImplementation(() => {
      throw new Error('masking must not search once per registered secret');
    });
    const charCodeAtBefore = charCodeAt.mock.calls.length;
    let allUnchanged = true;
    let indexOfCalls = 0;
    let charCodeAtCalls = 0;

    try {
      for (const diagnostic of diagnostics) {
        allUnchanged &&= registry.mask(diagnostic) === diagnostic;
      }
      indexOfCalls = indexOf.mock.calls.length;
      charCodeAtCalls = charCodeAt.mock.calls.length - charCodeAtBefore;
    } finally {
      indexOf.mockRestore();
      charCodeAt.mockRestore();
    }

    expect(allUnchanged).toBe(true);
    expect(indexOfCalls).toBe(0);
    expect(charCodeAtCalls).toBe(expectedCodeUnits);
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

describe('secret lifecycle boundary', () => {
  it('allows plaintext reveal only at the spawn-runner boundary', () => {
    const sourceRoot = fileURLToPath(new URL('../../src/', import.meta.url));
    const files = typeScriptFiles(sourceRoot);
    const calls: string[] = [];

    for (const file of files) {
      const source = ts.createSourceFile(
        file,
        readFileSync(file, 'utf8'),
        ts.ScriptTarget.Latest,
        true,
        ts.ScriptKind.TS,
      );
      const visit = (node: ts.Node): void => {
        if (
          ts.isCallExpression(node) &&
          ts.isIdentifier(node.expression) &&
          node.expression.text === 'revealSecretString'
        ) {
          calls.push(relative(sourceRoot, file).replaceAll('\\', '/'));
        }
        ts.forEachChild(node, visit);
      };
      visit(source);
    }

    expect(calls).toEqual(['runners/spawnRunner.ts']);
  }, 30_000);
});

function capacityErrorFrom(action: () => unknown): InputError {
  try {
    action();
  } catch (error) {
    if (error instanceof InputError) {
      return error;
    }
    throw error;
  }
  throw new Error('expected secret registration to exceed its capacity');
}

/** Produces exact aggregate cost with heavily shared prefixes, keeping matcher tests small. */
function nestedPatternsForBudget(budget: number, codeUnit: string): readonly string[] {
  const lengths: number[] = [];
  let total = 0;
  for (let length = MIN_MASKABLE_LENGTH; total + length <= budget; length += 1) {
    lengths.push(length);
    total += length;
  }
  const remainder = budget - total;
  if (remainder > 0) {
    const last = lengths.pop();
    if (last === undefined) {
      throw new Error('budget is too small for a maskable test pattern');
    }
    lengths.push(last + remainder);
  }
  return lengths.map((length) => codeUnit.repeat(length));
}

function typeScriptFiles(directory: string): readonly string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      return typeScriptFiles(path);
    }
    return entry.isFile() && entry.name.endsWith('.ts') ? [path] : [];
  });
}

function deterministicText(seed: number, length: number): string {
  const alphabet = ['a', 'b', 'c', 'd'] as const;
  let state = seed >>> 0;
  let text = '';
  for (let index = 0; index < length; index += 1) {
    state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
    text += alphabet[state % alphabet.length];
  }
  return text;
}

/** Small, intentionally direct oracle used only for differential tests. */
function referenceMask(text: string, patterns: readonly string[]): string {
  let masked = text;
  for (let pass = 0; pass < 16; pass += 1) {
    const next = referenceMaskOnce(masked, patterns);
    if (next === masked) {
      return masked;
    }
    masked = next;
  }
  return MASK;
}

function referenceMaskOnce(text: string, patterns: readonly string[]): string {
  const matches: [number, number][] = [];
  for (const pattern of new Set(patterns)) {
    let start = text.indexOf(pattern);
    while (start !== -1) {
      matches.push([start, start + pattern.length]);
      start = text.indexOf(pattern, start + 1);
    }
  }
  matches.sort((left, right) => left[0] - right[0] || left[1] - right[1]);
  if (matches.length === 0) {
    return text;
  }

  let out = '';
  let cursor = 0;
  let matchStart = matches[0]![0];
  let matchEnd = matches[0]![1];
  for (const [start, end] of matches.slice(1)) {
    if (start < matchEnd) {
      matchEnd = Math.max(matchEnd, end);
    } else {
      out += text.slice(cursor, matchStart) + MASK;
      cursor = matchEnd;
      matchStart = start;
      matchEnd = end;
    }
  }
  return out + text.slice(cursor, matchStart) + MASK + text.slice(matchEnd);
}
