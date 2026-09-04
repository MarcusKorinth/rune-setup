import { mkdirSync, mkdtempSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { run, type CliIo } from '../src/cli.js';

interface Capture extends CliIo {
  readonly out: string[];
  readonly err: string[];
}

function capture(): Capture {
  const out: string[] = [];
  const err: string[] = [];
  return { out, err, stdout: (line) => out.push(line), stderr: (line) => err.push(line) };
}

/** A manifest in its own directory plus an existing directory to point `--result` at. */
function fixture(lines: readonly string[]): {
  readonly manifestPath: string;
  readonly destination: string;
} {
  const directory = mkdtempSync(join(tmpdir(), 'rune-cli-delivery-masking-'));
  const manifestPath = join(directory, 'installer.yaml');
  writeFileSync(manifestPath, [...lines, ''].join('\n'), 'utf8');
  const destination = join(directory, 'out');
  mkdirSync(destination);
  return { manifestPath, destination };
}

const DELIVERY_FAILURE = /^could not finalize result file "([^"]+)": [a-z ]+ [(]E[A-Z]+[)]$/u;

describe('result-file delivery failures and secrets', () => {
  it('masks a RUNE-407 diagnostic whose destination equals a session secret', async () => {
    const { manifestPath, destination } = fixture([
      'schemaVersion: 1',
      'product:',
      '  name: Example',
      '  version: "1.0.0"',
      'inputs:',
      '  resultSecret:',
      '    type: secret',
      'steps: []',
    ]);
    const io = capture();

    const code = await run(
      [
        'run',
        manifestPath,
        '--non-interactive',
        '--set',
        `resultSecret=${destination}`,
        '--result',
        destination,
      ],
      io,
    );

    expect(code).toBe(1);
    const humanOutput = [...io.out, ...io.err].join('\n');
    expect(humanOutput).not.toContain(destination);
    expect(humanOutput).toContain('***');
    const diagnostic = io.err.at(-1) ?? '';
    expect(diagnostic).toMatch(DELIVERY_FAILURE);
    expect(DELIVERY_FAILURE.exec(diagnostic)?.[1]).toBe('***');
    expect(readdirSync(destination)).toEqual([]);
  });

  it('names nothing after a secret-bearing open failure without a StringTable', async () => {
    const { manifestPath, destination } = fixture([
      'schemaVersion: 1',
      'product:',
      '  name: Example',
      '  version: "1.0.0"',
      'inputs:',
      '  announcementSecret:',
      '    type: secret',
      '  channel:',
      '    type: select',
      '    options: [stable]',
      'steps: []',
    ]);
    const io = capture();

    const code = await run(
      [
        'run',
        manifestPath,
        '--non-interactive',
        '--result',
        destination,
        '--set',
        `announcementSecret=${destination}`,
        '--set',
        'channel=invalid',
      ],
      io,
    );

    expect(code).toBe(1);
    const humanOutput = [...io.out, ...io.err].join('\n');
    expect(humanOutput).not.toContain(destination);
    expect(humanOutput).not.toContain('result file "');
    expect(io.err.at(-1)).toBe('could not write the result file');
    expect(readdirSync(destination)).toEqual([]);
  });

  it('names the destination when the manifest never parsed and no secret can exist', async () => {
    const { manifestPath, destination } = fixture(['schemaVersion: 99', 'product:', '  name: X']);
    const io = capture();

    const code = await run(['run', manifestPath, '--non-interactive', '--result', destination], io);

    expect(code).toBe(1);
    expect(io.err.join('\n')).toContain('schemaVersion 99 is not supported');
    const diagnostic = io.err.at(-1) ?? '';
    expect(diagnostic).toMatch(DELIVERY_FAILURE);
    expect(DELIVERY_FAILURE.exec(diagnostic)?.[1]).toBe(destination);
    expect(readdirSync(destination)).toEqual([]);
  });
});
