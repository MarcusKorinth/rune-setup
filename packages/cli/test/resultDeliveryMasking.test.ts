import { mkdirSync, mkdtempSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';

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
/** The same shape for a failure that happens before the rename, whatever the action was. */
const ANY_DELIVERY_FAILURE = /^could not [a-z ]+ result file "([^"]+)": [a-z ]+ [(]E[A-Z]+[)]$/u;

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

  it('masks a destination secret that carries a control character', async () => {
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
    // A file where the destination expects a directory fails delivery on every host, so the
    // tab stays a property of the secret instead of a property of the platform's path rules.
    const blocker = join(destination, 'blocker.txt');
    writeFileSync(blocker, 'blocked', 'utf8');
    const secretDestination = join(blocker, 'se\tcret-value-1234.json');
    const io = capture();

    const code = await run(
      [
        'run',
        manifestPath,
        '--non-interactive',
        '--set',
        `resultSecret=${secretDestination}`,
        '--result',
        secretDestination,
      ],
      io,
    );

    expect(code).toBe(1);
    const humanOutput = [...io.out, ...io.err].join('\n');
    expect(humanOutput).not.toContain(secretDestination);
    expect(humanOutput).not.toContain(secretDestination.replaceAll('\t', String.raw`\t`));
    const diagnostic = io.err.at(-1) ?? '';
    expect(diagnostic).toMatch(ANY_DELIVERY_FAILURE);
    expect(ANY_DELIVERY_FAILURE.exec(diagnostic)?.[1]).toBe('***');
    expect(readdirSync(destination)).toEqual(['blocker.txt']);
  });

  // The CLI anchors the destination before the run, so the spelling it writes to and the
  // spelling the operator typed — the one the secret registry holds — differ whenever
  // `resolve` normalizes. The diagnostic must still name the operator's spelling.
  it('masks a destination secret whose spelling carries a redundant path segment', async () => {
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
    const blocker = join(destination, 'blocker.txt');
    writeFileSync(blocker, 'blocked', 'utf8');
    // A "." segment is normalized away on every host, so this case does not depend on the
    // platform's separator rules; a leading "./" would additionally depend on the cwd.
    const spelled = `${blocker}${sep}.${sep}secret-value-1234.json`;
    const io = capture();

    const code = await run(
      [
        'run',
        manifestPath,
        '--non-interactive',
        '--set',
        `resultSecret=${spelled}`,
        '--result',
        spelled,
      ],
      io,
    );

    expect(code).toBe(1);
    const humanOutput = [...io.out, ...io.err].join('\n');
    expect(humanOutput).not.toContain(spelled);
    expect(humanOutput).not.toContain(resolve(spelled));
    const diagnostic = io.err.at(-1) ?? '';
    expect(diagnostic).toMatch(ANY_DELIVERY_FAILURE);
    expect(ANY_DELIVERY_FAILURE.exec(diagnostic)?.[1]).toBe('***');
    expect(readdirSync(destination)).toEqual(['blocker.txt']);
  });

  it.runIf(process.platform === 'win32')(
    'masks a destination secret spelled with forward slashes',
    async () => {
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
      const blocker = join(destination, 'blocker.txt');
      writeFileSync(blocker, 'blocked', 'utf8');
      // An ordinary Windows spelling that `resolve` rewrites to backslashes.
      const spelled = join(blocker, 'secret-value-1234.json').replaceAll('\\', '/');
      const io = capture();

      const code = await run(
        [
          'run',
          manifestPath,
          '--non-interactive',
          '--set',
          `resultSecret=${spelled}`,
          '--result',
          spelled,
        ],
        io,
      );

      expect(code).toBe(1);
      const humanOutput = [...io.out, ...io.err].join('\n');
      expect(humanOutput).not.toContain(spelled);
      expect(humanOutput).not.toContain(resolve(spelled));
      const diagnostic = io.err.at(-1) ?? '';
      expect(diagnostic).toMatch(ANY_DELIVERY_FAILURE);
      expect(ANY_DELIVERY_FAILURE.exec(diagnostic)?.[1]).toBe('***');
      expect(readdirSync(destination)).toEqual(['blocker.txt']);
    },
  );

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
