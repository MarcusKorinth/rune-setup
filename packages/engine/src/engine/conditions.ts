/**
 * The `when:` condition language (docs/architecture.md §6.2).
 *
 * A closed, hand-written expression language: a tokenizer, a recursive-descent parser, a type
 * checker and an evaluator, and nothing else. There is no `eval`, no `new Function` and no
 * template engine anywhere near a manifest (invariant 2).
 *
 * Because every input declares its type, a condition is fully checkable at `validate` time
 * with no values supplied at all — which is what makes `rune validate` worth running.
 */

import { ConditionError } from '../errors.js';
import type { ValueType } from './context.js';
import { scanReference, type TemplateReference } from './interpolate.js';
import { secretValueIn, secretValuesEqual, type SecretString } from './secrets.js';

/**
 * Guards against a pathological expression; a real condition is a line, not a page. Counted
 * in bytes, so the cap is the 4 KiB the architecture states whatever alphabet is used.
 */
export const MAX_CONDITION_LENGTH = 4096;

/**
 * How deep a condition may nest. The cap is on the *tree*, not on how often the parser calls
 * itself: `&&` and `||` are parsed in a loop and still build one level per operator, so a
 * chain of them costs the parser no recursion at all and would hand the checker and the
 * evaluator — which do recurse — a tree thousands of levels deep.
 */
export const MAX_CONDITION_DEPTH = 32;

/**
 * A `${...}` inside a condition — the very same occurrence a template holds, because §6.1
 * defines one reference grammar and `when:` uses it unchanged.
 */
export type ConditionReference = TemplateReference;

export type ConditionNode =
  | {
      readonly kind: 'literal';
      readonly type: ValueType;
      readonly value: boolean | number | string;
      readonly offset: number;
    }
  | { readonly kind: 'reference'; readonly reference: ConditionReference }
  | { readonly kind: 'not'; readonly operand: ConditionNode; readonly offset: number }
  | {
      readonly kind: 'and' | 'or';
      readonly left: ConditionNode;
      readonly right: ConditionNode;
      readonly offset: number;
    }
  | {
      readonly kind: 'equality';
      readonly negated: boolean;
      readonly left: ConditionNode;
      readonly right: ConditionNode;
      readonly offset: number;
    }
  | {
      readonly kind: 'membership';
      readonly negated: boolean;
      readonly needle: ConditionNode;
      readonly haystack: ConditionNode;
      readonly offset: number;
    };

export type ParseResult =
  | { readonly ok: true; readonly ast: ConditionNode }
  | { readonly ok: false; readonly message: string; readonly offset: number };

/** How a reference is typed while checking; a message explains a reference that has no type. */
export type TypeResolver = (
  reference: ConditionReference,
) =>
  | { readonly ok: true; readonly type: ValueType }
  | { readonly ok: false; readonly message: string };

/** A value a condition can be evaluated against. */
export type ConditionValue = boolean | number | string | readonly string[] | SecretString;

// ---------------------------------------------------------------------------- tokenizer

type TokenKind =
  | 'and'
  | 'or'
  | 'not'
  | 'in'
  | 'equal'
  | 'notEqual'
  | 'open'
  | 'close'
  | 'boolean'
  | 'integer'
  | 'string'
  | 'reference'
  | 'end';

interface Token {
  readonly kind: TokenKind;
  readonly text: string;
  readonly offset: number;
  readonly value?: boolean | number | string;
  readonly segments?: readonly string[];
}

/**
 * The words the language has. A `Map` rather than an object literal: a plain object answers
 * for every name on `Object.prototype`, so `toString` and `constructor` would tokenize as
 * keywords instead of being reported as the bare words they are.
 */
const WORDS = new Map<string, TokenKind>([
  ['and', 'and'],
  ['or', 'or'],
  ['not', 'not'],
  ['in', 'in'],
  ['true', 'boolean'],
  ['false', 'boolean'],
]);

interface TokenizeFailure {
  readonly message: string;
  readonly offset: number;
}

