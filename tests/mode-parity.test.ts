import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';

import { afterAll, describe, expect, it, vi } from 'vitest';

import { run } from '@rune/cli';
import type { CliIo } from '@rune/cli';
import {
  Session,
  writeResult,
  type InputStateChanged,
  type RunEvent,
  type RunResult,
} from '@rune/engine';

// Three real frontend runs spawn processes and can exceed the unit-test default under CI load.
const INTEGRATION_TIMEOUT_MS = 30_000;

function slowIt(name: string, run: () => Promise<void>): void {
  it(name, run, INTEGRATION_TIMEOUT_MS);
}

/**
 * The mode-parity contract suite (docs/architecture.md §14): one fixture through the
 * non-interactive driver, the scripted interactive CLI, and an in-process client of the
 * Session facade making exactly the calls the Electron main process makes — the GUI leg,
 * no Electron needed. The three results must be identical modulo what necessarily differs
 * between legs: run ids, timestamps, durations, the mode field, and per-input provenance.
 */

const ANSWERS = {
  installDatabase: true,
  databasePort: '5432',
  environment: 'production',
  token: 'super-secret-value',
} as const satisfies Record<string, string | boolean>;

// The interactive flow starts with the pending values, then enables databasePort from the
// summary edit loop. The GUI client follows that same facade-call sequence.
const ANSWER_ORDER = [
  'environment',
  'token',
  'installDatabase',
  'databasePort',
] as const satisfies readonly (keyof typeof ANSWERS)[];

const RUNE_ENVIRONMENT_KEYS = [
  'RUNE_LOCALE',
  'RUNE_INPUT_INSTALLDATABASE',
  'RUNE_INPUT_DATABASEPORT',
  'RUNE_INPUT_ENVIRONMENT',
  'RUNE_INPUT_TOKEN',
] as const;

type RuneEnvironmentKey = (typeof RUNE_ENVIRONMENT_KEYS)[number];
type RuneEnvironment = Readonly<Record<RuneEnvironmentKey, string | undefined>>;

const EMPTY_RUNE_ENVIRONMENT: RuneEnvironment = {
  RUNE_LOCALE: undefined,
  RUNE_INPUT_INSTALLDATABASE: undefined,
  RUNE_INPUT_DATABASEPORT: undefined,
  RUNE_INPUT_ENVIRONMENT: undefined,
  RUNE_INPUT_TOKEN: undefined,
};

const fixtureDirectories = new Set<string>();

