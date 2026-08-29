import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';

import { describe, expect, it } from 'vitest';

import { run } from '@rune/cli';
import type { CliIo } from '@rune/cli';
import { Session, type RunEvent, type RunResult } from '@rune/engine';

/**
 * The mode-parity contract suite (docs/architecture.md §14): one fixture through the
 * non-interactive driver, the scripted interactive CLI, and an in-process client of the
 * Session facade making exactly the calls the Electron main process makes — the GUI leg,
 * no Electron needed. The three results must be identical modulo what necessarily differs
 * between legs: run ids, timestamps, durations, the mode field, and per-input provenance.
 */

const ANSWERS: Record<string, string | boolean> = {
  installDatabase: true,
  databasePort: '5432',
  environment: 'production',
  token: 'super-secret-value',
};

function fixture(): string {
  const dir = mkdtempSync(join(tmpdir(), 'rune-parity-'));
  writeFileSync(
    join(dir, 'installer.yaml'),
    [
      'schemaVersion: 1',
      'product:',
      '  name: Parity',
      '  version: "1.0.0"',
      'inputs:',
      '  installDatabase:',
      '    type: boolean',
      '    default: false',
      '  databasePort:',
      '    type: text',
      '    pattern: "[0-9]+"',
      '    when: "${installDatabase}"',
      '  environment:',
      '    type: select',
      '    options:',
      '      - value: production',
      '        label: Production',
      '      - value: staging',
      '        label: Staging',
      '  token:',
      '    type: secret',
      'steps:',
      '  - id: configure',
      '    title: Configure',
      '    run:',
      '      command: node',
      '      args: ["-e", "console.log(process.argv[1], process.argv[2])", "${databasePort}", "${environment}"]',
      '  - id: skipped-elsewhere',
      '    when: "${environment} == \'staging\'"',
      '    run:',
      '      command: node',
      '      args: ["-e", "0"]',
      '',
    ].join('\n'),
    'utf8',
  );
  mkdirSync(join(dir, 'locales'));
  writeFileSync(join(dir, 'locales', 'de.yaml'), 'steps.configure.title: Konfigurieren\n', 'utf8');
  return join(dir, 'installer.yaml');
}

/**
 * What necessarily differs between legs is stripped — run ids, timestamps, durations, the
 * mode field, per-input provenance (§14) — and nothing else.
 */
function normalize(result: RunResult): unknown {
  return {
    ...result,
    id: '<id>',
    mode: '<mode>',
    startedAt: '<t>',
    finishedAt: '<t>',
    durationMs: 0,
    inputs: result.inputs.map((input) => ({ ...input, source: '<source>' })),
    steps: result.steps.map((step) => ({ ...step, durationMs: 0 })),
  };
}

/** An event sequence with only the necessarily-differing parts stripped. */
function normalizeEvents(events: readonly RunEvent[]): unknown[] {
  return events.map((event) => {
    if (event.kind === 'stepFinished') {
      return { ...event, durationMs: 0 };
    }
    if (event.kind === 'runFinished') {
      return { kind: 'runFinished', result: normalize(event.result) };
    }
    if (event.kind === 'runStarted') {
      return { kind: 'runStarted' };
    }
    return event;
  });
}

function silentIo(): CliIo & { out: string[] } {
  const out: string[] = [];
  return { out, stdout: (line) => out.push(line), stderr: () => undefined };
}

async function nonInteractiveLeg(manifest: string): Promise<RunResult> {
  const io = silentIo();
  const argv = ['run', manifest, '--non-interactive', '--result', '-'];
  for (const [id, value] of Object.entries(ANSWERS)) {
    argv.push('--set', `${id}=${String(value)}`);
  }
  expect(await run(argv, io)).toBe(0);
  return JSON.parse(io.out.join('\n')) as RunResult;
}

async function interactiveLeg(manifest: string): Promise<RunResult> {
  const io = silentIo();
  const resultPath = join(manifest, '..', 'result-interactive.json');
  const input = new PassThrough();
  // Only environment and token are pending (installDatabase has a default and
  // databasePort is disabled); the rest flows through the summary edit loop — change
  // value 1 (installDatabase), answer the databasePort it enables, proceed.
  const answers = [
    String(ANSWERS['environment']),
    String(ANSWERS['token']),
    '1',
    String(ANSWERS['installDatabase']),
    String(ANSWERS['databasePort']),
    'p',
  ];
  const interaction = {
    input,
    isTTY: true,
    write: (text: string): void => {
      if (text.endsWith(': ')) {
        setImmediate(() => {
          const next = answers.shift();
          if (next !== undefined) {
            input.write(`${next}\n`);
          }
        });
      }
    },
    forceExit: (): void => undefined,
  };
  expect(await run(['run', manifest, '--result', resultPath], io, interaction)).toBe(0);
  return JSON.parse(readFileSync(resultPath, 'utf8')) as RunResult;
}

