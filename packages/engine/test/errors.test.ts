import { describe, expect, it } from 'vitest';

import {
  CancelledError,
  ConditionError,
  ExecutionError,
  exitCodeFor,
  formatIssues,
  InputError,
  InternalError,
  ManifestError,
  projectRuneError,
  ResolutionError,
  RuneError,
  UsageError,
  type RuneCode,
  type RuneIssue,
} from '../src/errors.js';
import { SecretRegistry } from '../src/engine/secrets.js';

/** Every code of docs/architecture.md §7 with the exit code §10 assigns to it. */
const EXPECTED_EXIT_CODES: ReadonlyArray<readonly [RuneCode, number]> = [
  ['RUNE-001', 2],
  ['RUNE-101', 3],
  ['RUNE-102', 3],
  ['RUNE-103', 3],
  ['RUNE-104', 3],
  ['RUNE-201', 4],
  ['RUNE-202', 4],
  ['RUNE-203', 4],
  ['RUNE-301', 5],
  ['RUNE-302', 5],
  ['RUNE-311', 5],
  ['RUNE-312', 5],
  ['RUNE-401', 1],
  ['RUNE-402', 1],
  ['RUNE-403', 1],
  ['RUNE-404', 1],
  ['RUNE-405', 1],
  ['RUNE-406', 1],
  ['RUNE-500', 70],
  ['RUNE-601', 6],
];

describe('exit codes', () => {
  it.each(EXPECTED_EXIT_CODES)('maps %s to exit %i', (code, expected) => {
    expect(exitCodeFor(new RuneError(code, 'boom'))).toBe(expected);
  });

  it('maps every error class to its documented code family', () => {
    expect(exitCodeFor(new UsageError('bad flag'))).toBe(2);
    expect(exitCodeFor(new ManifestError('RUNE-103', 'bad manifest'))).toBe(3);
    expect(exitCodeFor(new InputError('RUNE-201', 'missing'))).toBe(4);
    expect(exitCodeFor(new ResolutionError('RUNE-301', 'undefined variable'))).toBe(5);
    expect(exitCodeFor(new ConditionError('RUNE-312', 'type error'))).toBe(5);
    expect(exitCodeFor(new ExecutionError('RUNE-401', 'step failed'))).toBe(1);
    expect(exitCodeFor(new CancelledError())).toBe(6);
    expect(exitCodeFor(new InternalError('unreachable'))).toBe(70);
  });

  it('treats anything that is not a RuneError as an internal error', () => {
    expect(exitCodeFor(new TypeError('undefined is not a function'))).toBe(70);
    expect(exitCodeFor('a thrown string')).toBe(70);
    expect(exitCodeFor(undefined)).toBe(70);
  });
});

describe('RuneError', () => {
  it('carries code, location and a single issue by default', () => {
    const location = { file: 'installer.yaml', line: 7, column: 3 };
    const error = new ManifestError('RUNE-104', 'step ids must be unique', { location });

    expect(error).toBeInstanceOf(RuneError);
    expect(error.name).toBe('ManifestError');
    expect(error.code).toBe('RUNE-104');
    expect(error.location).toEqual(location);
    expect(error.issues).toEqual([
      { code: 'RUNE-104', message: 'step ids must be unique', location },
    ]);
  });

  it('keeps the cause when one is given', () => {
    const cause = new Error('ENOENT');
    expect(new ManifestError('RUNE-101', 'cannot read', { cause }).cause).toBe(cause);
  });

  it('projects the complete InternalError text once, including its fixed suffix and stack', () => {
    const marker = 'RUNE';
    const secrets = new SecretRegistry();
    secrets.register(marker);
    const originalCause = new Error(`cause contains ${marker}`);
    const original = new InternalError(`detail contains ${marker}`, { cause: originalCause });

    const projected = projectRuneError(original, (text) => secrets.mask(text));

    expect(projected).toBeInstanceOf(InternalError);
    expect(projected.code).toBe('RUNE-500');
    expect(projected.message).not.toContain(marker);
    expect(projected.stack).not.toContain(marker);
    expect(projected.issues[0]?.message).not.toContain(marker);
    expect(projected.message.match(/this is a bug/g)).toHaveLength(1);
    expect(projected.cause).toBeInstanceOf(Error);
    expect(projected.cause).not.toBe(originalCause);
    expect((projected.cause as Error).message).not.toContain(marker);
  });

  it('collects many issues into one error whose message lists them all', () => {
    const issues: RuneIssue[] = [
      {
        code: 'RUNE-104',
        message: 'first problem',
        location: { file: 'a.yaml', line: 2, column: 1 },
      },
      { code: 'RUNE-104', message: 'second problem', location: undefined },
    ];

    const error = ManifestError.fromIssues('RUNE-104', issues);

    expect(error.issues).toHaveLength(2);
    expect(error.message).toBe('a.yaml:2:1: first problem\nsecond problem');
  });

  it('refuses to build an error out of nothing', () => {
    expect(() => ManifestError.fromIssues('RUNE-104', [])).toThrow(InternalError);
  });
});

describe('formatIssues', () => {
  it('prefixes located issues and leaves the others alone', () => {
    expect(
      formatIssues([
        { code: 'RUNE-103', message: 'located', location: { file: 'f.yaml', line: 1, column: 2 } },
        { code: 'RUNE-103', message: 'unlocated', location: undefined },
      ]),
    ).toBe('f.yaml:1:2: located\nunlocated');
  });
});
