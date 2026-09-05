import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';

import {
  environmentName,
  Session,
  type EngineObserver,
  type ExecutionPlan,
  type InputStateChanged,
  type RunEvent,
  type RunResult,
  type SessionOptions,
  type StringTable,
} from '@rune/engine';
import { run, type CliIo } from '@rune/cli';
import { expect, it, vi } from 'vitest';

import type { Interaction } from '../packages/cli/src/prompt.js';

const CONTROLLER = 'parityIncludeDetails';
const DEPENDENT = 'parityDetailCode';
const SELECT = 'parityChannel';
const SECRET = 'parityToken';
const SECRET_VALUE = 'mode-parity-secret-value';
const LOCALE = 'de-DE';
const COMMAND_SCRIPT = "process.stdout.write(process.argv.slice(1).join('|') + '\\n')";
const MASK = '***';

type LegName = 'non-interactive' | 'interactive' | 'gui';

interface Capture extends CliIo {
  readonly out: string[];
  readonly err: string[];
}

interface ScriptedInteraction extends Interaction {
  transcript(): string;
  remainingAnswers(): number;
  dispose(): void;
}

interface SuccessfulSetValue {
  readonly inputId: string;
  readonly value: unknown;
  readonly returned: readonly InputStateChanged[];
}

interface LegCapture {
  readonly session: Session;
  readonly events: RunEvent[];
  readonly successfulSetValues: SuccessfulSetValue[];
}

function captureIo(): Capture {
  const out: string[] = [];
  const err: string[] = [];
  return { out, err, stdout: (line) => out.push(line), stderr: (line) => err.push(line) };
}

/** Feed each answer only after readline has emitted its question, just as a TTY user does. */
function scripted(answers: readonly string[], isTTY = true): ScriptedInteraction {
  const input = new PassThrough();
  const queue = [...answers];
  const written: string[] = [];
  return {
    input,
    isTTY,
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
    transcript: () => written.join(''),
    remainingAnswers: () => queue.length,
    dispose: () => input.destroy(),
  };
}

function createFixture(): { readonly directory: string; readonly manifestPath: string } {
  const directory = mkdtempSync(join(tmpdir(), 'rune-mode-parity-'));
  const manifestPath = join(directory, 'installer.yaml');
  writeFileSync(
    manifestPath,
    JSON.stringify(
      {
        schemaVersion: 1,
        product: {
          name: 'ParityFixture',
          version: '1.0.0',
          description: 'A representative parity workflow',
        },
        inputs: {
          [CONTROLLER]: {
            type: 'boolean',
            title: 'Include details',
            default: false,
          },
          [DEPENDENT]: {
            type: 'text',
            title: 'Detail code',
            when: `\${${CONTROLLER}}`,
            pattern: 'D-[0-9]+',
            patternHint: 'Use the form D-123',
          },
          [SELECT]: {
            type: 'select',
            title: 'Release channel',
            options: [
              { value: 'fast', label: 'Fast lane' },
              { value: 'safe', label: 'Safe lane' },
            ],
          },
          [SECRET]: {
            type: 'secret',
            title: 'Access token',
          },
        },
        steps: [
          {
            id: 'emit-values',
            title: 'Emit selected values',
            run: {
              command: process.execPath,
              args: ['-e', COMMAND_SCRIPT, `\${${DEPENDENT}}`, `\${${SELECT}}`, `\${${SECRET}}`],
            },
          },
          {
            id: 'skip-disabled',
            title: 'Skip when details are enabled',
            when: `\${${CONTROLLER}} == false`,
            run: {
              command: process.execPath,
              args: ['-e', "process.stdout.write('this must not run\\n')"],
            },
          },
        ],
      },
      null,
      2,
    ),
    'utf8',
  );

  const locales = join(directory, 'locales');
  mkdirSync(locales);
  writeFileSync(
    join(locales, 'de.yaml'),
    JSON.stringify(
      {
        'product.description': 'Ein repraesentativer Paritaetsablauf',
        [`inputs.${CONTROLLER}.title`]: 'Details einschliessen',
        [`inputs.${DEPENDENT}.title`]: 'Detailcode',
        [`inputs.${DEPENDENT}.patternHint`]: 'Format D-123 verwenden',
        [`inputs.${SELECT}.title`]: 'Ausgabekanal',
        [`inputs.${SELECT}.options.fast.label`]: 'Schnelle Spur',
        [`inputs.${SECRET}.title`]: 'Zugriffsschluessel',
        'steps.emit-values.title': 'Lokalisierter Lauf',
        'steps.skip-disabled.title': 'Lokalisierter uebersprungener Schritt',
        'rune.summary.heading': 'Lokalisierte Zusammenfassung',
        'rune.summary.proceed': 'Ausfuehren',
        'rune.summary.proceedToken': 'weiter',
        'rune.summary.change': 'Wert aendern',
      },
      null,
      2,
    ),
    'utf8',
  );
  return { directory, manifestPath };
}