/** Exactly the call sequence the Electron main process makes over the facade (§9.2). */
async function guiLeg(
  manifest: string,
): Promise<{ result: RunResult; events: RunEvent[]; changes: unknown[] }> {
  const session = await Session.open(manifest, { environment: {}, mode: 'gui' });
  session.allInputs();
  const changes: unknown[] = [];
  for (const [id, value] of Object.entries(ANSWERS)) {
    changes.push(...session.setValue(id, value));
  }
  session.describe();
  const events: RunEvent[] = [];
  const result = await session.execute((event) => events.push(event));
  return { result, events, changes };
}

describe('mode parity', () => {
  it('produces one result across non-interactive, interactive, and the GUI leg', async () => {
    const manifest = fixture();

    const nonInteractive = await nonInteractiveLeg(manifest);
    const interactive = await interactiveLeg(manifest);
    const gui = await guiLeg(manifest);

    expect(nonInteractive.mode).toBe('non-interactive');
    expect(interactive.mode).toBe('interactive');
    expect(gui.result.mode).toBe('gui');
    expect(normalize(interactive)).toEqual(normalize(nonInteractive));
    expect(normalize(gui.result)).toEqual(normalize(nonInteractive));
    expect(nonInteractive.steps.map((step) => step.state)).toEqual(['SUCCEEDED', 'SKIPPED']);
    expect(JSON.stringify(nonInteractive)).not.toContain('super-secret-value');

    // The InputStateChanged list where a value flips a when: (§9.1, §14).
    expect(gui.changes).toContainEqual({ inputId: 'databasePort', enabled: true });
  });

  it('plans and emits identically however the values arrived', async () => {
    // Two facade legs over ONE manifest: layers 4 (overrides) versus 5 (answers). The
    // plan JSON and the event sequence must be byte-identical — how a value arrived may
    // never change what runs (§14).
    const manifest = fixture();
    const overrides = Object.fromEntries(
      Object.entries(ANSWERS).map(([id, value]) => [id, String(value)]),
    );
    const bySet = await Session.open(manifest, { environment: {}, overrides, mode: 'gui' });
    const byAnswer = await Session.open(manifest, { environment: {}, mode: 'gui' });
    for (const [id, value] of Object.entries(ANSWERS)) {
      byAnswer.setValue(id, value);
    }

    expect(JSON.stringify(bySet.plan())).toBe(JSON.stringify(byAnswer.plan()));

    const eventsBySet: RunEvent[] = [];
    const eventsByAnswer: RunEvent[] = [];
    await bySet.execute((event) => eventsBySet.push(event));
    await byAnswer.execute((event) => eventsByAnswer.push(event));
    expect(normalizeEvents(eventsByAnswer)).toEqual(normalizeEvents(eventsBySet));
    expect(eventsBySet.map((event) => event.kind)).toContain('stepOutput');
  });

  it('resolves identical localized titles through every leg', async () => {
    const manifest = fixture();
    const session = await Session.open(manifest, { environment: {}, locale: 'de', mode: 'gui' });
    for (const [id, value] of Object.entries(ANSWERS)) {
      session.setValue(id, value);
    }
    const gui = session.describe();

    const io = silentIo();
    const argv = [
      'run',
      manifest,
      '--non-interactive',
      '--dry-run',
      '--locale',
      'de',
      '--result',
      '-',
    ];
    for (const [id, value] of Object.entries(ANSWERS)) {
      argv.push('--set', `${id}=${String(value)}`);
    }
    expect(await run(argv, io)).toBe(0);
    const cli = JSON.parse(io.out.join('\n')) as RunResult;

    expect(gui.steps[0]?.title).toBe('Konfigurieren');
    expect(cli.steps[0]?.title).toBe('Konfigurieren');
    // Ids and commands never localize (§6.3): byte-identical across locales and legs.
    expect(cli.steps.map((step) => step.id)).toEqual(gui.steps.map((step) => step.id));
    expect(cli.steps[0]?.command).toEqual(gui.steps[0]?.command);
  });
});