async function withRuneEnvironment<T>(
  environment: RuneEnvironment,
  run: () => Promise<T>,
): Promise<T> {
  const original = new Map<RuneEnvironmentKey, string | undefined>(
    RUNE_ENVIRONMENT_KEYS.map((key) => [key, process.env[key]]),
  );

  try {
    for (const key of RUNE_ENVIRONMENT_KEYS) {
      const value = environment[key];
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
    return await run();
  } finally {
    for (const key of RUNE_ENVIRONMENT_KEYS) {
      const value = original.get(key);
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }
}

function fixture(): string {
  const dir = mkdtempSync(join(tmpdir(), 'rune-parity-'));
  fixtureDirectories.add(dir);
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

interface CapturedLeg<T> {
  readonly value: T;
  readonly events: readonly RunEvent[];
  readonly changes: readonly (readonly InputStateChanged[])[];
}

/**
 * Observes the actual sessions opened by a driver without replacing its engine path. The
 * execute wrapper sees the synchronous engine stream before forwarding it to the driver's
 * own observer, including the real RunStarted.plan. Every spy is restored before return.
 */
async function captureDriver<T>(drive: () => Promise<T>): Promise<CapturedLeg<T>> {
  const events: RunEvent[] = [];
  const changes: InputStateChanged[][] = [];
  const restoreSessionSpies: Array<() => void> = [];
  const originalOpen = Session.open;
  const openSpy = vi.spyOn(Session, 'open').mockImplementation(async (...args) => {
    const session = await originalOpen(...args);
    const originalExecute = session.execute.bind(session);
    const originalSetValue = session.setValue.bind(session);
    const executeSpy = vi.spyOn(session, 'execute').mockImplementation(async (observer, cancel) =>
      originalExecute((event) => {
        events.push(event);
        observer?.(event);
      }, cancel),
    );
    const setValueSpy = vi.spyOn(session, 'setValue').mockImplementation((id, raw) => {
      const changed = originalSetValue(id, raw);
      changes.push([...changed]);
      return changed;
    });
    restoreSessionSpies.push(
      () => executeSpy.mockRestore(),
      () => setValueSpy.mockRestore(),
    );
    return session;
  });

  try {
    return { value: await drive(), events, changes };
  } finally {
    for (const restore of restoreSessionSpies) {
      restore();
    }
    openSpy.mockRestore();
  }
}

function answerEntries(): readonly (readonly [string, string | boolean])[] {
  return ANSWER_ORDER.map((id) => [id, ANSWERS[id]]);
}

async function nonInteractiveLeg(manifest: string, locale?: string): Promise<RunResult> {
  const io = silentIo();
  const argv = ['run', manifest, '--non-interactive', '--result', '-'];
  if (locale !== undefined) {
    argv.push('--locale', locale);
  }
  for (const [id, value] of answerEntries()) {
    argv.push('--set', `${id}=${String(value)}`);
  }
  expect(await run(argv, io)).toBe(0);
  return JSON.parse(io.out.join('\n')) as RunResult;
}

async function interactiveLeg(manifest: string, locale?: string): Promise<RunResult> {
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
  const argv = ['run', manifest, '--result', resultPath];
  if (locale !== undefined) {
    argv.push('--locale', locale);
  }
  expect(await run(argv, io, interaction)).toBe(0);
  return JSON.parse(readFileSync(resultPath, 'utf8')) as RunResult;
}

/** Exactly the call sequence the Electron main process makes over the facade (§9.2). */
async function guiLeg(manifest: string, locale?: string): Promise<RunResult> {
  const session = await Session.open(manifest, {
    environment: {},
    mode: 'gui',
    ...(locale === undefined ? {} : { locale }),
  });

  // `rune.open` creates the Session in Electron main; boot then obtains the resolved strings,
  // input state, completeness state, and presentation-only theme through the bridge.
  const strings = session.getStrings();
  const configureTitle = strings.stepTitle('configure');
  expect(configureTitle).toBe(strings.entries.get('steps.configure.title'));
  expect(session.allInputs().map(({ id, enabled, source }) => ({ id, enabled, source }))).toEqual([
    { id: 'installDatabase', enabled: true, source: 'default' },
    { id: 'databasePort', enabled: false, source: undefined },
    { id: 'environment', enabled: true, source: undefined },
    { id: 'token', enabled: true, source: undefined },
  ]);
  expect(session.pendingInputs().map((input) => input.id)).toEqual(['environment', 'token']);
  expect(session.getThemeConfig()).toEqual({});

  // The renderer refreshes both projections after each `rune.setValue`; the refreshed pending
  // list and enabled state are what controls its Next button and disabled field treatment.
  const refreshes: Array<{ readonly databasePortEnabled: boolean; readonly pending: string[] }> =
    [];
  for (const [id, value] of answerEntries()) {
    session.setValue(id, value);
    const databasePort = session.allInputs().find((input) => input.id === 'databasePort');
    expect(databasePort).toBeDefined();
    refreshes.push({
      databasePortEnabled: databasePort?.enabled ?? false,
      pending: session.pendingInputs().map((input) => input.id),
    });
  }
  expect(refreshes).toEqual([
    { databasePortEnabled: false, pending: ['token'] },
    { databasePortEnabled: false, pending: [] },
    { databasePortEnabled: true, pending: ['databasePort'] },
    { databasePortEnabled: true, pending: [] },
  ]);

  // `rune.plan` maps to Session.describe() in Electron main; it is the masked summary the
  // renderer presents before starting execution.
  const described = session.describe();
  expect(described.status).toBe('planned');
  expect(described.steps.map((step) => step.state)).toEqual(['PENDING', 'SKIPPED']);
  expect(described.steps[0]?.title).toBe(configureTitle);

  const result = await session.execute();
  expect(session.warnings()).toEqual([]);

  // Electron main delivers GUI results through the engine's atomic writer. Read that file back
  // so the parity assertion uses the same persisted result representation as the other legs.
  const resultPath = join(manifest, '..', 'result-gui.json');
  writeResult(result, resultPath);
  const persisted = JSON.parse(readFileSync(resultPath, 'utf8')) as RunResult;
  expect(persisted).toEqual(result);
  return persisted;
}

interface ThreeWayRun {
  readonly nonInteractive: CapturedLeg<RunResult>;
  readonly interactive: CapturedLeg<RunResult>;
  readonly gui: CapturedLeg<RunResult>;
}

async function threeWayRun(manifest: string, locale?: string): Promise<ThreeWayRun> {
  return withRuneEnvironment(EMPTY_RUNE_ENVIRONMENT, async () => ({
    nonInteractive: await captureDriver(() => nonInteractiveLeg(manifest, locale)),
    interactive: await captureDriver(() => interactiveLeg(manifest, locale)),
    gui: await captureDriver(() => guiLeg(manifest, locale)),
  }));
}

function planFrom(events: readonly RunEvent[]) {
  const started = events.find((event) => event.kind === 'runStarted');
  expect(started).toBeDefined();
  if (started?.kind !== 'runStarted') {
    throw new Error('the engine did not emit runStarted');
  }
  return started.plan;
}

describe('mode parity', () => {
  afterAll(() => {
    for (const directory of fixtureDirectories) {
      rmSync(directory, { recursive: true, force: true });
    }
    fixtureDirectories.clear();
  });

  slowIt('produces one result across non-interactive, interactive, and the GUI leg', async () => {
    const manifest = fixture();

    // --set exercises layer 4 in the non-interactive driver; the other two legs provide
    // the same values through layer 5. The three actual drivers must agree on the result,
    // frozen plan, and complete engine event stream (§14).
    const { nonInteractive, interactive, gui } = await threeWayRun(manifest);

    expect(nonInteractive.value.mode).toBe('non-interactive');
    expect(interactive.value.mode).toBe('interactive');
    expect(gui.value.mode).toBe('gui');
    expect(normalize(interactive.value)).toEqual(normalize(nonInteractive.value));
    expect(normalize(gui.value)).toEqual(normalize(nonInteractive.value));
    expect(nonInteractive.value.steps.map((step) => step.state)).toEqual(['SUCCEEDED', 'SKIPPED']);
    expect(JSON.stringify(nonInteractive.value)).not.toContain('super-secret-value');

    expect(JSON.stringify(planFrom(interactive.events))).toBe(
      JSON.stringify(planFrom(nonInteractive.events)),
    );
    expect(JSON.stringify(planFrom(gui.events))).toBe(
      JSON.stringify(planFrom(nonInteractive.events)),
    );
    expect(normalizeEvents(interactive.events)).toEqual(normalizeEvents(nonInteractive.events));
    expect(normalizeEvents(gui.events)).toEqual(normalizeEvents(nonInteractive.events));
    expect(nonInteractive.events.map((event) => event.kind)).toContain('stepOutput');

    // InputStateChanged exists only for the layer-5 legs. The scripted summary edit and
    // facade client both enable databasePort through the real Session.setValue return.
    expect(nonInteractive.changes).toEqual([]);
    expect(interactive.changes).toEqual([[], [], [{ inputId: 'databasePort', enabled: true }], []]);
    expect(gui.changes).toEqual(interactive.changes);
  });

  slowIt('localizes display text without changing machine contracts in any leg', async () => {
    const manifest = fixture();
    // The explicit English locale is the built-in default text with no overlay, made stable
    // even on a host whose system locale is German.
    const defaults = await threeWayRun(manifest, 'en');
    const { nonInteractive, interactive, gui } = await threeWayRun(manifest, 'de');

    for (const leg of [nonInteractive, interactive, gui]) {
      expect(leg.value.steps[0]?.title).toBe('Konfigurieren');
    }
    for (const leg of [defaults.nonInteractive, defaults.interactive, defaults.gui]) {
      expect(leg.value.steps[0]?.title).toBe('Configure');
    }
    // Locale resolution changes display text only; IDs and command arrays stay exact across
    // all three real legs and between the default and `de` locales (§6.3, §14).
    expect(interactive.value.steps.map((step) => step.id)).toEqual(
      nonInteractive.value.steps.map((step) => step.id),
    );
    expect(gui.value.steps.map((step) => step.id)).toEqual(
      nonInteractive.value.steps.map((step) => step.id),
    );
    expect(interactive.value.steps.map((step) => step.command)).toEqual(
      nonInteractive.value.steps.map((step) => step.command),
    );
    expect(gui.value.steps.map((step) => step.command)).toEqual(
      nonInteractive.value.steps.map((step) => step.command),
    );
    for (const leg of [
      defaults.nonInteractive,
      defaults.interactive,
      defaults.gui,
      nonInteractive,
      interactive,
      gui,
    ]) {
      expect(leg.value.steps.map((step) => step.id)).toEqual(
        defaults.nonInteractive.value.steps.map((step) => step.id),
      );
      expect(leg.value.steps.map((step) => step.command)).toEqual(
        defaults.nonInteractive.value.steps.map((step) => step.command),
      );
    }
  });

  slowIt('isolates ambient RUNE values while preserving them after a three-way run', async () => {
    const manifest = fixture();
    const ambientEnvironment: RuneEnvironment = {
      ...EMPTY_RUNE_ENVIRONMENT,
      RUNE_LOCALE: 'de',
      RUNE_INPUT_TOKEN: 'ambient-secret',
    };

    await withRuneEnvironment(ambientEnvironment, async () => {
      const { nonInteractive, interactive, gui } = await threeWayRun(manifest);

      expect(normalize(interactive.value)).toEqual(normalize(nonInteractive.value));
      expect(normalize(gui.value)).toEqual(normalize(nonInteractive.value));
      expect(nonInteractive.changes).toEqual([]);
      expect(interactive.changes).toEqual([
        [],
        [],
        [{ inputId: 'databasePort', enabled: true }],
        [],
      ]);
      expect(gui.changes).toEqual(interactive.changes);
      expect(process.env.RUNE_LOCALE).toBe(ambientEnvironment.RUNE_LOCALE);
      expect(process.env.RUNE_INPUT_TOKEN).toBe(ambientEnvironment.RUNE_INPUT_TOKEN);
    });
  });
});