function tokenize(text: string): { tokens: Token[] } | { failure: TokenizeFailure } {
  const tokens: Token[] = [];
  let index = 0;

  while (index < text.length) {
    const char = text[index] ?? '';

    if (/\s/.test(char)) {
      index += 1;
      continue;
    }

    const offset = index;

    if (text.startsWith('&&', index) || text.startsWith('||', index)) {
      tokens.push({
        kind: text.startsWith('&&', index) ? 'and' : 'or',
        text: text.slice(index, index + 2),
        offset,
      });
      index += 2;
      continue;
    }

    if (text.startsWith('==', index) || text.startsWith('!=', index)) {
      tokens.push({
        kind: text.startsWith('==', index) ? 'equal' : 'notEqual',
        text: text.slice(index, index + 2),
        offset,
      });
      index += 2;
      continue;
    }

    if (char === '!') {
      tokens.push({ kind: 'not', text: '!', offset });
      index += 1;
      continue;
    }

    if (char === '(' || char === ')') {
      tokens.push({ kind: char === '(' ? 'open' : 'close', text: char, offset });
      index += 1;
      continue;
    }

    if (char === '"' || char === "'") {
      const quoted = readQuoted(text, index, char);
      if ('failure' in quoted) {
        return quoted;
      }
      tokens.push({
        kind: 'string',
        text: text.slice(index, quoted.next),
        offset,
        value: quoted.value,
      });
      index = quoted.next;
      continue;
    }

    if (text.startsWith('${', index)) {
      // The reference grammar has one reader (§6.1): a `${a-b}` in a condition is the same
      // mistake as a `${a-b}` in an argument, and reads the same way.
      const scan = scanReference(text, index);
      if (!scan.ok) {
        return { failure: { message: scan.message, offset: scan.offset } };
      }
      tokens.push({
        kind: 'reference',
        text: scan.reference.text,
        offset,
        segments: scan.reference.segments,
      });
      index = scan.next;
      continue;
    }

    const number = /^-?\d+/.exec(text.slice(index));
    if (number) {
      const value = Number.parseInt(number[0], 10);
      if (!Number.isSafeInteger(value)) {
        return {
          failure: {
            message: `integer literals must be between ${Number.MIN_SAFE_INTEGER} and ${Number.MAX_SAFE_INTEGER}`,
            offset,
          },
        };
      }
      tokens.push({
        kind: 'integer',
        text: number[0],
        offset,
        value,
      });
      index += number[0].length;
      continue;
    }

    const word = /^[A-Za-z_][A-Za-z0-9_]*/.exec(text.slice(index));
    if (word) {
      const kind = WORDS.get(word[0]);
      if (kind === undefined) {
        return {
          failure: {
            message: `"${word[0]}" is not a value — write a quoted string, or \${${word[0]}} to mean the input`,
            offset,
          },
        };
      }
      tokens.push({
        kind,
        text: word[0],
        offset,
        ...(kind === 'boolean' ? { value: word[0] === 'true' } : {}),
      });
      index += word[0].length;
      continue;
    }

    return { failure: { message: `unexpected character "${char}"`, offset } };
  }

  tokens.push({ kind: 'end', text: '', offset: text.length });
  return { tokens };
}

function readQuoted(
  text: string,
  start: number,
  quote: string,
): { value: string; next: number } | { failure: TokenizeFailure } {
  let value = '';
  let index = start + 1;

  while (index < text.length) {
    const char = text[index] ?? '';
    if (char === '\\') {
      const escaped = text[index + 1];
      if (escaped === undefined) {
        break;
      }
      // Only the quote characters and the backslash are escapable: the language has no
      // other escapes to learn, and an unknown one is a typo worth reporting.
      if (escaped !== '\\' && escaped !== '"' && escaped !== "'") {
        return {
          failure: {
            message: `"\\${escaped}" is not an escape — only \\\\, \\" and \\' are`,
            offset: index,
          },
        };
      }
      value += escaped;
      index += 2;
      continue;
    }
    if (char === quote) {
      return { value, next: index + 1 };
    }
    value += char;
    index += 1;
  }

  return { failure: { message: 'unterminated string', offset: start } };
}

// ------------------------------------------------------------------------------- parser

