import { describe, expect, it } from 'vitest';

import {
  evaluateCondition,
  MAX_CONDITION_DEPTH,
  MAX_CONDITION_LENGTH,
  parseCondition,
  typeCheckCondition,
  type ConditionNode,
  type ConditionValue,
  type TypeResolver,
} from '../../src/engine/conditions.js';
import { ConditionError } from '../../src/errors.js';
import type { ValueType } from '../../src/engine/context.js';

/** The declared inputs a condition is checked against, by name. */
const TYPES: Readonly<Record<string, ValueType>> = {
  installDatabase: 'boolean',
  verbose: 'boolean',
  environment: 'string',
  tools: 'stringList',
};

const resolver: TypeResolver = (reference) => {
  const type = TYPES[reference.segments.join('.')];
  return type === undefined
    ? { ok: false, message: `${reference.text} is not declared` }
    : { ok: true, type };
};

function ast(text: string): ConditionNode {
  const parsed = parseCondition(text);
  if (!parsed.ok) {
    throw new Error(`expected ${JSON.stringify(text)} to parse: ${parsed.message}`);
  }
  return parsed.ast;
}

function syntaxError(text: string): string {
  const parsed = parseCondition(text);
  if (parsed.ok) {
    throw new Error(`expected ${JSON.stringify(text)} to be rejected`);
  }
  return parsed.message;
}

function typeErrors(text: string): readonly string[] {
  return typeCheckCondition(ast(text), resolver);
}

/** Evaluates against a fixed set of values. */
function evaluate(text: string, values: Readonly<Record<string, ConditionValue>>): boolean {
  return evaluateCondition(ast(text), (reference) => {
    const value = values[reference.segments.join('.')];
    if (value === undefined) {
      throw new Error(`no value for ${reference.text}`);
    }
    return value;
  });
}

