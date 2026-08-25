import { describe, expect, it } from 'vitest';

import { ResolutionError } from '../../src/errors.js';
import {
  isSoleReference,
  referencesOf,
  renderTemplate,
  scanTemplate,
} from '../../src/engine/interpolate.js';

/** The literal and reference texts of a template, for compact assertions. */
function partsOf(text: string): string[] {
  const scan = scanTemplate(text);
  if (!scan.ok) {
    throw new Error(`expected ${JSON.stringify(text)} to scan: ${scan.message}`);
  }
  return scan.parts.map((part) => (part.kind === 'literal' ? part.text : part.reference.text));
}

function failure(text: string): { message: string; offset: number } {
  const scan = scanTemplate(text);
  if (scan.ok) {
    throw new Error(`expected ${JSON.stringify(text)} to be rejected`);
  }
  return { message: scan.message, offset: scan.offset };
}

describe('scanning', () => {
  it('splits a template into literals and references', () => {
    expect(partsOf('--dir=${installDirectory}/bin')).toEqual([
      '--dir=',
      '${installDirectory}',
      '/bin',
    ]);
  });

  it('reads a text without references as one literal', () => {
    expect(partsOf('--version')).toEqual(['--version']);
    expect(partsOf('')).toEqual([]);
  });

  it('reads dotted references', () => {
    expect(referencesOf('${env.JAVA_HOME}/bin/java')[0]?.segments).toEqual(['env', 'JAVA_HOME']);
    expect(referencesOf('${product.name}')[0]?.segments).toEqual(['product', 'name']);
  });

  it('reports where each reference stands, so a caller can point at it', () => {
    const [first, second] = referencesOf('a ${b} c ${d}');

    expect(first).toMatchObject({ text: '${b}', offset: 2 });
    expect(second).toMatchObject({ text: '${d}', offset: 9 });
  });

  it('renders $${ as a literal ${ and leaves a lone $ alone', () => {
    expect(partsOf('$${home}')).toEqual(['${home}']);
    expect(partsOf('100$ and $x')).toEqual(['100$ and $x']);
    expect(referencesOf('$${home}')).toHaveLength(0);
  });

  it('rejects an unterminated reference instead of treating it as text', () => {
    expect(failure('a ${home')).toMatchObject({ offset: 2 });
    expect(failure('a ${home').message).toMatch(/unterminated/);
  });

  it('rejects a reference that names nothing or names something unwritable', () => {
    expect(failure('${}').message).toBe('${} names nothing');
    expect(failure('${a..b}').message).toMatch(/empty segment/);
    expect(failure('${1abc}').message).toMatch(/is not a name/);
    expect(failure('${a-b}').message).toMatch(/is not a name/);
  });
});

describe('rendering', () => {
  it('replaces every reference with what the resolver returns', () => {
    expect(renderTemplate('${a}-${b}', (reference) => reference.segments.join('.'))).toBe('a-b');
  });

  it('never scans a rendered value again, so a value cannot inject a reference', () => {
    // The classic injection: a user types "${home}" into a field. It must stay eight
    // characters of text, not become the home directory (invariant 3).
    const rendered = renderTemplate('--name=${title}', () => '${home}');

    expect(rendered).toBe('--name=${home}');
  });

  it('lets the resolver refuse a reference', () => {
    expect(() =>
      renderTemplate('${nope}', () => {
        throw new ResolutionError('RUNE-301', 'no such variable');
      }),
    ).toThrow(ResolutionError);
  });

  it('reports a malformed template as an interpolation error', () => {
    let thrown: unknown;
    try {
      renderTemplate('${oops', () => '');
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(ResolutionError);
    expect((thrown as ResolutionError).code).toBe('RUNE-302');
  });
});

describe('isSoleReference', () => {
  it('tells a template that is exactly one reference from one that is not', () => {
    expect(isSoleReference('${installDatabase}')).toBe(true);
    expect(isSoleReference(' ${installDatabase}')).toBe(false);
    expect(isSoleReference('${a}${b}')).toBe(false);
    expect(isSoleReference('plain')).toBe(false);
  });
});
