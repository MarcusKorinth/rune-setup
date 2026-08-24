import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { ManifestError } from '../../src/errors.js';
import { parseManifest } from '../../src/manifest/index.js';

/**
 * Golden files (docs/architecture.md §14): invalid manifests must produce exactly these
 * messages, at exactly these positions. This is the suite that keeps error quality — the
 * part of a validator authors actually experience — from quietly regressing.
 */
function report(fixture: string): string[] {
  const path = fileURLToPath(new URL(`../fixtures/${fixture}`, import.meta.url));
  try {
    parseManifest(path, { manifestDir: '.' });
  } catch (error) {
    if (error instanceof ManifestError) {
      return error.issues.map(
        (issue) => `${issue.location?.line}:${issue.location?.column} ${issue.message}`,
      );
    }
    throw error;
  }
  throw new Error(`${fixture} was expected to be rejected`);
}

describe('invalid-schema.yaml', () => {
  it('reports every shape problem, located, in source order', () => {
    expect(report('invalid-schema.yaml')).toEqual([
      '2:1 product.version is required',
      '4:3 unknown key product.descripton — did you mean "description"?',
      '8:5 unknown key inputs.installDirectory.titel — did you mean "title"?',
      '11:5 inputs.apiToken.default is not allowed: a secret must not be written into the manifest — supply it through --set, RUNE_INPUT_*, or a values file',
      '14:5 inputs.environment.options must be a list',
      '16:3 execution.failFast must be a boolean',
      '17:3 execution.elevation is reserved; accepted in a later schemaVersion',
      '22:7 steps[0].run.args must be a list',
      '23:7 steps[0].run.shell is not allowed: RUNE executes argv arrays only and never through a shell — pass the interpreter as `command` with its arguments in `args`',
      '26:7 steps[1].run.macos is reserved; accepted in a later schemaVersion',
    ]);
  });

  it('reports shape problems as RUNE-103', () => {
    try {
      parseManifest(fileURLToPath(new URL('../fixtures/invalid-schema.yaml', import.meta.url)));
    } catch (error) {
      expect((error as ManifestError).code).toBe('RUNE-103');
    }
    expect.assertions(1);
  });
});

describe('invalid-semantics.yaml', () => {
  it('reports every semantic problem, located, in source order', () => {
    expect(report('invalid-semantics.yaml')).toEqual([
      '6:3 input id "home" collides with the built-in variable ${home}',
      '10:20 inputs.environment.options[1] repeats the option value "dev" — values are what scripts and --set receive, so they must be unique',
      '11:5 inputs.environment.default is "staging", which is not one of the option values ("dev")',
      '14:5 inputs.port.patternHint has no effect without inputs.port.pattern',
      '16:5 steps[0].id "Install" must match ^[a-z][a-z0-9-]*$',
      '22:5 steps[2].id "install" is already used by steps[1] — step ids identify steps in logs and result files, so they must be unique',
      '23:5 steps[2].run has no platform block — declare windows, linux, or both (a step that should not run everywhere simply omits the platform it skips)',
    ]);
  });
});