describe('syntax', () => {
  it.each([
    '${installDatabase}',
    'true',
    '!${installDatabase}',
    'not ${installDatabase}',
    '${installDatabase} && ${verbose}',
    '${installDatabase} and ${verbose}',
    '${installDatabase} || ${verbose}',
    '${installDatabase} or ${verbose}',
    "${environment} == 'production'",
    '${environment} != "staging"',
    "'git' in ${tools}",
    "'git' not in ${tools}",
    '(${installDatabase} || ${verbose}) && ${environment} == "prod"',
  ])('accepts %s', (text) => {
    expect(parseCondition(text).ok).toBe(true);
  });

  it('rejects a bare word, which is neither a value nor a reference', () => {
    expect(syntaxError('production')).toBe(
      '"production" is not a value — write a quoted string, or ${production} to mean the input',
    );
  });

  it('rejects what a condition cannot contain', () => {
    expect(syntaxError('${a} +')).toMatch(/unexpected character "\+"/);
    expect(syntaxError('${a} ==')).toMatch(/ends where a value was expected/);
    expect(syntaxError('(${a}')).toMatch(/missing "\)"/);
    expect(syntaxError('${a} ${b}')).toMatch(/unexpected "\$\{b\}"/);
    expect(syntaxError('${a} not ${b}')).toBe('"not" here must be followed by "in"');
    expect(syntaxError("'unclosed")).toBe('unterminated string');
    expect(syntaxError('${unclosed')).toMatch(/unterminated \$\{/);
  });

  it('explains a malformed reference the way a template does, because it is one grammar', () => {
    expect(syntaxError('${a-b}')).toBe(
      '${a-b} is not a name: "a-b" must match [A-Za-z_][A-Za-z0-9_]*',
    );
    expect(syntaxError('${}')).toBe('${} names nothing');
    expect(syntaxError('${env.}')).toBe('${env.} has an empty segment');
  });

  it('reports where the problem is, not only that there is one', () => {
    const parsed = parseCondition('${a} && oops');
    expect(parsed.ok).toBe(false);
    expect(parsed.ok ? -1 : parsed.offset).toBe(8);
  });

  it('reads quoted strings with the two escapes it has', () => {
    expect(evaluate("'a\\'b' == \"a'b\"", {})).toBe(true);
    expect(evaluate('"back\\\\slash" == \'back\\\\slash\'', {})).toBe(true);
    expect(syntaxError("'\\n'")).toMatch(/is not an escape/);
  });

  it('measures the length cap in bytes, at the boundary', () => {
    const padding = 'a'.repeat(MAX_CONDITION_LENGTH - 9);

    expect(parseCondition(`'x' == '${padding}'`).ok).toBe(true);
    expect(syntaxError(`'x' == '${padding}a'`)).toBe(
      `a condition may be at most ${MAX_CONDITION_LENGTH} bytes`,
    );
    // The same text in an alphabet that needs more than one byte per character reaches the
    // cap sooner — 4 KiB is 4 KiB whatever is written.
    expect(syntaxError(`'x' == '${'ü'.repeat(MAX_CONDITION_LENGTH / 2)}'`)).toMatch(/bytes/);
  });

  it('refuses nesting deeper than the documented cap, at the boundary', () => {
    const nest = (depth: number): string => `${'('.repeat(depth)}true${')'.repeat(depth)}`;

    expect(parseCondition(nest(MAX_CONDITION_DEPTH)).ok).toBe(true);
    expect(syntaxError(nest(MAX_CONDITION_DEPTH + 2))).toMatch(/may not nest deeper/);
  });

  it('caps a chain of negations too, so no production escapes the depth cap', () => {
    // `!` is one character, so an unguarded chain fits inside the length cap and would hand
    // a tree thousands of levels deep to the type checker.
    expect(parseCondition(`${'!'.repeat(MAX_CONDITION_DEPTH)}true`).ok).toBe(true);
    expect(syntaxError(`${'!'.repeat(MAX_CONDITION_DEPTH + 2)}true`)).toMatch(
      /may not nest deeper/,
    );
    expect(syntaxError(`${'!'.repeat(2000)}true`)).toMatch(/may not nest deeper/);
  });

  it('caps a chain of operators, which deepens the tree without deepening the parser', () => {
    // `&&` and `||` are parsed in a loop, so the parser never recurses over a chain of them
    // — but the tree is left-leaning, one level per operator, and the checker and the
    // evaluator do recurse. The cap is on what they walk.
    const chain = (count: number): string =>
      Array.from({ length: count + 1 }, () => 'true').join(' || ');

    expect(parseCondition(chain(MAX_CONDITION_DEPTH)).ok).toBe(true);
    expect(syntaxError(chain(MAX_CONDITION_DEPTH + 1))).toMatch(/may not nest deeper/);
    // `&&` reads the same way; the two chains share one bound because they share one tree.
    expect(syntaxError('1'.concat('&&1'.repeat(MAX_CONDITION_DEPTH + 1)))).toMatch(
      /may not nest deeper/,
    );
  });

  it('refuses the deepest chain the length cap allows instead of handing it on', () => {
    // 1365 operators fit inside 4 KiB and used to parse, leaving typeCheckCondition() to
    // recurse 1365 frames and overflow the stack with a RangeError no caller can locate.
    const text = '1||'.repeat(1365) + '1';

    expect(Buffer.byteLength(text, 'utf8')).toBe(MAX_CONDITION_LENGTH);
    expect(syntaxError(text)).toMatch(/may not nest deeper/);
  });

  it('negates membership with the word, not with the exclamation mark', () => {
    expect(parseCondition("'git' not in ${tools}").ok).toBe(true);
    expect(syntaxError("'git' ! in ${tools}")).toBe(
      'membership is negated with "not in", not with "! in"',
    );
  });

  it('does not mistake a member of Object.prototype for a keyword', () => {
    // A plain object lookup would answer for these and tokenize them as language words.
    for (const word of ['constructor', 'toString', 'valueOf', 'hasOwnProperty']) {
      expect(syntaxError(word)).toBe(
        `"${word}" is not a value — write a quoted string, or \${${word}} to mean the input`,
      );
    }
  });

  it('binds && tighter than ||, as the grammar reads', () => {
    expect(ast('${a} && ${b} || ${c}')).toMatchObject({ kind: 'or', left: { kind: 'and' } });
    expect(ast('${a} || ${b} && ${c}')).toMatchObject({ kind: 'or', right: { kind: 'and' } });
  });
});

describe('typing', () => {
  it('accepts a declared boolean standing on its own', () => {
    expect(typeErrors('${installDatabase}')).toEqual([]);
  });

  it('refuses anything else standing on its own, and says what to write instead', () => {
    expect(typeErrors('${environment}')).toEqual([
      "${environment} is a string, not a condition — compare it explicitly, for example ${environment} == 'production'",
    ]);
    expect(typeErrors('${tools}')).toEqual([
      "${tools} is a multiselect value, not a condition — test one of its entries, for example 'git' in ${tools}",
    ]);
    expect(typeErrors('42')).toEqual(['42 is a number, not a condition']);
  });

  it('refuses a comparison between different types', () => {
    expect(typeErrors("${installDatabase} == 'true'")).toEqual([
      '${installDatabase} is a boolean and "true" is a string — only values of the same type can be compared',
    ]);
  });

  it('accepts a comparison between the same types', () => {
    expect(typeErrors("${environment} == 'production'")).toEqual([]);
    expect(typeErrors('${installDatabase} != ${verbose}')).toEqual([]);
  });

  it('points a multiselect comparison at "in"', () => {
    expect(typeErrors('${tools} == ${tools}')).toEqual([
      'a multiselect value cannot be compared with == — test one of its entries with "in"',
    ]);
  });

  it('checks both sides of "in"', () => {
    expect(typeErrors("'git' in ${tools}")).toEqual([]);
    expect(typeErrors("'git' in ${environment}")).toEqual([
      '"in" tests membership in a multiselect value, but ${environment} is a string',
    ]);
    expect(typeErrors('${installDatabase} in ${tools}')).toEqual([
      '"in" tests a string, but ${installDatabase} is a boolean',
    ]);
  });

  it('requires boolean operands for the logical operators', () => {
    expect(typeErrors('${environment} && ${installDatabase}')).toEqual([
      "${environment} is a string, not a condition — compare it explicitly, for example ${environment} == 'production'",
    ]);
    expect(typeErrors('!${tools}')).toEqual([
      "${tools} is a multiselect value, not a condition — test one of its entries, for example 'git' in ${tools}",
    ]);
  });

  it('reports every problem, not only the first', () => {
    expect(typeErrors('${environment} && ${tools}')).toEqual([
      "${environment} is a string, not a condition — compare it explicitly, for example ${environment} == 'production'",
      "${tools} is a multiselect value, not a condition — test one of its entries, for example 'git' in ${tools}",
    ]);
  });

  it('says the same about != as about ==', () => {
    expect(typeErrors('${tools} != ${tools}')).toEqual([
      'a multiselect value cannot be compared with != — test one of its entries with "in"',
    ]);
  });

  it('passes an undeclared reference through as the resolver described it', () => {
    expect(typeErrors('${nope}')).toEqual(['${nope} is not declared']);
  });
});

describe('evaluation', () => {
  const values = {
    installDatabase: true,
    verbose: false,
    environment: 'production',
    tools: ['git', 'docker'],
  } satisfies Record<string, ConditionValue>;

  it.each([
    ['${installDatabase}', true],
    ['!${installDatabase}', false],
    ['not ${verbose}', true],
    ['${installDatabase} && ${verbose}', false],
    ['${installDatabase} || ${verbose}', true],
    ["${environment} == 'production'", true],
    ["${environment} != 'production'", false],
    ["'git' in ${tools}", true],
    ["'podman' in ${tools}", false],
    ["'podman' not in ${tools}", true],
    ["(${verbose} || ${installDatabase}) && 'git' in ${tools}", true],
    ['true', true],
    ['false', false],
  ])('evaluates %s to %s', (text, expected) => {
    expect(evaluate(text, values)).toBe(expected);
  });

  it('applies "not" to the whole comparison, as the grammar reads', () => {
    expect(evaluate("!${environment} == 'production'", values)).toBe(false);
    expect(evaluate("!${environment} == 'staging'", values)).toBe(true);
  });

  it('stops as soon as the answer is known, so an operand it never needs is never read', () => {
    const read: string[] = [];
    const watch = (text: string): boolean =>
      evaluateCondition(ast(text), (reference) => {
        const name = reference.segments.join('.');
        read.push(name);
        return values[name as keyof typeof values];
      });

    expect(watch('${verbose} && ${installDatabase}')).toBe(false);
    expect(read).toEqual(['verbose']);

    read.length = 0;
    expect(watch('${installDatabase} || ${verbose}')).toBe(true);
    expect(read).toEqual(['installDatabase']);
  });

  it('refuses to guess when a value is not the type the grammar expects', () => {
    expect(() => evaluateCondition(ast('${environment}'), () => 'production')).toThrow(
      ConditionError,
    );
    expect(() => evaluateCondition(ast("'git' in ${environment}"), () => 'production')).toThrow(
      /multiselect value on its right/,
    );
    // The operands of the logical operators are guarded too, not only the result.
    expect(() => evaluateCondition(ast('${a} && ${b}'), () => 'not a boolean')).toThrow(
      /operand did not evaluate to true or false/,
    );
    expect(() => evaluateCondition(ast('!${a}'), () => 'not a boolean')).toThrow(ConditionError);
    // Including the left of "in", which used to be coerced: a number needle silently found
    // itself in ['5'] instead of reporting that the value was never the type "in" tests.
    expect(() =>
      evaluateCondition(ast('${n} in ${tools}'), (reference) =>
        reference.text === '${n}' ? 5 : ['5'],
      ),
    ).toThrow(/"in" tests a string/);
  });
});
