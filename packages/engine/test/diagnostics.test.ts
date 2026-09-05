import { describe, expect, it } from 'vitest';

import { formatDiagnostic, formatDiagnosticRecords, quotedDiagnostic } from '../src/diagnostics.js';
import { SecretRegistry } from '../src/engine/secrets.js';

describe('formatDiagnostic', () => {
  it('fails closed when quoting and control escaping create a registered literal', () => {
    const secret = String.raw`\u001b`;
    const secrets = new SecretRegistry();
    secrets.register(secret);

    const diagnostic = formatDiagnostic([quotedDiagnostic('\u001b')], secrets);

    expect(diagnostic).toBe('***');
    expect(diagnostic).not.toContain(secret);
  });

  it('fails closed without unbalancing quotes when rendered replacements collide', () => {
    const secrets = new SecretRegistry();
    secrets.register('""""');
    secrets.register('"***"');

    const diagnostic = formatDiagnostic([quotedDiagnostic(''), quotedDiagnostic('')], secrets);

    expect(diagnostic).toBe('***');
    expect(diagnostic).not.toContain('"***"');
  });

  it.each([
    ['quotes', String.raw`\"\"`, '""'],
    ['high surrogate', String.raw`\ud800`, '\ud800'],
    ['low surrogate', String.raw`\udfff`, '\udfff'],
  ])('fails closed when JSON string encoding creates a %s secret', (_kind, secret, value) => {
    const secrets = new SecretRegistry();
    secrets.register(secret);

    const diagnostic = formatDiagnostic([value], secrets);

    expect(diagnostic).toBe('***');
    expect(JSON.stringify(diagnostic).slice(1, -1)).not.toContain(secret);
  });

  it.each([
    ['opening', 'prefix "A', ['prefix ', quotedDiagnostic('ATAIL')], '***"TAIL"'],
    ['closing', 'A" suf', [quotedDiagnostic('HEADA'), ' suffix'], '"HEAD***"fix'],
  ] as const)(
    'keeps quotes balanced when masking crosses the %s quote',
    (_side, secret, parts, expected) => {
      const secrets = new SecretRegistry();
      secrets.register(secret);

      const diagnostic = formatDiagnostic(parts, secrets);

      expect(diagnostic).toBe(expected);
      expect(diagnostic).not.toContain(secret);
    },
  );

  it('masks raw quote, backslash, surrogate and control content before rendering it', () => {
    const secret = `prefix "A"B\\C\ud800\u001b`;
    const visibleSecret = 'prefix "A\\"B\\\\C\\ud800\\u001b';
    const secrets = new SecretRegistry();
    secrets.register(secret);

    const diagnostic = formatDiagnostic(
      ['prefix ', quotedDiagnostic(`A"B\\C\ud800\u001bTAIL\u0085\u2028`)],
      secrets,
    );

    expect(diagnostic).toBe('***"TAIL\\u0085\\u2028"');
    expect(diagnostic).not.toContain(secret);
    expect(diagnostic).not.toContain(visibleSecret);
  });

  it('retains exact record topology through replacement-collision passes', () => {
    const secrets = new SecretRegistry();
    secrets.register('abcdef');
    secrets.register('ghijkl');
    secrets.register('***\n""middle\n***');

    const diagnostic = formatDiagnosticRecords(
      [
        ['abcdef', ''],
        [quotedDiagnostic(''), 'middle'],
        ['', 'ghijkl'],
      ],
      secrets,
    );

    expect(diagnostic.split('\n')).toHaveLength(3);
    expect(diagnostic.match(/\n/gu)).toHaveLength(2);
    expect(diagnostic).not.toContain('abcdef');
    expect(diagnostic).not.toContain('ghijkl');
    expect(diagnostic).not.toContain('***\n""middle\n***');
  });

  it('masks many fragmented matches in one forward projection', () => {
    const secrets = new SecretRegistry();
    secrets.register('abcdefgh');
    const parts = Array.from({ length: 10_000 }, () => 'abcdefgh');

    const diagnostic = formatDiagnostic(parts, secrets);

    expect(diagnostic).toBe('***'.repeat(parts.length));

    secrets.register(String.raw`\u001b`);
    expect(formatDiagnostic([...parts, quotedDiagnostic('\u001b')], secrets)).toBe('***');
  });

  it('retains formatter-owned record topology when post-render validation fails', () => {
    const secrets = new SecretRegistry();
    secrets.register(String.raw`\u001b`);

    const diagnostic = formatDiagnosticRecords(
      [[quotedDiagnostic('\u001b')], ['middle'], ['tail']],
      secrets,
    );

    expect(diagnostic).toBe('***\n\n');
  });

  it('fails closed when JSON encoding the aggregate record value creates a secret', () => {
    const secret = String.raw`AAAA\nBBBB`;
    const secrets = new SecretRegistry();
    secrets.register(secret);

    const diagnostic = formatDiagnosticRecords([['AAAA'], ['BBBB']], secrets);

    expect(diagnostic).toBe('***\n');
    expect(JSON.stringify(diagnostic).slice(1, -1)).not.toContain(secret);
  });

  it('keeps record cardinality when readable fallback forms also collide', () => {
    const secrets = new SecretRegistry();
    const protectedTexts = ['AAAA\nBBBB\nCCCC', String.raw`***\n\n`, String.raw`\n\n`];
    for (const secret of protectedTexts) secrets.register(secret);

    const diagnostic = formatDiagnosticRecords([['AAAA'], ['BBBB'], ['CCCC']], secrets);
    const jsonContent = JSON.stringify(diagnostic).slice(1, -1);

    expect(diagnostic).toBe('***\n***\n***');
    expect(diagnostic.split('\n')).toHaveLength(3);
    for (const secret of protectedTexts) {
      expect(diagnostic).not.toContain(secret);
      expect(jsonContent).not.toContain(secret);
    }
  });

  it('finds a bounded same-cardinality marker after many fallback collisions', () => {
    const records = Array.from({ length: 10_000 }, () => ['AAAA'] as const);
    const secrets = new SecretRegistry();
    const protectedTexts = ['AAAA', String.raw`***\n\n`, String.raw`\n\n`, '***\n***'];
    for (let offset = 0; offset < 512; offset += 1) {
      protectedTexts.push(String.fromCodePoint(0x10000 + offset).repeat(4));
    }
    for (const secret of protectedTexts) secrets.register(secret);

    const diagnostic = formatDiagnosticRecords(records, secrets);
    const jsonContent = JSON.stringify(diagnostic).slice(1, -1);

    expect(diagnostic.split('\n')).toHaveLength(records.length);
    expect(diagnostic.codePointAt(0)).toBe(0x10200);
    for (const secret of protectedTexts) {
      expect(diagnostic).not.toContain(secret);
      expect(jsonContent).not.toContain(secret);
    }
  });
});
