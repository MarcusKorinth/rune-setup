import { RuneError } from '@rune/engine';
import { describe, expect, it, vi } from 'vitest';

import { escapeTerminalText, runeErrorStderr } from '../src/io.js';

describe('terminal text escaping', () => {
  it('visibly escapes every terminal control and preserves ordinary text', () => {
    const controls = [
      ...Array.from({ length: 0x20 }, (_, codePoint) => String.fromCodePoint(codePoint)),
      ...Array.from({ length: 0x21 }, (_, index) => String.fromCodePoint(0x7f + index)),
      '\u2028',
      '\u2029',
    ].join('');
    const c0 = Array.from({ length: 0x20 }, (_, codePoint) => {
      switch (codePoint) {
        case 0x08:
          return '\\b';
        case 0x09:
          return '\\t';
        case 0x0a:
          return '\\n';
        case 0x0c:
          return '\\f';
        case 0x0d:
          return '\\r';
        default:
          return `\\u${codePoint.toString(16).padStart(4, '0')}`;
      }
    }).join('');
    const delAndC1 = Array.from(
      { length: 0x21 },
      (_, index) => `\\u${(0x7f + index).toString(16).padStart(4, '0')}`,
    ).join('');

    expect(escapeTerminalText(`Grüße 世界🙂${controls}`)).toBe(
      `Grüße 世界🙂${c0}${delAndC1}\\u2028\\u2029`,
    );
  });

  it('preserves visible escape sequences and is idempotent', () => {
    const text =
      String.raw`literal \n and \u001b, raw: ` +
      [0x1b, 0x85, 0x2028, 0x2029].map((codePoint) => String.fromCodePoint(codePoint)).join('');
    const escaped = escapeTerminalText(text);

    expect(escaped).toBe(String.raw`literal \n and \u001b, raw: \u001b\u0085\u2028\u2029`);
    expect(escapeTerminalText(escaped)).toBe(escaped);
  });

  it('formats and terminal-escapes a located single-issue RuneError', () => {
    const stderr = vi.fn();

    runeErrorStderr(
      { stdout: vi.fn(), stderr },
      new RuneError('RUNE-202', 'single\nissue\u001b\u0085', {
        issues: [
          {
            code: 'RUNE-202',
            message: 'single\nissue\u001b\u0085',
            location: { file: 'installer\u001b.yaml', line: 7, column: 9 },
          },
        ],
      }),
    );

    expect(stderr).toHaveBeenCalledWith(
      String.raw`installer\u001b.yaml:7:9: single\nissue\u001b\u0085`,
    );
  });
});
