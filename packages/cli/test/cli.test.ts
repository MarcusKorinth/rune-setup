import { describe, expect, it } from 'vitest';

import { run } from '../src/cli.js';

describe('rune CLI skeleton', () => {
  it('returns exit code 0 and writes its banner to stderr only', () => {
    const lines: string[] = [];
    const code = run([], { stderr: (line) => lines.push(line) });

    expect(code).toBe(0);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(/^rune \d+\.\d+\.\d+/);
  });
});