/** Parses a condition. Reports the first problem: an expression is one line, not a document. */
export function parseCondition(text: string): ParseResult {
  if (Buffer.byteLength(text, 'utf8') > MAX_CONDITION_LENGTH) {
    return {
      ok: false,
      message: `a condition may be at most ${MAX_CONDITION_LENGTH} bytes`,
      offset: 0,
    };
  }

  const tokenized = tokenize(text);
  if ('failure' in tokenized) {
    return { ok: false, message: tokenized.failure.message, offset: tokenized.failure.offset };
  }

  const parser = new Parser(tokenized.tokens);
  try {
    const ast = parser.parseExpression(0);
    parser.expectEnd();
    // The productions cap the parser's own recursion, which is what keeps it from overflowing
    // while it builds the tree. This caps the tree it built, which is what every later walk
    // over it depends on. They are not the same bound — a left-associative chain deepens the
    // tree without deepening the parser — and only this one is the promise the cap makes.
    if (depthOf(ast) > MAX_CONDITION_DEPTH) {
      return {
        ok: false,
        message: `a condition may not nest deeper than ${MAX_CONDITION_DEPTH} levels`,
        offset: offsetOf(ast),
      };
    }
    return { ok: true, ast };
  } catch (error) {
    if (error instanceof ParseFailure) {
      return { ok: false, message: error.message, offset: error.offset };
    }
    throw error;
  }
}

class ParseFailure extends Error {
  readonly offset: number;
  constructor(message: string, offset: number) {
    super(message);
    this.offset = offset;
  }
}

class Parser {
  readonly #tokens: readonly Token[];
  #index = 0;

  constructor(tokens: readonly Token[]) {
    this.#tokens = tokens;
  }

  parseExpression(depth: number): ConditionNode {
    if (depth > MAX_CONDITION_DEPTH) {
      throw new ParseFailure(
        `a condition may not nest deeper than ${MAX_CONDITION_DEPTH} levels`,
        this.#peek().offset,
      );
    }
    return this.#parseOr(depth);
  }

  expectEnd(): void {
    const token = this.#peek();
    if (token.kind !== 'end') {
      throw new ParseFailure(`unexpected "${token.text}"`, token.offset);
    }
  }

  #parseOr(depth: number): ConditionNode {
    let left = this.#parseAnd(depth);
    while (this.#peek().kind === 'or') {
      const operator = this.#next();
      const right = this.#parseAnd(depth + 1);
      left = { kind: 'or', left, right, offset: operator.offset };
    }
    return left;
  }

  #parseAnd(depth: number): ConditionNode {
    let left = this.#parseNot(depth);
    while (this.#peek().kind === 'and') {
      const operator = this.#next();
      const right = this.#parseNot(depth + 1);
      left = { kind: 'and', left, right, offset: operator.offset };
    }
    return left;
  }

  #parseNot(depth: number): ConditionNode {
    // The cap belongs on every recursive descent, not only where parentheses re-enter the
    // grammar: `!` is one character, so an unguarded chain of them fits inside the length
    // cap and would hand a tree thousands of levels deep to the checker and the evaluator.
    if (depth > MAX_CONDITION_DEPTH) {
      throw new ParseFailure(
        `a condition may not nest deeper than ${MAX_CONDITION_DEPTH} levels`,
        this.#peek().offset,
      );
    }

    if (this.#peek().kind === 'not' && this.#peek(1).kind !== 'in') {
      const operator = this.#next();
      return { kind: 'not', operand: this.#parseNot(depth + 1), offset: operator.offset };
    }
    return this.#parseComparison(depth);
  }

  #parseComparison(depth: number): ConditionNode {
    const left = this.#parseTerm(depth);
    const token = this.#peek();

    if (token.kind === 'equal' || token.kind === 'notEqual') {
      this.#next();
      return {
        kind: 'equality',
        negated: token.kind === 'notEqual',
        left,
        right: this.#parseTerm(depth + 1),
        offset: token.offset,
      };
    }

    // Only the word form negates membership: the grammar spells it `["not"] "in"`, and
    // `! in` would be a second spelling of one thing.
    const negated = token.kind === 'not' && token.text === 'not';
    if (token.kind === 'not' && !negated && this.#peek(1).kind === 'in') {
      throw new ParseFailure('membership is negated with "not in", not with "! in"', token.offset);
    }
    if (negated && this.#peek(1).kind !== 'in') {
      throw new ParseFailure('"not" here must be followed by "in"', token.offset);
    }
    if (negated || token.kind === 'in') {
      if (negated) {
        this.#next();
      }
      const operator = this.#next();
      return {
        kind: 'membership',
        negated,
        needle: left,
        haystack: this.#parseTerm(depth + 1),
        offset: operator.offset,
      };
    }

    return left;
  }

  #parseTerm(depth: number): ConditionNode {
    const token = this.#next();

    switch (token.kind) {
      case 'open': {
        const inner = this.parseExpression(depth + 1);
        const close = this.#next();
        if (close.kind !== 'close') {
          throw new ParseFailure('missing ")"', close.offset);
        }
        return inner;
      }
      case 'boolean':
        return {
          kind: 'literal',
          type: 'boolean',
          value: token.value === true,
          offset: token.offset,
        };
      case 'integer':
        return {
          kind: 'literal',
          type: 'integer',
          value: typeof token.value === 'number' ? token.value : 0,
          offset: token.offset,
        };
      case 'string':
        return {
          kind: 'literal',
          type: 'string',
          value: typeof token.value === 'string' ? token.value : '',
          offset: token.offset,
        };
      case 'reference':
        return {
          kind: 'reference',
          reference: { segments: token.segments ?? [], text: token.text, offset: token.offset },
        };
      case 'end':
        throw new ParseFailure('the condition ends where a value was expected', token.offset);
      default:
        throw new ParseFailure(`"${token.text}" is not a value`, token.offset);
    }
  }

  #peek(ahead = 0): Token {
    return this.#tokens[Math.min(this.#index + ahead, this.#tokens.length - 1)] as Token;
  }

  #next(): Token {
    const token = this.#peek();
    if (token.kind !== 'end') {
      this.#index += 1;
    }
    return token;
  }
}

