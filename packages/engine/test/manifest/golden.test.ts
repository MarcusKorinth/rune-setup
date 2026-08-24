import { basename } from 'node:path';
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
      return error.issues.map((issue) => {
        // The file is part of what is pinned: once values files and locale overlays go
        // through the same loader, a message pointing at the wrong document is the failure
        // mode that matters, and it is invisible if only line and column are compared.
        const where = issue.location;
        return `${where && basename(where.file)}:${where?.line}:${where?.column} ${issue.message}`;
      });
    }
    throw error;
  }
  throw new Error(`${fixture} was expected to be rejected`);
}

describe('invalid-schema.yaml', () => {
  it('reports every shape problem, located, in source order', () => {
    expect(report('invalid-schema.yaml')).toEqual([
      'invalid-schema.yaml:2:1 license is reserved; accepted in a later schemaVersion',
      'invalid-schema.yaml:3:1 product.version is required',
      'invalid-schema.yaml:5:3 unknown key product.descripton — did you mean "description"?',
      'invalid-schema.yaml:9:5 unknown key inputs.installDirectory.titel — did you mean "title"?',
      'invalid-schema.yaml:10:5 inputs.installDirectory.group is reserved; accepted in a later schemaVersion',
      'invalid-schema.yaml:13:5 inputs.apiToken.default is not allowed: a secret must not be written into the manifest — supply it through --set, RUNE_INPUT_*, or a values file',
      'invalid-schema.yaml:17:9 inputs.environment.options[0].label is required',
      'invalid-schema.yaml:18:9 unknown key inputs.environment.options[0].labell — did you mean "label"?',
      'invalid-schema.yaml:20:3 execution.failFast must be a boolean',
      'invalid-schema.yaml:21:3 execution.elevation is reserved; accepted in a later schemaVersion',
      'invalid-schema.yaml:24:5 steps[0].dependsOn is reserved; accepted in a later schemaVersion',
      'invalid-schema.yaml:27:7 steps[0].run.args must be a list',
      'invalid-schema.yaml:28:7 steps[0].run.shell is not allowed: RUNE executes argv arrays only and never through a shell — pass the interpreter as `command` with its arguments in `args`',
      'invalid-schema.yaml:29:7 steps[0].run.timeoutSeconds must be greater than 0',
      'invalid-schema.yaml:30:5 steps[1].id "Legacy" must match ^[a-z][a-z0-9-]*$',
      'invalid-schema.yaml:32:7 steps[1].run.macos is reserved; accepted in a later schemaVersion',
      'invalid-schema.yaml:36:7 unknown key steps[2].run.comand — did you mean "command"?',
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
      'invalid-semantics.yaml:6:3 input id "home" collides with the built-in variable ${home}',
      'invalid-semantics.yaml:10:20 inputs.environment.options[1] repeats the option value "dev" — values are what scripts and --set receive, so they must be unique',
      'invalid-semantics.yaml:11:5 inputs.environment.default is "staging", which is not one of the option values ("dev")',
      'invalid-semantics.yaml:14:5 inputs.port.patternHint has no effect without inputs.port.pattern',
      'invalid-semantics.yaml:22:5 steps[2].id "install" is already used by steps[1] — step ids identify steps in logs and result files, so they must be unique',
      'invalid-semantics.yaml:23:5 steps[2].run has no platform block — declare windows, linux, or both (a step that should not run everywhere simply omits the platform it skips)',
    ]);
  });
});
