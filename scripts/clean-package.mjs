import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import process from 'node:process';
import { fileURLToPath, URL } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const workspace = resolve(process.cwd());
const comparable = (path) => (process.platform === 'win32' ? path.toLowerCase() : path);
assert(
  ['engine', 'cli'].some(
    (name) => comparable(workspace) === comparable(resolve(root, 'packages', name)),
  ),
  'Package cleanup must run from the engine or CLI workspace',
);

// A composite incremental build can retain deleted-source outputs until both are removed.
const output = resolve(workspace, 'dist');
assert.equal(dirname(output), workspace, 'Refuse cleanup outside the package workspace');
rmSync(output, { recursive: true, force: true });
rmSync(join(workspace, '.tsbuildinfo'), { force: true });
