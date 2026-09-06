import { join, resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  isFullyQualifiedWindowsPath,
  resolveManifestRelativePathFrom,
  resolveTargetPathFrom,
} from '../../src/engine/paths.js';

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

describe('manifest-relative paths', () => {
  it('anchors host drive-relative spelling as an ordinary path component', () => {
    const basePath = resolve('synthetic-root', 'manifest');

    expect(resolveManifestRelativePathFrom('C:run.log', basePath)).toBe(
      join(basePath, 'C:run.log'),
    );
  });

  it.each([
    ['windows', String.raw`tools\run.cmd`, join('tools', 'run.cmd')],
    ['linux', 'tools/run', join('tools', 'run')],
    ['windows', 'C:run.log', 'C:run.log'],
  ] as const)(
    'keeps %s target-relative paths anchored after separator translation',
    (platform, value, expected) => {
      const basePath = resolve('synthetic-root', 'manifest');

      expect(resolveTargetPathFrom(value, basePath, platform)).toBe(join(basePath, expected));
    },
  );
});