function installSessionCapture(): {
  readonly captures: ReadonlyMap<LegName, LegCapture>;
  inLeg<T>(leg: LegName, action: () => Promise<T>): Promise<T>;
  restore(): void;
} {
  const captures = new Map<LegName, LegCapture>();
  let activeLeg: LegName | undefined;
  const realOpen: typeof Session.open = Session.open.bind(Session);
  const openSpy = vi
    .spyOn(Session, 'open')
    .mockImplementation(
      async (manifestPath: string, options?: SessionOptions): Promise<Session> => {
        if (activeLeg === undefined) {
          throw new Error('Session.open was called outside a named parity leg');
        }
        if (captures.has(activeLeg)) {
          throw new Error(`the ${activeLeg} leg opened more than one session`);
        }
        const session = await realOpen(manifestPath, options);
        const captured: LegCapture = { session, events: [], successfulSetValues: [] };
        captures.set(activeLeg, captured);

        const realSetValue = session.setValue.bind(session);
        const setValue = (inputId: string, raw: unknown) => {
          const returned = realSetValue(inputId, raw);
          const accepted = session.allInputs().find((input) => input.id === inputId)?.value;
          captured.successfulSetValues.push({
            inputId,
            value: inputId === SECRET ? MASK : jsonValue(accepted),
            returned: returned.map((change) => ({ ...change })),
          });
          return returned;
        };

        const realExecute = session.execute.bind(session);
        const execute: Session['execute'] = (observer, cancel) => {
          const forwardingObserver: EngineObserver = (event) => {
            captured.events.push(event);
            observer?.(event);
          };
          return realExecute(forwardingObserver, cancel);
        };
        const facade = new Proxy(session, {
          get: (target, property) => {
            if (property === 'setValue') {
              return setValue;
            }
            if (property === 'execute') {
              return execute;
            }
            const value: unknown = Reflect.get(target, property, target);
            return typeof value === 'function' ? value.bind(target) : value;
          },
        });
        return facade;
      },
    );

  return {
    captures,
    inLeg: async <T>(leg: LegName, action: () => Promise<T>): Promise<T> => {
      if (activeLeg !== undefined) {
        throw new Error(`cannot start ${leg} while ${activeLeg} is active`);
      }
      activeLeg = leg;
      try {
        return await action();
      } finally {
        activeLeg = undefined;
      }
    },
    restore: () => {
      openSpy.mockRestore();
    },
  };
}

function legCapture(captures: ReadonlyMap<LegName, LegCapture>, leg: LegName): LegCapture {
  const captured = captures.get(leg);
  if (captured === undefined) {
    throw new Error(`the ${leg} leg did not open a session`);
  }
  return captured;
}

function runStartedPlan(captured: LegCapture): ExecutionPlan {
  const started = captured.events.find((event) => event.kind === 'runStarted');
  if (started?.kind !== 'runStarted') {
    throw new Error('the execution stream has no RunStarted event');
  }
  return started.plan;
}