// --------------------------------------------------------------------------------- tree

/** The operands of a node, in source order. One place knows the shape of the tree. */
export function childrenOf(node: ConditionNode): readonly ConditionNode[] {
  switch (node.kind) {
    case 'literal':
    case 'reference':
      return [];
    case 'not':
      return [node.operand];
    case 'and':
    case 'or':
    case 'equality':
      return [node.left, node.right];
    case 'membership':
      return [node.needle, node.haystack];
  }
}

/** Where a node stands in the condition, for a message about it. */
export function offsetOf(node: ConditionNode): number {
  return node.kind === 'reference' ? node.reference.offset : node.offset;
}

/** How deep a tree is: a leaf is 0, and every operand below a node is one more level. */
function depthOf(root: ConditionNode): number {
  let deepest = 0;
  // Iteratively, because a tree that may be too deep to walk is exactly what is being measured.
  const pending: [ConditionNode, number][] = [[root, 0]];

  for (let entry = pending.pop(); entry !== undefined; entry = pending.pop()) {
    const [node, depth] = entry;
    if (depth > deepest) {
      deepest = depth;
    }
    for (const child of childrenOf(node)) {
      pending.push([child, depth + 1]);
    }
  }

  return deepest;
}

// -------------------------------------------------------------------------- type checker

/**
 * Checks a condition against the declared types, collecting every problem. Typing is strict
 * on purpose: only a declared boolean may stand on its own, because loose truthiness could
 * never be tightened again once manifests rely on it (§6.2).
 */
export function typeCheckCondition(ast: ConditionNode, resolve: TypeResolver): readonly string[] {
  const problems: string[] = [];
  const type = inferType(ast, resolve, problems);

  if (type !== undefined && type !== 'boolean') {
    problems.push(`${describe(ast)} is ${article(type)}, not a condition${adviceFor(ast, type)}`);
  }

  return problems;
}

function inferType(
  node: ConditionNode,
  resolve: TypeResolver,
  problems: string[],
): ValueType | undefined {
  switch (node.kind) {
    case 'literal':
      return node.type;

    case 'reference': {
      const resolved = resolve(node.reference);
      if (!resolved.ok) {
        problems.push(resolved.message);
        return undefined;
      }
      return resolved.type;
    }

    case 'not': {
      expectBoolean(node.operand, resolve, problems);
      return 'boolean';
    }

    case 'and':
    case 'or': {
      expectBoolean(node.left, resolve, problems);
      expectBoolean(node.right, resolve, problems);
      return 'boolean';
    }

    case 'equality': {
      const left = inferType(node.left, resolve, problems);
      const right = inferType(node.right, resolve, problems);
      if (left !== undefined && right !== undefined) {
        if (left === 'stringList' || right === 'stringList') {
          problems.push(
            `a multiselect value cannot be compared with ${node.negated ? '!=' : '=='} — test one of its entries with "in"`,
          );
        } else if (left !== right) {
          problems.push(
            `${describe(node.left)} is ${article(left)} and ${describe(node.right)} is ${article(right)} — only values of the same type can be compared`,
          );
        }
      }
      return 'boolean';
    }

    case 'membership': {
      const needle = inferType(node.needle, resolve, problems);
      const haystack = inferType(node.haystack, resolve, problems);
      if (needle !== undefined && needle !== 'string') {
        problems.push(`"in" tests a string, but ${describe(node.needle)} is ${article(needle)}`);
      }
      if (haystack !== undefined && haystack !== 'stringList') {
        problems.push(
          `"in" tests membership in a multiselect value, but ${describe(node.haystack)} is ${article(haystack)}`,
        );
      }
      return 'boolean';
    }
  }
}

