import { describe, expect, it } from 'vitest';

import { parseOverrides } from '../src/args.js';

describe('parseOverrides', () => {
  it('preserves every input name as an own key without a prototype', () => {
    const overrides = parseOverrides([
      'greeting=first',
      '__proto__=boom',
      'constructor=build',
      'toString=render',
      'greeting=last',
    ]);

    expect(Object.getPrototypeOf(overrides)).toBeNull();
    expect(Object.hasOwn(overrides, '__proto__')).toBe(true);
    expect(Object.hasOwn(overrides, 'constructor')).toBe(true);
    expect(Object.hasOwn(overrides, 'toString')).toBe(true);
    expect(overrides['__proto__']).toBe('boom');
    expect(overrides['constructor']).toBe('build');
    expect(overrides['toString']).toBe('render');
    expect(overrides['greeting']).toBe('last');
  });
});
