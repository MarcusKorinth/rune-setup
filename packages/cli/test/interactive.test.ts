import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';

import { describe, expect, it } from 'vitest';

import { run } from '../src/cli.js';
import type { CliIo } from '../src/io.js';
import { Prompter, type Interaction } from '../src/prompt.js';

interface Capture extends CliIo {
  readonly out: string[];
  readonly err: string[];
}

function capture(): Capture {
  const out: string[] = [];
  const err: string[] = [];
  return { out, err, stdout: (line) => out.push(line), stderr: (line) => err.push(line) };
}

/**
 * A TTY-like interaction whose answers are scripted: the next answer is typed only after a
 * question prompt appears, the way a person answers — pre-buffered lines would race
 * readline's eager consumption.
 */
function scripted(answers: readonly string[]): Interaction & { transcript: () => string } {
  const input = new PassThrough();
  const queue = [...answers];
  const written: string[] = [];
  return {
    input,
    isTTY: true,
    write: (text) => {
      written.push(text);
      if (text.endsWith(': ')) {
        setImmediate(() => {
          const next = queue.shift();
          if (next !== undefined) {
            input.write(`${next}\n`);
          }
        });
      }
    },
    forceExit: () => undefined,
    transcript: () => written.join(''),
  };
}

function fixture(lines: readonly string[]): string {
  const dir = mkdtempSync(join(tmpdir(), 'rune-interactive-'));
  const path = join(dir, 'installer.yaml');
  writeFileSync(path, [...lines, ''].join('\n'), 'utf8');
  return path;
}

const MANIFEST = [
  'schemaVersion: 1',
  'product:',
  '  name: Example',
  '  version: "1.0.0"',
  'inputs:',
  '  greeting:',
  '    type: text',
  '  token:',
  '    type: secret',
  'steps:',
  '  - id: hello',
  '    run:',
  '      command: node',
  '      args: ["-e", "console.log(process.argv[1])", "${greeting}"]',
];

