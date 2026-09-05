import { mkdtempSync, writeFileSync } from 'node:fs';
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

function fixture(): string {
  const dir = mkdtempSync(join(tmpdir(), 'rune-cli-preview-'));
  const path = join(dir, 'installer.yaml');
  writeFileSync(
    path,
    [
      'schemaVersion: 1',
      'product:',
      '  name: Example',
      '  version: "1.0.0"',
      'inputs:',
      '  target:',
      '    type: text',
      '    default: "${home}/example"',
      'steps:',
      '  - id: hello',
      '    run:',
      '      command: node',
      '      args: ["-e", "console.log(process.argv[1])", "${target}", "${temp}"]',
      '',
    ].join('\n'),
    'utf8',
  );
  return path;
}

/** The platform this host is not, so the plan is a cross-platform preview (§6.1). */
const foreign = process.platform === 'win32' ? 'linux' : 'windows';

describe('rune run --dry-run --platform', () => {
  it('renders the preview heading and placeholder tokens for the foreign platform', async () => {
    const path = fixture();
    const io = capture();

    const code = await run(
      ['run', path, '--dry-run', '--non-interactive', '--platform', foreign],
      io,
    );

    expect(code).toBe(0);
    expect(io.out[0]).toContain('Execution plan v1 for Example 1.0.0');
    expect(io.out[0]).toContain(`platform ${foreign}, cross-platform preview)`);
    expect(io.out).toContain(
      `  target: value="<home@${foreign}>/example", secret=false, enabled=true, source=default, ignored=none`,
    );
    expect(io.out).toContain(
      `       argv: ["node","-e","console.log(process.argv[1])","<home@${foreign}>/example","<temp@${foreign}>"]`,
    );
    expect(io.err).toContain('Dry run: nothing was executed.');
  });

  it('delivers a planned preview result through --result -', async () => {
    const path = fixture();
    const io = capture();

    const code = await run(
      ['run', path, '--dry-run', '--non-interactive', '--platform', foreign, '--result', '-'],
      io,
    );

    expect(code).toBe(0);
    expect(io.out).toHaveLength(1);
    expect(io.out[0]).not.toContain('Execution plan');
    expect(JSON.parse(io.out[0]!)).toMatchObject({
      status: 'planned',
      exitCode: 0,
      dryRun: true,
      platform: foreign,
      crossPlatformPreview: true,
      nothingExecuted: true,
      inputs: [{ id: 'target', value: `<home@${foreign}>/example`, source: 'default' }],
      stepsNotRun: 1,
      steps: [{ id: 'hello', state: 'PENDING' }],
    });
  });
});