function runFinishedResult(captured: LegCapture): RunResult {
  const finished = captured.events.at(-1);
  if (finished?.kind !== 'runFinished') {
    throw new Error('the execution stream does not end in RunFinished');
  }
  return finished.result;
}

function jsonValue(value: unknown): unknown {
  return JSON.parse(JSON.stringify(value)) as unknown;
}

function jsonText(value: unknown): string {
  return JSON.stringify(canonicalJson(value));
}

function canonicalJson(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(canonicalJson);
  }
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, member]) => [key, canonicalJson(member)]),
    );
  }
  return value;
}

/** Normalize exactly the documented cross-mode/run-time nondeterminism, and nothing else. */
function normalizedResult(result: RunResult): unknown {
  return jsonValue({
    ...result,
    id: '<run-id>',
    mode: '<mode>',
    startedAt: '<timestamp>',
    finishedAt: '<timestamp>',
    durationMs: 0,
    inputs: result.inputs.map((input) => ({ ...input, source: '<source>' })),
    steps: result.steps.map((step) => ({ ...step, durationMs: 0 })),
  });
}

function normalizedPlan(plan: ExecutionPlan): unknown {
  return jsonValue({
    ...plan,
    resolvedInputs: plan.resolvedInputs.map((input) => ({ ...input, source: '<source>' })),
  });
}

function normalizedEvent(event: RunEvent): unknown {
  switch (event.kind) {
    case 'runStarted':
      return { kind: event.kind, plan: normalizedPlan(event.plan) };
    case 'stepFinished':
      return jsonValue({ ...event, durationMs: 0 });
    case 'runFinished':
      return { kind: event.kind, result: normalizedResult(event.result) };
    default:
      // RunStarted keeps its complete plan; it is also compared separately below.
      return jsonValue(event);
  }
}

function stringSnapshot(strings: StringTable): Readonly<Record<string, string | undefined>> {
  return {
    locale: strings.locale,
    overlayLocale: strings.overlayLocale,
    productDescription: strings.productDescription(),
    controllerTitle: strings.inputTitle(CONTROLLER),
    dependentTitle: strings.inputTitle(DEPENDENT),
    patternHint: strings.patternHint(DEPENDENT),
    selectTitle: strings.inputTitle(SELECT),
    optionLabel: strings.optionLabel(SELECT, 'fast'),
    secretTitle: strings.inputTitle(SECRET),
    runnableTitle: strings.stepTitle('emit-values'),
    skippedTitle: strings.stepTitle('skip-disabled'),
    summaryHeading: strings.chrome('rune.summary.heading'),
  };
}

function parseMachineResult(io: Capture): RunResult {
  expect(io.out).toHaveLength(1);
  return JSON.parse(io.out.join('\n')) as RunResult;
}

function suppressInputEnvironment(ids: readonly string[]): () => void {
  const previous = new Map<string, string | undefined>();
  for (const id of ids) {
    const name = environmentName(id);
    previous.set(name, process.env[name]);
    delete process.env[name];
  }
  return () => {
    for (const [name, value] of previous) {
      if (value === undefined) {
        delete process.env[name];
      } else {
        process.env[name] = value;
      }
    }
  };
}

