import { mkdirSync, mkdtempSync, rmdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { bundledWorkflow } from '../src/main/bundledWorkflow.js';

let root: string;
let binding: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'rune bundled workflow '));
  binding = join(root, 'rune-workflow.json');
  mkdirSync(join(root, 'workflow'));
  writeFileSync(join(root, 'workflow', 'setup.yaml'), 'manifest');
});
afterEach(() => {
  if (!relative(tmpdir(), root).startsWith('rune bundled workflow ')) {
    throw new Error('invalid fixture directory');
  }
  rmSync(root, { recursive: true, force: true });
});

function bind(value: unknown): void {
  writeFileSync(binding, JSON.stringify(value));
}

describe('a workflow bound to a distributed shell', () => {
  it('keeps a generic shell unbound and resolves package paths independently of cwd', () => {
    expect(bundledWorkflow(root)).toBeUndefined();
    bind({ schemaVersion: 1, manifest: 'workflow/setup.yaml' });
    expect(bundledWorkflow(root)).toBe(join(root, 'workflow/setup.yaml'));
  });

  it.each([
    null,
    [],
    {},
    { schemaVersion: 2, manifest: 'workflow/setup.yaml' },
    { schemaVersion: 1, manifest: 1 },
    { schemaVersion: 1, manifest: 'workflow/setup.yaml', unexpected: true },
  ])('rejects unsupported binding %j', (value) => {
    bind(value);
    expect(() => bundledWorkflow(root)).toThrow('unsupported schema');
  });

  it.each([
    'workflow',
    '../outside.yaml',
    '/workflow/setup.yaml',
    'workflow/../setup.yaml',
    'workflow//setup.yaml',
    'workflow/./setup.yaml',
    'workflow/C:/setup.yaml',
    'workflow\\setup.yaml',
    'workflow/a\0b',
  ])('rejects a manifest path escaping or ambiguously naming package resources: %j', (manifest) => {
    bind({ schemaVersion: 1, manifest });
    expect(() => bundledWorkflow(root)).toThrow('beneath');
  });

  it('rejects unreadable structure, excessive size and malformed JSON', () => {
    mkdirSync(binding);
    expect(() => bundledWorkflow(root)).toThrow('regular JSON file');
    rmdirSync(binding);
    writeFileSync(binding, ' '.repeat(4097));
    expect(() => bundledWorkflow(root)).toThrow('small');
    writeFileSync(binding, '{broken');
    expect(() => bundledWorkflow(root)).toThrow('valid JSON');
  });

  it('rejects a missing manifest or a directory in its place', () => {
    bind({ schemaVersion: 1, manifest: 'workflow/missing.yaml' });
    expect(() => bundledWorkflow(root)).toThrow('missing');
    mkdirSync(join(root, 'workflow', 'missing.yaml'));
    expect(() => bundledWorkflow(root)).toThrow('missing');
  });

  it('does not follow a linked workflow directory', () => {
    const linked = join(root, 'linked');
    mkdirSync(linked);
    writeFileSync(join(linked, 'setup.yaml'), 'external');
    rmSync(join(root, 'workflow/setup.yaml'));
    rmdirSync(join(root, 'workflow'));
    symlinkSync(linked, join(root, 'workflow'), process.platform === 'win32' ? 'junction' : 'dir');
    bind({ schemaVersion: 1, manifest: 'workflow/setup.yaml' });
    expect(() => bundledWorkflow(root)).toThrow('filesystem link');
  });
});
