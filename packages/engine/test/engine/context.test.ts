import { describe, expect, it } from 'vitest';

import {
  BUILT_IN_NAMES,
  BUILT_IN_VARIABLES,
  PRODUCT_FIELDS,
  resolveReference,
  typeOfInput,
} from '../../src/engine/context.js';
import { INPUT_TYPES } from '../../src/manifest/v1/schema.js';

const INPUTS = ['installDirectory', 'installDatabase'];

function resolve(reference: string) {
  return resolveReference(reference.split('.'), INPUTS);
}

function messageFor(reference: string): string {
  const resolved = resolve(reference);
  if (resolved.ok) {
    throw new Error(`expected \${${reference}} to be rejected`);
  }
  return resolved.message;
}

describe('resolving a reference', () => {
  it('finds a declared input', () => {
    expect(resolve('installDirectory')).toEqual({
      ok: true,
      reference: { kind: 'input', id: 'installDirectory' },
    });
  });

  it.each(BUILT_IN_VARIABLES)('finds the built-in ${%s}', (name) => {
    expect(resolve(name)).toEqual({ ok: true, reference: { kind: 'builtin', name } });
  });

  it.each(PRODUCT_FIELDS)('finds ${product.%s}', (field) => {
    expect(resolve(`product.${field}`)).toEqual({
      ok: true,
      reference: { kind: 'product', field },
    });
  });

  it('finds any environment variable, because there is no allowlist', () => {
    expect(resolve('env.JAVA_HOME')).toEqual({
      ok: true,
      reference: { kind: 'environment', name: 'JAVA_HOME' },
    });
  });

  it('suggests the input an unknown name resembles', () => {
    expect(messageFor('instalDirectory')).toBe(
      '${instalDirectory} is neither a declared input nor a built-in variable — did you mean ${installDirectory}?',
    );
  });

  it('says plainly when a name resembles nothing', () => {
    expect(messageFor('zzzzzzzz')).toBe(
      '${zzzzzzzz} is neither a declared input nor a built-in variable',
    );
  });

  it('names what a reserved namespace is being kept for', () => {
    expect(messageFor('steps.install.exitCode')).toBe(
      '${steps.install.exitCode} is reserved for step outputs and is not available in schemaVersion 1',
    );
    expect(messageFor('rune.runId')).toMatch(/reserved for engine variables/);
  });

  it('explains a namespace used without a name', () => {
    expect(messageFor('env')).toBe('${env} needs the name of a variable: ${env.PATH}');
    expect(messageFor('product')).toMatch(/is not a product field/);
    expect(messageFor('product.description')).toMatch(/is not a product field/);
  });

  it('explains a value used as if it had fields', () => {
    expect(messageFor('home.subdirectory')).toBe(
      '${home} is a value, not a namespace — ${home.subdirectory} points at nothing',
    );
    expect(messageFor('installDirectory.parent')).toBe(
      '${installDirectory} is an input value, not a namespace — ${installDirectory.parent} points at nothing',
    );
    expect(messageFor('env.PATH.first')).toMatch(/one segment too many/);
  });

  it('resolves nothing when no inputs are visible', () => {
    expect(resolveReference(['installDirectory'], []).ok).toBe(false);
  });
});

describe('the built-in name list', () => {
  it('names exactly the product fields that exist', () => {
    expect(PRODUCT_FIELDS).toEqual(['name', 'version']);
    expect(BUILT_IN_VARIABLES).toEqual(['home', 'temp', 'platform', 'manifestDir']);
  });

  it('does not answer for a member of Object.prototype', () => {
    // A plain object as the reserved-namespace table would report an input legitimately
    // called `toString` as reserved, quoting a function body at the author.
    for (const name of ['toString', 'constructor', 'valueOf', 'hasOwnProperty']) {
      expect(resolveReference([name], [name])).toEqual({
        ok: true,
        reference: { kind: 'input', id: name },
      });
    }
  });

  it('suggests a name that differs only in case, which is the likeliest typo', () => {
    expect(resolveReference(['installdirectory'], INPUTS)).toEqual({
      ok: false,
      message:
        '${installdirectory} is neither a declared input nor a built-in variable — did you mean ${installDirectory}?',
    });
  });

  it('covers every namespace an input id must not shadow', () => {
    expect(BUILT_IN_NAMES).toEqual([
      'home',
      'temp',
      'platform',
      'manifestDir',
      'product',
      'env',
      'steps',
      'rune',
    ]);
  });
});

describe('typing inputs', () => {
  it('types booleans as booleans and multiselects as lists, everything else as text', () => {
    expect(typeOfInput('boolean')).toBe('boolean');
    expect(typeOfInput('multiselect')).toBe('stringList');
    expect(typeOfInput('text')).toBe('string');
    expect(typeOfInput('select')).toBe('string');
    expect(typeOfInput('secret')).toBe('string');
  });

  it('gives every declared input type a condition type', () => {
    for (const type of INPUT_TYPES) {
      expect(typeOfInput(type)).toBeDefined();
    }
  });
});
