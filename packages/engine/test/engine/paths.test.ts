import { describe, expect, it } from 'vitest';

import { isFullyQualifiedWindowsPath } from '../../src/engine/paths.js';

describe('fully qualified Windows paths', () => {
  it.each([
    String.raw`C:\Windows`,
    'C:/Windows',
    String.raw`\\server\share`,
    '//server/share/path',
  ])('accepts %s', (value) => {
    expect(isFullyQualifiedWindowsPath(value)).toBe(true);
  });

  it.each([
    String.raw`\Windows`,
    '/Windows',
    '///Windows',
    String.raw`\\\Windows`,
    String.raw`\\server`,
    String.raw`C:Windows`,
    String.raw`\\?\C:\Windows`,
    String.raw`\\.\PhysicalDrive0`,
  ])('rejects %s', (value) => {
    expect(isFullyQualifiedWindowsPath(value)).toBe(false);
  });
});
