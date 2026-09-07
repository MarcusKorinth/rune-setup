import { cp, mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { run } from '@rune/cli';
import { validateManifest, type RunResult } from '@rune/engine';
import { expect, it } from 'vitest';

const example = fileURLToPath(new URL('../examples/basic/', import.meta.url));

it.each([true, false])(
  'runs the committed basic example with notes enabled: %s',
  async (includeNotes) => {
    validateManifest(join(example, 'installer.yaml'));
    const directory = await mkdtemp(join(tmpdir(), 'rune-basic-example-'));
    try {
      // Copy only the authored inputs, so a developer's previous example output is irrelevant.
      await mkdir(join(directory, 'scripts'));
      await cp(join(example, 'installer.yaml'), join(directory, 'installer.yaml'));
      await cp(join(example, 'scripts/setup.mjs'), join(directory, 'scripts/setup.mjs'));
      const outputDirectory = join(directory, 'output with spaces');
      const resultPath = join(directory, 'result.json');
      const note = 'A note with "quotes", ${profile} and ; punctuation.';
      const stdout: string[] = [];
      const stderr: string[] = [];
      const code = await run(
        [
          'run',
          join(directory, 'installer.yaml'),
          '--non-interactive',
          '--set',
          `outputDirectory=${outputDirectory}`,
          '--set',
          'profile=production',
          '--set',
          `includeNotes=${includeNotes}`,
          '--set',
          `note=${note}`,
          '--result',
          resultPath,
        ],
        {
          stdout: (line) => stdout.push(line),
          stderr: (line) => stderr.push(line),
        },
      );
      expect(code, stderr.join('\n')).toBe(0);
      expect(stdout).toEqual([]);
      expect(
        JSON.parse(await readFile(join(outputDirectory, 'configuration.json'), 'utf8')),
      ).toEqual({ profile: 'production' });
      if (includeNotes) {
        expect(await readFile(join(outputDirectory, 'NOTES.txt'), 'utf8')).toBe(`${note}\n`);
      } else {
        await expect(readFile(join(outputDirectory, 'NOTES.txt'))).rejects.toMatchObject({
          code: 'ENOENT',
        });
      }
      const result = JSON.parse(await readFile(resultPath, 'utf8')) as RunResult;
      expect(result).toMatchObject({
        status: 'succeeded',
        exitCode: 0,
        stepsTotal: 2,
        stepsSucceeded: includeNotes ? 2 : 1,
        stepsSkipped: includeNotes ? 0 : 1,
        steps: [
          { id: 'write-configuration', state: 'SUCCEEDED' },
          { id: 'write-notes', state: includeNotes ? 'SUCCEEDED' : 'SKIPPED' },
        ],
      });
      expect(result.inputs.find((input) => input.id === 'note')).toMatchObject({
        enabled: includeNotes,
        value: includeNotes ? note : '',
      });
      const log = await readFile(join(directory, 'output/setup.log'), 'utf8');
      expect(log).toContain('Wrote configuration.json.');
      expect(log).not.toContain(note);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  },
);
