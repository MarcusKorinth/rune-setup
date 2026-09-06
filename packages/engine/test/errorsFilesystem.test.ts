import { describe, expect, it } from 'vitest';

import { errnoCodeOf, filesystemFailureReason } from '../src/errors.js';

/**
 * The reason an operational sink appends to its own message (docs/architecture.md §10): fixed,
 * derived from the errno code alone, never the raw OS message. A real result-file failure can
 * only produce three of the mapped codes, so the mapping, both value-free fallbacks and the
 * errno shape guard are pinned here instead.
 */

/** Raw OS text of the kind Node puts in a system error; none of it may reach a RUNE message. */
const RAW_OS_MESSAGE = "EACCES: permission denied, open 'C:\\Users\\someone\\secret\\result.json'";

/** Every errno RUNE enumerates, with the phrase its reason uses. Transcribed, not imported. */
const MAPPED_PHRASES: ReadonlyArray<readonly [string, string]> = [
  ['EACCES', 'permission denied'],
  ['EPERM', 'the operation is not permitted'],
  ['EISDIR', 'the path is a directory'],
  ['ENOTDIR', 'a path component is not a directory'],
  ['ENOENT', 'the path does not exist'],
  ['EEXIST', 'a path component already exists and is not a directory'],
  ['ENOTEMPTY', 'the path is a non-empty directory'],
  ['EBUSY', 'the path is in use'],
  ['EROFS', 'the file system is read-only'],
  ['ENOSPC', 'no space is left on the device'],
  ['EMFILE', 'too many files are open'],
  ['ENFILE', 'too many files are open'],
  ['ENAMETOOLONG', 'the path is too long'],
  ['EINVAL', 'the path is invalid'],
];

/** Errnos a sink can meet that RUNE does not enumerate; `E2BIG` also carries the digit shape. */
const UNMAPPED_CODES: readonly string[] = ['ELOOP', 'EDQUOT', 'EIO', 'EFBIG', 'ETXTBSY', 'E2BIG'];

/** Causes whose `code` is not errno-shaped, including one an attacker could choose. */
const MALFORMED_CODES: ReadonlyArray<readonly [string, unknown]> = [
  ['a lowercase code', 'eacces'],
  ['a digit-first code', '2EACCES'],
  ['an underscored Node code', 'ERR_INVALID_ARG_TYPE'],
  ['a long attacker-controlled code', `E${'A'.repeat(64)} at C:\\Users\\someone\\secret`],
  ['an object code', { toString: () => 'EACCES' }],
  ['a numeric code', 13],
];

/** A rejection shaped like Node's: raw OS text in the message, the code beside it. */
function systemError(code: unknown, message: string = RAW_OS_MESSAGE): unknown {
  return Object.assign(new Error(message), { code });
}

/** §10: the reason repeats nothing the OS wrote — no message, no path fragment, no `CODE:`. */
function expectValueFree(reason: string): void {
  expect(reason).toMatch(/^[a-z -]+(?: \(E[A-Z0-9]+\))?$/u);
  expect(reason).not.toContain(RAW_OS_MESSAGE);
  expect(reason).not.toContain('permission denied, open');
  expect(reason).not.toContain('secret');
  expect(reason).not.toContain('C:\\');
  expect(reason).not.toMatch(/E[A-Z0-9]+:/u);
}

describe('filesystemFailureReason', () => {
  it.each(MAPPED_PHRASES)('reports %s as its fixed phrase with the code', (code, phrase) => {
    const reason = filesystemFailureReason(systemError(code));

    expect(reason).toBe(`${phrase} (${code})`);
    expectValueFree(reason);
  });

  it.each(UNMAPPED_CODES)('falls back to the value-free reason for the unmapped %s', (code) => {
    const reason = filesystemFailureReason(systemError(code));

    expect(reason).toBe(`the operation failed (${code})`);
    expectValueFree(reason);
  });

  it('falls back to the value-free reason when the cause carries no code', () => {
    const reason = filesystemFailureReason(new Error(RAW_OS_MESSAGE));

    expect(reason).toBe('the operation failed');
    expectValueFree(reason);
  });

  it.each(MALFORMED_CODES)('ignores %s and never repeats it', (_shape, code) => {
    const reason = filesystemFailureReason(systemError(code));

    expect(reason).toBe('the operation failed');
    expect(reason).not.toContain(String(code));
    expectValueFree(reason);
  });

  it('ignores a cause that is not an Error', () => {
    expect(filesystemFailureReason('EACCES')).toBe('the operation failed');
    expect(filesystemFailureReason({ code: 'EACCES', message: RAW_OS_MESSAGE })).toBe(
      'the operation failed',
    );
    expect(filesystemFailureReason(undefined)).toBe('the operation failed');
  });
});

describe('errnoCodeOf', () => {
  it.each([...MAPPED_PHRASES.map(([code]) => code), ...UNMAPPED_CODES])(
    'reads the errno-shaped %s',
    (code) => {
      expect(errnoCodeOf(systemError(code))).toBe(code);
    },
  );

  it.each(MALFORMED_CODES)('rejects %s', (_shape, code) => {
    expect(errnoCodeOf(systemError(code))).toBeUndefined();
  });

  it('rejects a cause without a code and one that is not an Error', () => {
    expect(errnoCodeOf(new Error(RAW_OS_MESSAGE))).toBeUndefined();
    expect(errnoCodeOf({ code: 'EACCES' })).toBeUndefined();
    expect(errnoCodeOf('EACCES')).toBeUndefined();
  });
});