it('keeps the real non-interactive, interactive, and GUI-shaped sessions mode-identical', async () => {
  const fixture = createFixture();
  const restoreEnvironment = suppressInputEnvironment([CONTROLLER, DEPENDENT, SELECT, SECRET]);
  const sessionCapture = installSessionCapture();
  const nonInteractiveIo = captureIo();
  const interactiveIo = captureIo();
  const nonInteractiveInteraction = scripted([], false);
  const interactiveInteraction = scripted([
    'fast',
    SECRET_VALUE,
    '1',
    'true',
    'wrong-pattern',
    'D-42',
    'weiter',
  ]);

  try {
    const nonInteractiveCode = await sessionCapture.inLeg('non-interactive', () =>
      run(
        [
          'run',
          fixture.manifestPath,
          '--non-interactive',
          '--locale',
          LOCALE,
          '--set',
          `${CONTROLLER}=true`,
          '--set',
          `${DEPENDENT}=D-42`,
          '--set',
          `${SELECT}=fast`,
          '--set',
          `${SECRET}=${SECRET_VALUE}`,
          '--result',
          '-',
        ],
        nonInteractiveIo,
        nonInteractiveInteraction,
      ),
    );

    const interactiveArgv = ['run', fixture.manifestPath, '--locale', LOCALE, '--result', '-'];
    expect(interactiveArgv).not.toContain('--set');
    const interactiveCode = await sessionCapture.inLeg('interactive', () =>
      run(interactiveArgv, interactiveIo, interactiveInteraction),
    );

    const guiClient = await sessionCapture.inLeg('gui', async () => {
      const session = await Session.open(fixture.manifestPath, { locale: LOCALE, mode: 'gui' });
      const strings = stringSnapshot(session.getStrings());
      const initialPending = session.pendingInputs().map((input) => input.id);
      const initialInputs = session.allInputs();

      session.setValue(SELECT, 'fast');
      session.setValue(SECRET, SECRET_VALUE);
      session.setValue(CONTROLLER, true);
      expect(session.pendingInputs().map((input) => input.id)).toEqual([DEPENDENT]);
      expect(() => session.setValue(DEPENDENT, 'wrong-pattern')).toThrow(/wrong-pattern/);
      expect(session.allInputs().find((input) => input.id === DEPENDENT)?.value).toBeUndefined();
      session.setValue(DEPENDENT, 'D-42');
      expect(session.pendingInputs()).toEqual([]);

      const summaryPlan = session.plan();
      const forwardedEvents: RunEvent[] = [];
      const result = await session.execute((event) => forwardedEvents.push(event));
      return { strings, initialPending, initialInputs, summaryPlan, forwardedEvents, result };
    });

    expect([nonInteractiveCode, interactiveCode, guiClient.result.exitCode]).toEqual([0, 0, 0]);
    expect(nonInteractiveInteraction.remainingAnswers()).toBe(0);
    expect(interactiveInteraction.remainingAnswers()).toBe(0);

    const nonInteractive = legCapture(sessionCapture.captures, 'non-interactive');
    const interactive = legCapture(sessionCapture.captures, 'interactive');
    const gui = legCapture(sessionCapture.captures, 'gui');
    const captures = [nonInteractive, interactive, gui] as const;

    const nonInteractiveResult = parseMachineResult(nonInteractiveIo);
    const interactiveResult = parseMachineResult(interactiveIo);
    const results = [nonInteractiveResult, interactiveResult, guiClient.result] as const;
    expect(jsonText(nonInteractiveResult)).toBe(jsonText(runFinishedResult(nonInteractive)));
    expect(jsonText(interactiveResult)).toBe(jsonText(runFinishedResult(interactive)));
    expect(jsonText(guiClient.result)).toBe(jsonText(runFinishedResult(gui)));

    // These are the plans carried by the actual executions, not extra comparison sessions.
    const plans = captures.map(runStartedPlan);
    const basePlan = plans[0];
    if (basePlan === undefined) {
      throw new Error('the parity suite captured no execution plan');
    }
    expect(plans.slice(1).map((plan) => jsonText(normalizedPlan(plan)))).toEqual([
      jsonText(normalizedPlan(basePlan)),
      jsonText(normalizedPlan(basePlan)),
    ]);
    expect(jsonText(normalizedPlan(guiClient.summaryPlan))).toBe(
      jsonText(normalizedPlan(basePlan)),
    );

    const normalizedEventStreams = captures.map((captured) =>
      jsonText(captured.events.map(normalizedEvent)),
    );
    expect(normalizedEventStreams.slice(1)).toEqual([
      normalizedEventStreams[0],
      normalizedEventStreams[0],
    ]);
    expect(captures.map((captured) => captured.events.map((event) => event.kind))).toEqual([
      ['runStarted', 'stepStarted', 'stepOutput', 'stepFinished', 'stepFinished', 'runFinished'],
      ['runStarted', 'stepStarted', 'stepOutput', 'stepFinished', 'stepFinished', 'runFinished'],
      ['runStarted', 'stepStarted', 'stepOutput', 'stepFinished', 'stepFinished', 'runFinished'],
    ]);
    for (const captured of captures) {
      expect(captured.events[0]).toEqual({ kind: 'runStarted', plan: runStartedPlan(captured) });
      expect(captured.events.filter((event) => event.kind === 'stepOutput')).toEqual([
        { kind: 'stepOutput', stepId: 'emit-values', stream: 'stdout', line: 'D-42|fast|***' },
      ]);
      expect(captured.events.filter((event) => event.kind === 'stepStarted')).toEqual([
        expect.objectContaining({ kind: 'stepStarted', stepId: 'emit-values' }),
      ]);
      expect(
        captured.events.filter(
          (event) => event.kind === 'stepFinished' && event.stepId === 'skip-disabled',
        ),
      ).toEqual([
        expect.objectContaining({
          kind: 'stepFinished',
          stepId: 'skip-disabled',
          state: 'SKIPPED',
          exitCode: undefined,
        }),
      ]);
    }

    const normalizedResults = results.map((result) => jsonText(normalizedResult(result)));
    expect(normalizedResults.slice(1)).toEqual([normalizedResults[0], normalizedResults[0]]);
    expect(results.map((result) => result.mode)).toEqual(['non-interactive', 'interactive', 'gui']);
    expect(nonInteractiveResult.inputs.map((input) => input.source)).toEqual([
      'set',
      'set',
      'set',
      'set',
    ]);
    expect(interactiveResult.inputs.map((input) => input.source)).toEqual([
      'answer',
      'answer',
      'answer',
      'answer',
    ]);
    expect(guiClient.result.inputs.map((input) => input.source)).toEqual([
      'answer',
      'answer',
      'answer',
      'answer',
    ]);

    const successfulLayerFive = [
      { inputId: SELECT, value: 'fast', returned: [] },
      { inputId: SECRET, value: MASK, returned: [] },
      {
        inputId: CONTROLLER,
        value: true,
        returned: [{ inputId: DEPENDENT, enabled: true }],
      },
      { inputId: DEPENDENT, value: 'D-42', returned: [] },
    ];
    expect(nonInteractive.successfulSetValues).toEqual([]);
    expect(interactive.successfulSetValues).toEqual(successfulLayerFive);
    expect(gui.successfulSetValues).toEqual(successfulLayerFive);
    expect(interactive.successfulSetValues.flatMap((call) => call.returned)).toEqual([
      { inputId: DEPENDENT, enabled: true },
    ]);
    expect(interactive.successfulSetValues).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ value: 'wrong-pattern' })]),
    );

    // The interactive driver really prompted, edited its summary, re-prompted, and proceeded.
    const transcript = interactiveInteraction.transcript();
    expect(transcript).toContain('Schnelle Spur (fast)');
    expect(transcript.match(/Enter a value for Ausgabekanal: /g)).toHaveLength(1);
    expect(transcript.match(/Enter a value for Zugriffsschluessel: /g)).toHaveLength(1);
    expect(transcript.match(/Enter a value for Details einschliessen: /g)).toHaveLength(1);
    expect(transcript.match(/Enter a value for Detailcode: /g)).toHaveLength(2);
    expect(transcript).toContain('Format D-123 verwenden');
    expect(transcript.match(/Ausfuehren \(weiter\) \/ Wert aendern <n>/g)).toHaveLength(2);
    expect(interactiveIo.err.join('\n').match(/Lokalisierte Zusammenfassung/g)).toHaveLength(2);
    expect(guiClient.initialPending).toEqual([SELECT, SECRET]);

    const stringTables = [
      stringSnapshot(nonInteractive.session.getStrings()),
      stringSnapshot(interactive.session.getStrings()),
      guiClient.strings,
    ];
    expect(stringTables[1]).toEqual(stringTables[0]);
    expect(stringTables[2]).toEqual(stringTables[0]);
    expect(stringTables[0]).toEqual({
      locale: LOCALE,
      overlayLocale: 'de',
      productDescription: 'Ein repraesentativer Paritaetsablauf',
      controllerTitle: 'Details einschliessen',
      dependentTitle: 'Detailcode',
      patternHint: 'Format D-123 verwenden',
      selectTitle: 'Ausgabekanal',
      optionLabel: 'Schnelle Spur',
      secretTitle: 'Zugriffsschluessel',
      runnableTitle: 'Lokalisierter Lauf',
      skippedTitle: 'Lokalisierter uebersprungener Schritt',
      summaryHeading: 'Lokalisierte Zusammenfassung',
    });

    expect(plans[0]?.steps.map((step) => step.id)).toEqual(['emit-values', 'skip-disabled']);
    expect(plans[0]?.steps.map((step) => step.title)).toEqual([
      'Lokalisierter Lauf',
      'Lokalisierter uebersprungener Schritt',
    ]);
    expect(results.map((result) => result.steps.map((step) => step.title))).toEqual([
      ['Lokalisierter Lauf', 'Lokalisierter uebersprungener Schritt'],
      ['Lokalisierter Lauf', 'Lokalisierter uebersprungener Schritt'],
      ['Lokalisierter Lauf', 'Lokalisierter uebersprungener Schritt'],
    ]);
    expect(results.map((result) => result.steps.map((step) => step.id))).toEqual([
      ['emit-values', 'skip-disabled'],
      ['emit-values', 'skip-disabled'],
      ['emit-values', 'skip-disabled'],
    ]);
    expect(results.map((result) => result.inputs.map((input) => input.id))).toEqual([
      [CONTROLLER, DEPENDENT, SELECT, SECRET],
      [CONTROLLER, DEPENDENT, SELECT, SECRET],
      [CONTROLLER, DEPENDENT, SELECT, SECRET],
    ]);
    const selectState = guiClient.initialInputs.find((input) => input.id === SELECT);
    if (selectState?.spec.type !== 'select') {
      throw new Error('the fixture select input was not exposed as a select');
    }
    expect(selectState.spec.options).toEqual(['fast', 'safe']);

    const runnable = plans[0]?.steps[0];
    if (runnable?.state !== 'PENDING') {
      throw new Error('the representative runnable step was not pending in the plan');
    }
    expect(jsonValue(runnable.command.argv)).toEqual([
      process.execPath,
      '-e',
      COMMAND_SCRIPT,
      'D-42',
      'fast',
      MASK,
    ]);
    expect(results.map((result) => result.steps[0]?.command)).toEqual([
      [process.execPath, '-e', COMMAND_SCRIPT, 'D-42', 'fast', MASK],
      [process.execPath, '-e', COMMAND_SCRIPT, 'D-42', 'fast', MASK],
      [process.execPath, '-e', COMMAND_SCRIPT, 'D-42', 'fast', MASK],
    ]);
    expect(guiClient.forwardedEvents).toEqual(gui.events);

    const capturedSurfaces = jsonText({
      plans,
      events: captures.map((captured) => captured.events),
      results,
      successfulSetValues: captures.map((captured) => captured.successfulSetValues),
      transcripts: [nonInteractiveInteraction.transcript(), transcript],
      output: [
        ...nonInteractiveIo.out,
        ...nonInteractiveIo.err,
        ...interactiveIo.out,
        ...interactiveIo.err,
      ],
      guiForwardedEvents: guiClient.forwardedEvents,
    });
    expect(capturedSurfaces).not.toContain(SECRET_VALUE);
    expect(capturedSurfaces).toContain(MASK);
  } finally {
    sessionCapture.restore();
    restoreEnvironment();
    nonInteractiveInteraction.dispose();
    interactiveInteraction.dispose();
    rmSync(fixture.directory, { recursive: true, force: true });
  }
}, 15_000);