function expectBoolean(node: ConditionNode, resolve: TypeResolver, problems: string[]): void {
  const type = inferType(node, resolve, problems);
  if (type !== undefined && type !== 'boolean') {
    problems.push(`${describe(node)} is ${article(type)}, not a condition${adviceFor(node, type)}`);
  }
}

/** The nudge that turns "wrong type" into a fix the author can copy. */
function adviceFor(node: ConditionNode, type: ValueType): string {
  if (node.kind !== 'reference') {
    return '';
  }
  // Exhaustive on purpose: an example is only worth printing if the type checker would accept
  // it, so a value type added later must bring its own or say it has none.
  switch (type) {
    case 'string':
      return ` — compare it explicitly, for example ${node.reference.text} == 'production'`;
    case 'integer':
      return ` — compare it explicitly, for example ${node.reference.text} == 1`;
    case 'stringList':
      return ` — test one of its entries, for example 'git' in ${node.reference.text}`;
    case 'boolean':
      return '';
  }
}

function describe(node: ConditionNode): string {
  switch (node.kind) {
    case 'reference':
      return node.reference.text;
    case 'literal':
      return typeof node.value === 'string' ? `"${node.value}"` : String(node.value);
    default:
      return 'the expression';
  }
}

function article(type: ValueType): string {
  switch (type) {
    case 'boolean':
      return 'a boolean';
    case 'string':
      return 'a string';
    case 'integer':
      return 'a number';
    case 'stringList':
      return 'a multiselect value';
  }
}

// ---------------------------------------------------------------------------- evaluator

/**
 * Evaluates a type-checked condition. `lookup` supplies the value of a reference; a value of
 * an unexpected type is a bug rather than an author's mistake, and says so.
 */
export function evaluateCondition(
  ast: ConditionNode,
  lookup: (reference: ConditionReference) => ConditionValue,
): boolean {
  const value = evaluate(ast, lookup);
  if (typeof value !== 'boolean') {
    throw new ConditionError('RUNE-312', 'the condition did not evaluate to true or false');
  }
  return value;
}

function evaluate(
  node: ConditionNode,
  lookup: (reference: ConditionReference) => ConditionValue,
): ConditionValue {
  switch (node.kind) {
    case 'literal':
      return node.value;
    case 'reference':
      return lookup(node.reference);
    case 'not':
      return !asBoolean(evaluate(node.operand, lookup));
    case 'and':
      return asBoolean(evaluate(node.left, lookup)) && asBoolean(evaluate(node.right, lookup));
    case 'or':
      return asBoolean(evaluate(node.left, lookup)) || asBoolean(evaluate(node.right, lookup));
    case 'equality': {
      const left = evaluate(node.left, lookup);
      const right = evaluate(node.right, lookup);
      const equal = secretValuesEqual(left, right) ?? left === right;
      return node.negated ? !equal : equal;
    }
    case 'membership': {
      const needle = evaluate(node.needle, lookup);
      const haystack = evaluate(node.haystack, lookup);
      if (!Array.isArray(haystack)) {
        throw new ConditionError('RUNE-312', '"in" needs a multiselect value on its right');
      }
      const strings = haystack as readonly string[];
      const found = secretValueIn(needle, strings) ?? strings.includes(asString(needle));
      return node.negated ? !found : found;
    }
  }
}

function asBoolean(value: ConditionValue): boolean {
  if (typeof value !== 'boolean') {
    throw new ConditionError('RUNE-312', 'a condition operand did not evaluate to true or false');
  }
  return value;
}

function asString(value: ConditionValue): string {
  if (typeof value !== 'string') {
    throw new ConditionError('RUNE-312', '"in" tests a string, and was given something else');
  }
  return value;
}
