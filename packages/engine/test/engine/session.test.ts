import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { hostPlatform } from '../../src/engine/context.js';
import { Session } from '../../src/engine/session.js';
import type { RunEvent } from '../../src/engine/events.js';
import type { Runner } from '../../src/runners/base.js';

const okRunner: Runner = { run: async () => ({ kind: 'exited', exitCode: 0 }) };

function fixture(lines: readonly string[], extra: Record<string, string> = {}): string {
  const dir = mkdtempSync(join(tmpdir(), 'rune-session-'));
  writeFileSync(join(dir, 'installer.yaml'), [...lines, ''].join('\n'), 'utf8');
  for (const [name, content] of Object.entries(extra)) {
    const path = join(dir, name);
    mkdirSync(join(path, '..'), { recursive: true });
    writeFileSync(path, content, 'utf8');
  }
  return join(dir, 'installer.yaml');
}

const BASE = [
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
  'steps:',
  '  - id: install',
  '    run:',
  '      command: node',
];

describe('opening a session', () => {
  it('resolves layers 1-4 and reports what is still pending', async () => {
    const path = fixture(BASE);
    const session = await Session.open(path, { environment: {} });

    expect(session.manifest.product.name).toBe('Example');
    expect(session.pendingInputs()).toEqual([]);
    expect(session.allInputs().map((input) => input.id)).toEqual([
      'installDatabase',
      'databasePort',
    ]);
    expect(session.allInputs()[1]?.enabled).toBe(false);
  });

  it('takes --set overrides and values files as layers 4 and 2', async () => {
    const path = fixture(BASE, { 'values.yaml': 'installDatabase: "true"\n' });
    const session = await Session.open(path, {
      values: [join(path, '..', 'values.yaml')],
      environment: {},
    });

    expect(session.allInputs()[0]?.value).toBe(true);
    expect(session.allInputs()[0]?.source).toBe('values');
    expect(session.pendingInputs().map((input) => input.id)).toEqual(['databasePort']);
  });

  it('collects invalid lower-layer seeds for interactive and GUI correction', async () => {
    const lines = [
      'schemaVersion: 1',
      'product:',
      '  name: Example',
      '  version: "1.0.0"',
      'inputs:',
      '  port:',
      '    type: text',
      '    pattern: "[0-9]{2,5}"',
      'steps: []',
    ];
    const interactive = await Session.open(fixture(lines), {
      environment: {},
      mode: 'interactive',
      overrides: { port: 'eighty' },
    });
    const guiPath = fixture(lines, { 'values.yaml': 'port: eighty\n' });
    const gui = await Session.open(guiPath, {
      environment: {},
      mode: 'gui',
      values: [join(guiPath, '..', 'values.yaml')],
    });

    for (const session of [interactive, gui]) {
      expect(session.pendingInputs().map((input) => input.id)).toEqual(['port']);
      expect(session.allInputs()[0]).toMatchObject({
        enabled: true,
        value: undefined,
        invalid: {
          candidate: 'eighty',
          issue: { code: 'RUNE-202', message: expect.stringContaining('does not match') },
        },
      });
    }
    expect(interactive.allInputs()[0]?.source).toBe('set');
    expect(gui.allInputs()[0]?.source).toBe('values');
  });

  it('keeps invalid lower-layer seeds strict in non-interactive mode', async () => {
    const path = fixture([
      'schemaVersion: 1',
      'product:',
      '  name: Example',
      '  version: "1.0.0"',
      'inputs:',
      '  port:',
      '    type: text',
      '    pattern: "[0-9]{2,5}"',
      'steps: []',
    ]);

    await expect(
      Session.open(path, {
        environment: {},
        mode: 'non-interactive',
        overrides: { port: 'eighty' },
      }),
    ).rejects.toMatchObject({ code: 'RUNE-202' });
  });

  it('uses the locale-resolved hint for a non-interactive invalid seed', async () => {
    const path = fixture(
      [
        'schemaVersion: 1',
        'product:',
        '  name: Example',
        '  version: "1.0.0"',
        'inputs:',
        '  port:',
        '    type: text',
        '    pattern: "[0-9]{2,5}"',
        '    patternHint: use two to five digits',
        'steps: []',
      ],
      { 'locales/de.yaml': 'inputs.port.patternHint: Zwei bis fünf Ziffern verwenden\n' },
    );
    let thrown: unknown;

    try {
      await Session.open(path, {
        environment: {},
        locale: 'de',
        mode: 'non-interactive',
        overrides: { port: 'eighty' },
      });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toMatchObject({ code: 'RUNE-202' });
    expect((thrown as Error).message).toContain('Zwei bis fünf Ziffern verwenden');
    expect((thrown as Error).message).not.toContain('use two to five digits');
  });

  it('keeps a concrete pattern diagnostic when no hint was declared', async () => {
    const session = await Session.open(
      fixture([
        'schemaVersion: 1',
        'product:',
        '  name: Example',
        '  version: "1.0.0"',
        'inputs:',
        '  port:',
        '    type: text',
        '    pattern: "[0-9]{2,5}"',
        'steps: []',
      ]),
      { environment: {}, mode: 'gui', overrides: { port: 'eighty' } },
    );

    expect(session.allInputs()[0]?.invalid?.issue.message).toContain(
      '"eighty" does not match [0-9]{2,5}',
    );
  });

  it('projects typed non-secret candidates as immutable bridge-safe data', async () => {
    const path = fixture(
      [
        'schemaVersion: 1',
        'product:',
        '  name: Example',
        '  version: "1.0.0"',
        'inputs:',
        '  enabled:',
        '    type: boolean',
        '  channel:',
        '    type: select',
        '    options: [stable, preview]',
        '  tools:',
        '    type: multiselect',
        '    options: [git, docker]',
        'steps: []',
      ],
      {
        'values.yaml': ['enabled: sometimes', 'channel: nightly', 'tools: [git, podman]', ''].join(
          '\n',
        ),
      },
    );
    const session = await Session.open(path, {
      environment: {},
      mode: 'gui',
      values: [join(path, '..', 'values.yaml')],
    });

    const states = session.allInputs();
    expect(states.map((state) => state.invalid?.candidate)).toEqual([
      'sometimes',
      'nightly',
      ['git', 'podman'],
    ]);
    expect(states.every((state) => state.invalid?.issue.code === 'RUNE-202')).toBe(true);
    expect(Object.isFrozen(states)).toBe(true);
    for (const state of states) {
      expect(Object.isFrozen(state)).toBe(true);
      expect(Object.isFrozen(state.invalid)).toBe(true);
      expect(Object.isFrozen(state.invalid?.issue)).toBe(true);
      expect(() => structuredClone(state)).not.toThrow();
    }
    expect(Object.isFrozen(states[2]?.invalid?.candidate)).toBe(true);
    expect(() => JSON.stringify(states)).not.toThrow();
  });

  it('projects the rendered value of an invalid templated default', async () => {
    const session = await Session.open(
      fixture([
        'schemaVersion: 1',
        'product:',
        '  name: Example',
        '  version: "1.0.0"',
        'inputs:',
        '  port:',
        '    type: text',
        '    default: "${env.PORT}"',
        '    pattern: "[0-9]+"',
        'steps: []',
      ]),
      { environment: { PORT: 'eighty' }, mode: 'gui' },
    );

    expect(session.allInputs()[0]?.invalid?.candidate).toBe('eighty');
  });

  it('never projects an invalid secret candidate or repeats it in the issue', async () => {
    const secret = 'plaintext-secret';
    const path = fixture(
      [
        'schemaVersion: 1',
        'product:',
        '  name: Example',
        '  version: "1.0.0"',
        'inputs:',
        '  token:',
        '    type: secret',
        'steps: []',
      ],
      { 'values.yaml': `token: [${secret}]\n` },
    );
    const session = await Session.open(path, {
      environment: {},
      mode: 'gui',
      values: [join(path, '..', 'values.yaml')],
    });

    const state = session.allInputs()[0];
    expect(state?.invalid).toMatchObject({
      candidate: null,
      issue: { code: 'RUNE-202', message: expect.stringContaining('value is not text') },
    });
    expect(JSON.stringify(state)).not.toContain(secret);
    expect(JSON.stringify(state?.invalid?.issue)).not.toContain(secret);
    let thrown: unknown;
    try {
      session.plan();
    } catch (error) {
      thrown = error;
    }
    expect(JSON.stringify(thrown)).not.toContain(secret);
    expect((thrown as Error).message).not.toContain(secret);
  });

  it('keeps unknown overrides hard in interactive mode', async () => {
    await expect(
      Session.open(fixture(BASE), {
        environment: {},
        mode: 'interactive',
        overrides: { installDatabsae: 'true' },
      }),
    ).rejects.toMatchObject({ code: 'RUNE-203' });
  });
});

describe('answering inputs', () => {
  it('flips dependent inputs live and reports the change', async () => {
    const session = await Session.open(fixture(BASE), { environment: {} });

    const changes = session.setValue('installDatabase', true);

    expect(changes).toEqual([{ inputId: 'databasePort', enabled: true }]);
    expect(session.pendingInputs().map((input) => input.id)).toEqual(['databasePort']);
  });

  it('rejects a bad value without changing anything', async () => {
    const session = await Session.open(fixture(BASE), { environment: {} });

    expect(() => session.setValue('installDatabase', 'not-a-boolean')).toThrow(/installDatabase/);
    expect(session.allInputs()[0]?.value).toBe(false);
    expect(() => session.setValue('nope', 'x')).toThrow(/names no input/);
  });

  it('keeps an accepted answer through a later rejected edit', async () => {
    const session = await Session.open(fixture(BASE), { environment: {} });
    session.setValue('installDatabase', true);
    session.setValue('databasePort', '5432');

    expect(() => session.setValue('installDatabase', 'garbage')).toThrow(/installDatabase/);
    session.setValue('installDatabase', true);

    expect(session.allInputs().find((input) => input.id === 'databasePort')?.value).toBe('5432');
    expect(session.pendingInputs()).toEqual([]);
  });

  it('rejects undefined atomically without replacing seeded or answered state', async () => {
    const session = await Session.open(
      fixture([
        'schemaVersion: 1',
        'product:',
        '  name: Example',
        '  version: "1.0.0"',
        'inputs:',
        '  target:',
        '    type: text',
        '    default: seeded',
        'steps:',
        '  - id: install',
        '    run:',
        '      command: node',
        '      args: ["${target}"]',
      ]),
      { environment: {} },
    );
    const rejectUndefined = (): void => {
      let thrown: unknown;
      try {
        session.setValue('target', undefined);
      } catch (error) {
        thrown = error;
      }
      expect(thrown).toMatchObject({ code: 'RUNE-202' });
      expect((thrown as Error).message).toMatch(
        /target \(from the answer\).*undefined is not text/s,
      );
    };

    const seededState = session.allInputs()[0];
    const seededPlan = session.plan();
    rejectUndefined();

    expect(session.allInputs()[0]).toBe(seededState);
    expect(session.allInputs()[0]).toMatchObject({ value: 'seeded', source: 'default' });
    expect(session.plan()).toBe(seededPlan);

    session.setValue('target', 'answered');
    const answeredState = session.allInputs()[0];
    const answeredPlan = session.plan();
    rejectUndefined();

    expect(session.allInputs()[0]).toBe(answeredState);
    expect(session.allInputs()[0]).toMatchObject({ value: 'answered', source: 'answer' });
    expect(session.plan()).toBe(answeredPlan);
  });

  it('keeps a valid controller edit when it exposes an invalid lower-layer seed', async () => {
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
    const session = await Session.open(path, {
      environment: {},
      mode: 'interactive',
      overrides: { databasePort: 'eighty' },
    });

    expect(session.setValue('installDatabase', true)).toEqual([
      { inputId: 'databasePort', enabled: true },
    ]);
    expect(session.allInputs()[0]?.value).toBe(true);
    expect(session.pendingInputs().map((input) => input.id)).toEqual(['databasePort']);
    expect(session.allInputs()[1]?.invalid?.candidate).toBe('eighty');
    expect(() => session.plan()).toThrow(
      /databasePort \(from --set databasePort=…\).*does not match/s,
    );

    session.setValue('databasePort', '5432');
    expect(session.pendingInputs()).toEqual([]);
    expect(session.allInputs()[1]?.invalid).toBeUndefined();
  });

  it('hides an invalid seed while disabled and restores it when re-enabled', async () => {
    const path = fixture([
      'schemaVersion: 1',
      'product:',
      '  name: Example',
      '  version: "1.0.0"',
      'inputs:',
      '  installDatabase:',
      '    type: boolean',
      '    default: true',
      '  databasePort:',
      '    type: text',
      '    when: "${installDatabase}"',
      '    pattern: "[0-9]{2,5}"',
      'steps: []',
    ]);
    const session = await Session.open(path, {
      environment: {},
      mode: 'gui',
      overrides: { databasePort: 'eighty' },
    });

    expect(session.allInputs()[1]?.invalid?.candidate).toBe('eighty');
    session.setValue('installDatabase', false);
    expect(session.allInputs()[1]).toMatchObject({ enabled: false, invalid: undefined });
    session.setValue('installDatabase', true);
    expect(session.allInputs()[1]).toMatchObject({
      enabled: true,
      invalid: { candidate: 'eighty' },
    });
  });

  it('rejects a bad layer-5 pattern answer atomically and retains its diagnostic hint', async () => {
    const path = fixture([
      'schemaVersion: 1',
      'product:',
      '  name: Example',
      '  version: "1.0.0"',
      'inputs:',
      '  port:',
      '    type: text',
      '    pattern: "[0-9]{2,5}"',
      '    patternHint: use two to five digits',
      'steps: []',
    ]);
    const session = await Session.open(path, {
      environment: {},
      mode: 'interactive',
      overrides: { port: '5432' },
    });
    session.setValue('port', '1234');

    expect(() => session.setValue('port', 'eighty')).toThrow(
      /port \(from the answer\).*use two to five digits/,
    );
    expect(session.allInputs()[0]).toMatchObject({ value: '1234', source: 'answer' });
    expect(session.getStrings().patternHint('port')).toBe('use two to five digits');
  });

  it('uses the effective hint in lower-layer GUI state and layer-5 rejection', async () => {
    const path = fixture(
      [
        'schemaVersion: 1',
        'product:',
        '  name: Example',
        '  version: "1.0.0"',
        'inputs:',
        '  port:',
        '    type: text',
        '    pattern: "[0-9]{2,5}"',
        '    patternHint: use two to five digits',
        'steps: []',
      ],
      { 'locales/de.yaml': 'inputs.port.patternHint: Zwei bis fünf Ziffern verwenden\n' },
    );
    const session = await Session.open(path, {
      environment: {},
      locale: 'de',
      mode: 'gui',
      overrides: { port: 'eighty' },
    });

    const lowerLayerIssue = session.allInputs()[0]?.invalid?.issue.message;
    expect(lowerLayerIssue).toContain('Zwei bis fünf Ziffern verwenden');
    expect(lowerLayerIssue).not.toContain('use two to five digits');
    let thrown: unknown;
    try {
      session.setValue('port', 'still-invalid');
    } catch (error) {
      thrown = error;
    }
    expect((thrown as Error).message).toContain('Zwei bis fünf Ziffern verwenden');
    expect((thrown as Error).message).not.toContain('use two to five digits');
  });
});

describe('planning and executing', () => {
  it('refuses to plan while required inputs are missing, listing each one', async () => {
    const session = await Session.open(fixture(BASE), { environment: {} });
    session.setValue('installDatabase', true);

    expect(() => session.plan()).toThrow(/databasePort.*--set databasePort=/s);
  });

  it('prompts for an invalid optional seed and preserves its original plan diagnostic', async () => {
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
    const session = await Session.open(path, {
      environment: {},
      mode: 'interactive',
      overrides: { port: 'eighty' },
    });

    expect(session.pendingInputs().map((input) => input.id)).toEqual(['port']);
    let thrown: unknown;
    try {
      session.plan();
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toMatchObject({ code: 'RUNE-202' });
    expect((thrown as Error).message).toMatch(/port \(from --set port=…\).*does not match/s);
    expect((thrown as Error).message).not.toContain('required and has no value');
  });

  it('executes through the facade and writes the log file', async () => {
    const path = fixture(BASE);
    const logFile = join(path, '..', 'logs', 'run.log');
    const session = await Session.open(path, {
      environment: {},
      logFile,
      runner: okRunner,
    });
    const events: RunEvent[] = [];

    const result = await session.execute((event) => events.push(event));

    expect(result.status).toBe('succeeded');
    expect(result.steps[0]?.state).toBe('SUCCEEDED');
    expect(events[0]?.kind).toBe('runStarted');
    expect(events.at(-1)?.kind).toBe('runFinished');
    const log = readFileSync(logFile, 'utf8');
    expect(log).toContain('[install] SUCCEEDED');
    expect(log).toContain('run finished: succeeded (exit 0)');
  });

  it('executes the exact plan object reviewed beforehand', async () => {
    const session = await Session.open(fixture(BASE), { environment: {}, runner: okRunner });
    const reviewedPlan = session.plan();
    let started: Extract<RunEvent, { kind: 'runStarted' }> | undefined;

    await session.execute((event) => {
      if (event.kind === 'runStarted') {
        started = event;
      }
    });

    expect(started?.plan).toBe(reviewedPlan);
  });

  it('keeps reviewed environment interpolation unchanged during execution', async () => {
    const environment = { TARGET: 'reviewed' };
    let executedArgv: readonly unknown[] | undefined;
    const runner: Runner = {
      run: async (request) => {
        executedArgv = request.command.argv;
        return { kind: 'exited', exitCode: 0 };
      },
    };
    const session = await Session.open(
      fixture([
        'schemaVersion: 1',
        'product:',
        '  name: Example',
        '  version: "1.0.0"',
        'inputs: {}',
        'steps:',
        '  - id: install',
        '    run:',
        '      command: node',
        '      args: ["${env.TARGET}"]',
      ]),
      { environment, runner },
    );

    session.plan();
    environment.TARGET = 'changed';
    await session.execute();

    expect(executedArgv).toEqual(['node', 'reviewed']);
  });

  it('invalidates a plan only after an accepted input edit', async () => {
    const session = await Session.open(
      fixture([
        'schemaVersion: 1',
        'product:',
        '  name: Example',
        '  version: "1.0.0"',
        'inputs:',
        '  port:',
        '    type: text',
        '    default: "5432"',
        '    pattern: "[0-9]+"',
        'steps:',
        '  - id: install',
        '    run:',
        '      command: node',
        '      args: ["${port}"]',
      ]),
      { environment: {} },
    );
    const initialPlan = session.plan();

    session.setValue('port', '1234');
    const editedPlan = session.plan();

    expect(editedPlan).not.toBe(initialPlan);
    expect(editedPlan.steps[0]).toMatchObject({
      state: 'PENDING',
      command: { argv: ['node', '1234'] },
    });

    session.setValue('port', '1234');
    const equalValuePlan = session.plan();
    expect(equalValuePlan).not.toBe(editedPlan);

    expect(() => session.setValue('port', 'invalid')).toThrow(/port/);
    expect(session.plan()).toBe(equalValuePlan);
  });

  it('describes a dry run without executing', async () => {
    const session = await Session.open(fixture(BASE), { environment: {} });

    const result = session.describe();

    expect(result.status).toBe('planned');
    expect(result.dryRun).toBe(true);
    expect(result.steps[0]?.state).toBe('PENDING');
  });
});

describe('strings and theme', () => {
  it('serves the overlay of the selected locale', async () => {
    const path = fixture(BASE, {
      'locales/de.yaml': 'steps.install.title: Installieren\nrune.button.next: Weiter\n',
    });
    const session = await Session.open(path, { locale: 'de-DE', environment: {} });

    const strings = session.getStrings();
    expect(strings.locale).toBe('de-DE');
    expect(strings.stepTitle('install')).toBe('Installieren');
    expect(strings.chrome('rune.button.next')).toBe('Weiter');
    expect(session.describe().steps[0]?.title).toBe('Installieren');
  });

  it('hands back the gui block with absolute paths, or nothing', async () => {
    const plain = await Session.open(fixture(BASE), { environment: {} });
    expect(plain.getThemeConfig()).toEqual({});

    const themed = await Session.open(
      fixture([...BASE, 'gui:', '  accentColor: "#3355ff"', '  logo: assets/logo.png'], {
        'assets/logo.png': 'not-a-real-png',
      }),
      { environment: {} },
    );
    const theme = themed.getThemeConfig();
    expect(theme.accentColor).toBe('#3355ff');
    expect(theme.logo).toMatch(/^([A-Za-z]:)?[\\/].*assets[\\/]logo\.png$/);
  });
});

describe('platform previews', () => {
  it('describes a foreign platform but refuses to execute it', async () => {
    const foreign = hostPlatform() === 'windows' ? 'linux' : 'windows';
    const session = await Session.open(fixture(BASE), { environment: {}, platform: foreign });

    expect(session.describe().crossPlatformPreview).toBe(true);
    await expect(session.execute()).rejects.toThrow(/preview plan/);
  });
});
