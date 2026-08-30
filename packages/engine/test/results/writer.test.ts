import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import type { RunResult } from '../../src/results/model.js';
import { serializeResult, writeResult } from '../../src/results/writer.js';

function result(id: string): RunResult {
  return {
    resultSchemaVersion: 1,
    id,
    status: 'succeeded',
    exitCode: 0,
    mode: 'non-interactive',
    dryRun: false,
    crossPlatformPreview: false,
    platform: 'linux',
    locale: 'en',
    startedAt: '2026-01-01T00:00:00.000Z',
    finishedAt: '2026-01-01T00:00:01.000Z',
    durationMs: 1000,
    runeVersion: '0.1.0',
    product: { name: 'Writer test', version: '1.0.0' },
    manifest: { path: '/project/installer.yaml', sha256: null, schemaVersion: 1 },
    stepsTotal: 0,
    stepsExecuted: 0,
    stepsSucceeded: 0,
    stepsFailed: 0,
    stepsCancelled: 0,
    stepsSkipped: 0,
    stepsNotRun: 0,
    nothingExecuted: true,
    inputs: [],
    steps: [],
  };
}

function temporaryFiles(directory: string): string[] {
  return readdirSync(directory).filter(
    (name) => name.startsWith('.rune-result-') && name.endsWith('.tmp'),
  );
}

describe('writeResult', () => {
  it('creates nested directories and writes the complete newline-terminated serialization', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'rune-result-writer-'));
    const destination = join(directory, 'nested', 'result.json');
    const expected = serializeResult(result('nested'));

    try {
      await writeResult(result('nested'), destination);

      expect(readFileSync(destination, 'utf8')).toBe(expected);
      expect(expected.endsWith('\n')).toBe(true);
      expect(temporaryFiles(join(directory, 'nested'))).toEqual([]);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('atomically replaces an existing destination', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'rune-result-writer-'));
    const destination = join(directory, 'result.json');
    const expected = serializeResult(result('replacement'));

    try {
      writeFileSync(destination, 'stale result', 'utf8');
      await writeResult(result('replacement'), destination);

      expect(readFileSync(destination, 'utf8')).toBe(expected);
      expect(temporaryFiles(directory)).toEqual([]);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it.sequential('anchors a relative destination to the cwd at call time', async () => {
    const firstDirectory = mkdtempSync(join(tmpdir(), 'rune-result-writer-cwd-a-'));
    const secondDirectory = mkdtempSync(join(tmpdir(), 'rune-result-writer-cwd-b-'));
    const originalCwd = process.cwd();
    const relativeDestination = 'result.json';
    const expected = serializeResult(result('original-cwd'));

    try {
      process.chdir(firstDirectory);
      const write = writeResult(result('original-cwd'), relativeDestination);
      process.chdir(secondDirectory);
      await write;

      expect(readFileSync(join(firstDirectory, relativeDestination), 'utf8')).toBe(expected);
      expect(existsSync(join(secondDirectory, relativeDestination))).toBe(false);
      expect(temporaryFiles(firstDirectory)).toEqual([]);
      expect(temporaryFiles(secondDirectory)).toEqual([]);
    } finally {
      process.chdir(originalCwd);
      rmSync(firstDirectory, { recursive: true, force: true });
      rmSync(secondDirectory, { recursive: true, force: true });
    }
  });

  it('serializes concurrent writes to one target and leaves one complete result', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'rune-result-writer-'));
    const destination = join(directory, 'result.json');
    const results = Array.from({ length: 8 }, (_, index) => result(`concurrent-${index}`));

    try {
      await Promise.all(results.map((entry) => writeResult(entry, destination)));

      expect(readFileSync(destination, 'utf8')).toSatisfy((content) =>
        results.some((entry) => content === serializeResult(entry)),
      );
      expect(temporaryFiles(directory)).toEqual([]);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('removes its temporary file when renaming fails', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'rune-result-writer-'));
    const destination = join(directory, 'destination');

    try {
      mkdirSync(destination);

      await expect(writeResult(result('rename-failure'), destination)).rejects.toBeInstanceOf(
        Error,
      );

      expect(temporaryFiles(directory)).toEqual([]);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
