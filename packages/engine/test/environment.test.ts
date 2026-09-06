import { describe, expect, it } from 'vitest';

import { environmentValue, snapshotEnvironment } from '../src/environment.js';

describe('environment lookup semantics', () => {
  it('matches variable names case-insensitively on Windows', () => {
    expect(environmentValue({ Path: 'C:\\tools' }, 'PATH', 'win32')).toBe('C:\\tools');
  });

  it('keeps variable names case-sensitive on Linux', () => {
    const environment = { Path: '/tools' };

    expect(environmentValue(environment, 'PATH', 'linux')).toBeUndefined();
    expect(environmentValue(environment, 'Path', 'linux')).toBe('/tools');
  });

  it('takes a frozen copy instead of retaining caller-owned state', () => {
    const source = { PATH: 'before' };
    const snapshot = snapshotEnvironment(source);

    source.PATH = 'after';

    expect(snapshot).toEqual({ PATH: 'before' });
    expect(Object.isFrozen(snapshot)).toBe(true);
  });
});