describe('the interactive run', () => {
  it('does not restore a secret answer through history navigation', async () => {
    const secret = 'history-sensitive-marker';
    const interaction = scripted([secret, '\u001B[A']);
    const prompter = new Prompter(interaction);

    try {
      expect(await prompter.ask('Secret: ', true)).toBe(secret);
      expect(await prompter.ask('Public: ')).toBe('');
    } finally {
      prompter.close();
    }

    expect(interaction.transcript()).not.toContain(secret);
  });

  it('prompts for pending inputs, shows the summary, and runs on proceed', async () => {
    const path = fixture(MANIFEST);
    const io = capture();
    const interaction = scripted(['hello', 'super-secret-value', 'p']);

    const code = await run(['run', path, '--result', '-'], io, interaction);

    expect(code).toBe(0);
    const result = JSON.parse(io.out.join('\n')) as {
      status: string;
      mode: string;
      inputs: readonly { id: string; value: unknown }[];
    };
    expect(result.status).toBe('succeeded');
    expect(result.mode).toBe('interactive');
    expect(result.inputs.find((input) => input.id === 'token')?.value).toBeNull();
    expect(interaction.transcript()).toContain('greeting');
    // The muted echo: the typed secret never appears on the prompt stream.
    expect(interaction.transcript()).not.toContain('super-secret-value');
    expect(io.out.join('\n')).not.toContain('super-secret-value');
  });

  it('re-prompts on a pattern mismatch, showing the hint', async () => {
    const path = fixture([
      'schemaVersion: 1',
      'product:',
      '  name: Example',
      '  version: "1.0.0"',
      'inputs:',
      '  name:',
      '    type: text',
      '    pattern: "[a-z]+"',
      '    patternHint: lower-case letters only',
      'steps:',
      '  - id: a',
      '    run:',
      '      command: node',
      '      args: ["-e", "0"]',
    ]);
    const io = capture();
    const interaction = scripted(['BAD1', 'good', 'p']);

    const code = await run(['run', path], io, interaction);

    expect(code).toBe(0);
    expect(interaction.transcript()).toContain('lower-case letters only');
  });

  it('displays option labels while accepting only select and multiselect values', async () => {
    const path = fixture([
      'schemaVersion: 1',
      'product:',
      '  name: Example',
      '  version: "1.0.0"',
      'inputs:',
      '  releaseChannel:',
      '    type: select',
      '    options:',
      '      - value: prod',
      '        label: Production release',
      '      - value: dev',
      '        label: Developer preview',
      '  components:',
      '    type: multiselect',
      '    options:',
      '      - value: git',
      '        label: Source control',
      '      - value: docker',
      '        label: Container runtime',
      'steps: []',
    ]);
    const io = capture();
    const interaction = scripted([
      'Production release',
      'prod',
      'Source control, Container runtime',
      'git,docker',
      'p',
    ]);

    const code = await run(['run', path, '--result', '-'], io, interaction);

    expect(code).toBe(0);
    const transcript = interaction.transcript();
    expect(transcript).toContain('Production release (prod)');
    expect(transcript).toContain('Developer preview (dev)');
    expect(transcript).toContain('enter the value of one option');
    expect(transcript).toContain('Source control (git)');
    expect(transcript).toContain('Container runtime (docker)');
    expect(transcript).toContain('enter option values, separated by commas');
    expect(transcript).toContain(
      '"Production release" is not one of the option values ("prod", "dev")',
    );
    expect(transcript).toContain(
      '"Source control", "Container runtime" are not option values ("git", "docker")',
    );
    expect(transcript.match(/Enter a value for releaseChannel: /g)).toHaveLength(2);
    expect(transcript.match(/Enter a value for components: /g)).toHaveLength(2);
    expect(transcript).toContain('Proceed (p) / Change a value <n> / Cancel (c): ');

    const result = JSON.parse(io.out.join('\n')) as {
      status: string;
      mode: string;
      inputs: readonly { id: string; value: unknown }[];
    };
    expect(result.status).toBe('succeeded');
    expect(result.mode).toBe('interactive');
    expect(result.inputs.find((input) => input.id === 'releaseChannel')?.value).toBe('prod');
    expect(result.inputs.find((input) => input.id === 'components')?.value).toEqual([
      'git',
      'docker',
    ]);
  });

  it.each(['set', 'values'] as const)(
    'prompts to correct an invalid %s seed instead of aborting',
    async (source) => {
      const path = fixture([
        'schemaVersion: 1',
        'product:',
        '  name: Example',
        '  version: "1.0.0"',
        'inputs:',
        '  name:',
        '    type: text',
        '    pattern: "[a-z]+"',
        'steps: []',
      ]);
      const sourceArgs =
        source === 'set' ? ['--set', 'name=BAD1'] : ['--values', join(path, '..', 'values.yaml')];
      if (source === 'values') {
        writeFileSync(join(path, '..', 'values.yaml'), 'name: BAD1\n', 'utf8');
      }
      const io = capture();
      const interaction = scripted(['good']);

      const code = await run(['run', path, '--dry-run', ...sourceArgs], io, interaction);

      expect(code).toBe(0);
      expect(interaction.transcript()).toContain('name');
    },
  );

  it('prompts to correct an explicitly invalid optional seed', async () => {
    const path = fixture([
      'schemaVersion: 1',
      'product:',
      '  name: Example',
      '  version: "1.0.0"',
      'inputs:',
      '  port:',
      '    type: text',
      '    required: false',
      '    pattern: "[0-9]{2,5}"',
      'steps: []',
    ]);
    const io = capture();
    const interaction = scripted(['5432']);

    const code = await run(['run', path, '--dry-run', '--set', 'port=eighty'], io, interaction);

    expect(code).toBe(0);
    expect(interaction.transcript()).toContain('port');
  });

  it('keeps invalid seeds strict without a TTY', async () => {
    const path = fixture([
      'schemaVersion: 1',
      'product:',
      '  name: Example',
      '  version: "1.0.0"',
      'inputs:',
      '  name:',
      '    type: text',
      '    pattern: "[a-z]+"',
      'steps: []',
    ]);
    const io = capture();
    const interaction = { ...scripted([]), isTTY: false };

    const code = await run(['run', path, '--set', 'name=BAD1'], io, interaction);

    expect(code).toBe(4);
    expect(io.err.join('\n')).toContain('does not match');
  });

  it('keeps unknown overrides strict in interactive mode', async () => {
    const path = fixture(MANIFEST);
    const io = capture();
    const interaction = scripted([]);

    const code = await run(['run', path, '--set', 'greetign=hello'], io, interaction);

    expect(code).toBe(4);
    expect(io.err.join('\n')).toContain('greetign');
    expect(interaction.transcript()).toBe('');
  });

  it('lets the summary edit a value, then prompts and re-renders', async () => {
    const path = fixture(MANIFEST);
    const io = capture();
    const interaction = scripted(['hello', 'super-secret-value', '1', 'bye', 'p']);

    const code = await run(['run', path, '--result', '-'], io, interaction);

    expect(code).toBe(0);
    const diagnostics = io.err.join('\n');
    const summaries = diagnostics.split('Review your configuration').slice(1);
    expect(summaries).toHaveLength(2);
    expect(summaries[0]?.match(/^ {2}1\) greeting = hello$/m)).not.toBeNull();
    expect(summaries[1]?.match(/^ {2}1\) greeting = bye$/m)).not.toBeNull();

    const result = JSON.parse(io.out.join('\n')) as {
      inputs: readonly { id: string; value: unknown }[];
    };
    expect(result.inputs.find((input) => input.id === 'greeting')?.value).toBe('bye');
  });

  it('rejects malformed summary indexes before accepting a valid index', async () => {
    const path = fixture(MANIFEST);
    const io = capture();
    const interaction = scripted([
      'hello',
      'super-secret-value',
      '1foo',
      'foo1',
      '1.5',
      '+1',
      '0',
      '-1',
      '1e0',
      '1 2',
      '1',
      'bye',
      'p',
    ]);

    const code = await run(['run', path], io, interaction);

    expect(code).toBe(0);
    const diagnostics = io.err.join('\n');
    expect(diagnostics).toContain('"1foo" is not');
    expect(diagnostics).toContain('"foo1" is not');
    expect(diagnostics).toContain('"1.5" is not');
    expect(diagnostics).toContain('"+1" is not');
    expect(diagnostics).toContain('"0" is not');
    expect(diagnostics).toContain('"-1" is not');
    expect(diagnostics).toContain('"1e0" is not');
    expect(diagnostics).toContain('"1 2" is not');
    expect(diagnostics).toContain('bye');
  });

  it('accepts a controller edit before correcting the dependent invalid seed', async () => {
    const path = fixture([
      'schemaVersion: 1',
      'product:',
      '  name: Example',
      '  version: "1.0.0"',
      'inputs:',
      '  installDatabase:',
      '    type: boolean',
      '    default: false',
      '  databasePort:',
      '    type: text',
      '    when: "${installDatabase}"',
      '    pattern: "[0-9]{2,5}"',
      'steps: []',
    ]);
    const io = capture();
    const interaction = scripted(['1', 'true', '5432', 'p']);

    const code = await run(
      ['run', path, '--set', 'databasePort=eighty', '--result', '-'],
      io,
      interaction,
    );

    expect(code).toBe(0);
    const diagnostics = io.err.join('\n');
    const summaries = diagnostics.split('Review your configuration').slice(1);
    expect(summaries).toHaveLength(2);
    expect(summaries[0]).not.toMatch(/^ {2}\d+\) databasePort = /m);
    expect(interaction.transcript().match(/Enter a value for installDatabase: /g)).toHaveLength(1);
    expect(interaction.transcript().match(/Enter a value for databasePort: /g)).toHaveLength(1);
    expect(summaries[1]).toMatch(/^ {2}\d+\) databasePort = 5432$/m);

    const result = JSON.parse(io.out.join('\n')) as {
      inputs: readonly { id: string; value: unknown; enabled: boolean }[];
    };
    expect(result.inputs).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: 'installDatabase', value: true, enabled: true }),
        expect.objectContaining({ id: 'databasePort', value: '5432', enabled: true }),
      ]),
    );
  });

  it('cancels from the summary with exit 6 and a cancelled result', async () => {
    const path = fixture([
      'schemaVersion: 1',
      'product:',
      '  name: Example',
      '  version: "1.0.0"',
      'inputs:',
      '  installDatabase:',
      '    type: boolean',
      '    default: false',
      'steps:',
      '  - id: conditional',
      '    when: "${installDatabase}"',
      '    run:',
      '      command: node',
      '      args: ["-e", "0"]',
      '  - id: pending',
      '    run:',
      '      command: node',
      '      args: ["-e", "0"]',
    ]);
    const resultPath = join(path, '..', 'result.json');
    const io = capture();
    const interaction = scripted(['c']);

    const code = await run(['run', path, '--result', resultPath], io, interaction);

    expect(code).toBe(6);
    const written = JSON.parse(readFileSync(resultPath, 'utf8')) as {
      status: string;
      mode: string;
      dryRun: boolean;
      stepsTotal: number;
      stepsExecuted: number;
      stepsSkipped: number;
      stepsNotRun: number;
      nothingExecuted: boolean;
      steps: readonly { state: string }[];
      inputs: readonly { id: string }[];
    };
    expect(written.status).toBe('cancelled');
    expect(written.mode).toBe('interactive');
    expect(written.dryRun).toBe(false);
    // On summary cancellation, plan-time SKIPPED steps remain terminal and pending steps become NOT_RUN (§10).
    expect(written.stepsTotal).toBe(2);
    expect(written.stepsExecuted).toBe(0);
    expect(written.stepsSkipped).toBe(1);
    expect(written.stepsNotRun).toBe(1);
    expect(written.nothingExecuted).toBe(true);
    expect(written.steps.map((step) => step.state)).toEqual(['SKIPPED', 'NOT_RUN']);
    expect(written.inputs.map((input) => input.id)).toEqual(['installDatabase']);
  });

  it('uses locale chrome for the interactive summary and summary cancellation', async () => {
    const path = fixture(MANIFEST);
    const resultPath = join(path, '..', 'result.json');
    const localesDirectory = join(path, '..', 'locales');
    mkdirSync(localesDirectory);
    writeFileSync(
      join(localesDirectory, 'de.yaml'),
      [
        'rune.summary.heading: PRUEFUNG',
        'rune.summary.proceed: WEITER',
        'rune.summary.proceedToken: weiter',
        'rune.summary.change: AENDERN',
        'rune.summary.cancel: ABBRECHEN',
        'rune.summary.cancelToken: abbrechen',
        'rune.plan.heading: PLAN::{product}::{version}::{path}::{platform}{preview}',
        'rune.plan.step: SCHRITT::{number}::{title}',
        'rune.plan.command: BEFEHL::{command}',
        'rune.run.cancelledAtSummary: ZUSAMMENFASSUNG_ABGEBROCHEN',
        'rune.result.written: GESCHRIEBEN::{path}',
        '',
      ].join('\n'),
      'utf8',
    );
    const io = capture();
    const interaction = scripted(['hello', 'super-secret-value', 'abbrechen']);

    expect(
      await run(['run', path, '--locale', 'de', '--result', resultPath], io, interaction),
    ).toBe(6);
    const diagnostics = io.err.join('\n');
    expect(diagnostics).toContain('PRUEFUNG');
    expect(diagnostics).toContain('PLAN::Example::1.0.0');
    expect(diagnostics).toContain('SCHRITT::1. ::hello');
    expect(diagnostics).toContain('BEFEHL::node -e');
    expect(diagnostics).toContain('ZUSAMMENFASSUNG_ABGEBROCHEN');
    expect(diagnostics).toContain(`GESCHRIEBEN::${resultPath}`);
    expect(interaction.transcript()).toContain(
      'WEITER (weiter) / AENDERN <n> / ABBRECHEN (abbrechen)',
    );
    expect(diagnostics).not.toContain('Plan for');
    expect(diagnostics).not.toContain('cancelled at the summary');
    expect(diagnostics).not.toContain('result written to');
  });

  it('uses locale-overridden summary tokens for prompts, validation, and actions', async () => {
    const path = fixture(MANIFEST);
    const localesDirectory = join(path, '..', 'locales');
    mkdirSync(localesDirectory);
    writeFileSync(
      join(localesDirectory, 'de.yaml'),
      [
        'rune.summary.proceed: Weiter',
        'rune.summary.proceedToken: weiter',
        'rune.summary.cancel: Abbrechen',
        'rune.summary.cancelToken: abbrechen',
        `rune.summary.invalidChoice: '"{choice}" ist nicht {proceed}, {cancel} oder die Nummer eines Werts'`,
        '',
      ].join('\n'),
      'utf8',
    );

    const proceedIo = capture();
    const proceedInteraction = scripted(['hello', 'super-secret-value', 'invalid', ' WeItEr ']);
    const proceedCode = await run(['run', path, '--locale', 'de'], proceedIo, proceedInteraction);

    expect(proceedCode).toBe(0);
    expect(proceedInteraction.transcript()).toContain('Weiter (weiter)');
    expect(proceedIo.err.join('\n')).toContain('"invalid" ist nicht weiter, abbrechen');

    const cancelIo = capture();
    const cancelInteraction = scripted(['hello', 'super-secret-value', 'ABBRECHEN']);
    const cancelCode = await run(['run', path, '--locale', 'de'], cancelIo, cancelInteraction);

    expect(cancelCode).toBe(6);
  });

  it('degrades to non-interactive without a TTY and records that mode', async () => {
    const path = fixture(MANIFEST);
    const io = capture();
    const interaction = scripted([]);
    const noTty = { ...interaction, isTTY: false };

    const code = await run(
      ['run', path, '--set', 'greeting=hi', '--set', 'token=super-secret-value', '--result', '-'],
      io,
      noTty,
    );

    expect(code).toBe(0);
    const result = JSON.parse(io.out.join('\n')) as Record<string, unknown>;
    expect(result['mode']).toBe('non-interactive');
  });
});
