import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import type { RunEvent } from '../../src/engine/events.js';
import { Session } from '../../src/engine/session.js';

/**
 * A secret stored with surrounding whitespace (a CI secret store, `set VAR=value ` on Windows,
 * a quoted YAML value) reaches the child byte-exact. When the child trims it before printing,
 * the trimmed spelling must still be masked at every sink (docs/architecture.md §10).
 */
const PADDED_SECRET = ' padded-secret-value ';

describe('Session with a whitespace-padded secret', () => {
  it('masks the trimmed spelling a child prints at the observer and in the log file', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'rune-padded-secret-'));
    const manifestPath = join(directory, 'installer.yaml');
    writeFileSync(
      manifestPath,
      [
        'schemaVersion: 1',
        'product:',
        '  name: Example',
        '  version: "1.0.0"',
        'inputs:',
        '  token:',
        '    type: secret',
        'execution:',
        '  logFile: run.log',
        'steps:',
        '  - id: echo',
        '    run:',
        '      command: node',
        `      args: ["-e", "console.log('T=' + process.env.T.trim()); console.log('L=' + process.env.T.length)"]`,
        '      env:',
        '        T: "${token}"',
        '',
      ].join('\n'),
      'utf8',
    );
    const session = await Session.open(manifestPath, {
      mode: 'non-interactive',
      environment: process.env,
      overrides: { token: PADDED_SECRET },
    });
    const output: string[] = [];
    const observer = (event: RunEvent): void => {
      if (event.kind === 'stepOutput') {
        output.push(`${event.stream}: ${event.line}`);
      }
    };

    const result = await session.execute(observer);

    expect(result.status).toBe('succeeded');
    // The length line proves the padded value reached the child byte-exact, so the child's
    // trim really removed something before it printed the value.
    expect(output).toEqual(['stdout: T=***', `stdout: L=${PADDED_SECRET.length}`]);
    const log = readFileSync(join(directory, 'run.log'), 'utf8');
    expect(log).toContain('[echo:stdout] T=***');
    expect(log).not.toContain('padded-secret-value');
    expect(session.warnings().filter((warning) => warning.includes('masked'))).toEqual([]);
  });
});
