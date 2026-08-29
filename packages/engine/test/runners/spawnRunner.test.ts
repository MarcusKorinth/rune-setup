import { copyFileSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';

import { describe, expect, it } from 'vitest';

import { CancelToken } from '../../src/engine/cancel.js';
import { createRuntimeContext, hostPlatform } from '../../src/engine/context.js';
import { resolveInputs } from '../../src/engine/inputs.js';
import { buildPlan } from '../../src/engine/plan.js';
import { createSecretString } from '../../src/engine/secrets.js';
import type { ResolvedCommand } from '../../src/engine/plan.js';
import { parseManifestText } from '../../src/manifest/index.js';
import {
  forwardLines,
  isUnsupportedBatchExecutable,
  MAX_OUTPUT_LINE_BYTES,
  mergeSpawnEnvironment,
  OVERSIZED_OUTPUT_LINE_PLACEHOLDER,
  SpawnRunner,
} from '../../src/runners/spawnRunner.js';

/** A real command on any platform: this very Node binary. */
function nodeCommand(script: string, overrides: Partial<ResolvedCommand> = {}): ResolvedCommand {
  return {
    argv: [process.execPath, '-e', script],
    cwd: process.cwd(),
    env: {},
    timeoutSeconds: null,
    successExitCodes: [0],
    ...overrides,
  };
}

function run(
  command: ResolvedCommand,
  options: { cancel?: CancelToken; onOutput?: (stream: string, line: string) => void } = {},
) {
  return new SpawnRunner().run({
    command,
    extraEnv: { RUNE_RUN_ID: 'run', RUNE_STEP_ID: 'step' },
    cancel: options.cancel ?? new CancelToken(),
    onOutput: options.onOutput ?? (() => undefined),
  });
}

class TrackedCancelToken extends CancelToken {
  activeListeners = 0;

  override onCancel(listener: () => void): () => void {
    this.activeListeners += 1;
    const unsubscribe = super.onCancel(listener);
    let disposed = false;
    return () => {
      if (disposed) {
        return;
      }
      disposed = true;
      this.activeListeners -= 1;
      unsubscribe();
    };
  }
}

function withDeadline<T>(promise: Promise<T>, milliseconds: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('test operation timed out')), milliseconds);
    promise.then(
      (value) => {
        clearTimeout(timeout);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timeout);
        reject(error instanceof Error ? error : new Error(String(error)));
      },
    );
  });
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
  } catch {
    return false;
  }
  if (process.platform !== 'linux') {
    return true;
  }
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
    const commandEnd = stat.lastIndexOf(')');
    return commandEnd !== -1 && stat.slice(commandEnd + 2, commandEnd + 3) !== 'Z';
  } catch {
    return false;
  }
}

function stopProcess(pid: number): void {
  try {
    process.kill(pid, 'SIGKILL');
  } catch {
    // The integration-test process has already gone.
  }
}

describe('SpawnRunner', () => {
  it.each([
    ['win32', 'setup.cmd', true],
    ['win32', 'SETUP.CMD', true],
    ['win32', 'setup.bat', true],
    ['win32', 'setup.BaT', true],
    ['win32', 'setup.cmd.exe', false],
    ['win32', 'setup.batch', false],
    ['linux', 'setup.cmd', false],
    ['linux', 'setup.bat', false],
  ] satisfies readonly (readonly [NodeJS.Platform, string, boolean])[])(
    'classifies %s executable %s as unsupported: %s',
    (platform, executable, expected) => {
      expect(isUnsupportedBatchExecutable(executable, platform)).toBe(expected);
    },
  );

  it.runIf(process.platform === 'win32')(
    'refuses a secret-wrapped batch executable without exposing it',
    async () => {
      const secret = createSecretString('needle-secret.CmD');
      const outcome = await run(nodeCommand('', { argv: [secret] }));
      const serialized = JSON.stringify(outcome);

      expect(outcome).toEqual({
        kind: 'failedToStart',
        reason: 'shellRequired',
      });
      expect(serialized).not.toContain('needle-secret');
      expect(serialized).not.toContain('.CmD');
    },
  );

  it('merges environment layers case-insensitively on Windows', () => {
    const environment = mergeSpawnEnvironment(
      {
        Path: 'parent-path',
        rune_run_id: 'parent-run',
        rune_step_id: 'parent-step',
        PARENT_ONLY: 'parent',
      },
      {
        PATH: 'command-path',
        Rune_Run_Id: 'command-run',
        COMMAND_ONLY: 'command',
      },
      { RUNE_RUN_ID: 'extra-run', RUNE_STEP_ID: 'extra-step' },
      'win32',
    );

    expect(environment).toEqual({
      PARENT_ONLY: 'parent',
      PATH: 'command-path',
      COMMAND_ONLY: 'command',
      RUNE_RUN_ID: 'extra-run',
      RUNE_STEP_ID: 'extra-step',
    });
  });

  it('keeps differently cased environment names separate on Linux', () => {
    const environment = mergeSpawnEnvironment(
      { Path: 'parent-path', rune_run_id: 'parent-run' },
      { PATH: 'command-path', Rune_Run_Id: 'command-run' },
      { PATH: 'extra-path', RUNE_RUN_ID: 'extra-run' },
      'linux',
    );

    expect(environment).toEqual({
      Path: 'parent-path',
      rune_run_id: 'parent-run',
      PATH: 'extra-path',
      Rune_Run_Id: 'command-run',
      RUNE_RUN_ID: 'extra-run',
    });
  });

  it('runs an argv command and reports its exit code', async () => {
    await expect(run(nodeCommand('process.exit(0)'))).resolves.toEqual({
      kind: 'exited',
      exitCode: 0,
    });
    await expect(run(nodeCommand('process.exit(7)'))).resolves.toEqual({
      kind: 'exited',
      exitCode: 7,
    });
  });

  it('delivers output as lines, tagged with the stream it came from', async () => {
    const lines: string[] = [];

    await run(nodeCommand('console.log("one\\ntwo"); console.error("oops")'), {
      onOutput: (stream, line) => lines.push(`${stream}:${line}`),
    });

    expect(lines).toContain('stdout:one');
    expect(lines).toContain('stdout:two');
    expect(lines).toContain('stderr:oops');
  });

  it('delivers a logical line at exactly the UTF-8 payload limit unchanged', async () => {
    const lines: string[] = [];

    await run(nodeCommand(`process.stdout.write("a".repeat(${MAX_OUTPUT_LINE_BYTES}) + "\\n")`), {
      onOutput: (_stream, line) => lines.push(line),
    });

    expect(lines).toHaveLength(1);
    expect(Buffer.byteLength(lines[0]!, 'utf8')).toBe(MAX_OUTPUT_LINE_BYTES);
    expect(lines[0]).not.toBe(OVERSIZED_OUTPUT_LINE_PLACEHOLDER);
  });

  it('preserves an exact-limit line when CRLF arrives in controlled stream chunks', async () => {
    const lines: string[] = [];
    const chunks = ['x'.repeat(MAX_OUTPUT_LINE_BYTES) + '\r', '\n'];
    const stream = new Readable({
      read() {
        this.push(chunks.shift() ?? null);
      },
    });
    const ended = new Promise<void>((resolve, reject) => {
      stream.once('end', resolve);
      stream.once('error', reject);
    });

    forwardLines(stream, (line) => lines.push(line));
    await ended;

    expect(lines).toHaveLength(1);
    expect(lines[0]).toBe('x'.repeat(MAX_OUTPUT_LINE_BYTES));
    expect(Buffer.byteLength(lines[0]!, 'utf8')).toBe(MAX_OUTPUT_LINE_BYTES);
    expect(lines[0]).not.toBe(OVERSIZED_OUTPUT_LINE_PLACEHOLDER);
  });

  it('replaces a newline-free line over the limit once and emits nothing raw at EOF', async () => {
    const lines: string[] = [];

    await run(nodeCommand(`process.stdout.write("a".repeat(${MAX_OUTPUT_LINE_BYTES + 1}))`), {
      onOutput: (_stream, line) => lines.push(line),
    });

    expect(lines).toEqual([OVERSIZED_OUTPUT_LINE_PLACEHOLDER]);
  });

  it('discards a multi-megabyte line through newline and recovers for the next line', async () => {
    const lines: string[] = [];

    await run(
      nodeCommand(
        'process.stdout.write("x".repeat(4 * 1024 * 1024));' +
          'process.stdout.write("\\nafter\\n");',
      ),
      { onOutput: (_stream, line) => lines.push(line) },
    );

    expect(lines).toEqual([OVERSIZED_OUTPUT_LINE_PLACEHOLDER, 'after']);
  });

  it('emits one placeholder for each oversized line without duplicating at EOF', async () => {
    const lines: string[] = [];
    const oversizedBytes = MAX_OUTPUT_LINE_BYTES + 1;

    await run(
      nodeCommand(
        `process.stdout.write("x".repeat(${oversizedBytes}) + "\\n" + ` +
          `"y".repeat(${oversizedBytes}))`,
      ),
      { onOutput: (_stream, line) => lines.push(line) },
    );

    expect(lines).toEqual([OVERSIZED_OUTPUT_LINE_PLACEHOLDER, OVERSIZED_OUTPUT_LINE_PLACEHOLDER]);
  });

  it('resets after an oversized CRLF line and strips CRLF from the following line', async () => {
    const lines: string[] = [];

    await run(
      nodeCommand(
        `process.stdout.write("x".repeat(${MAX_OUTPUT_LINE_BYTES + 1}) + "\\r\\nnext\\r\\n")`,
      ),
      { onOutput: (_stream, line) => lines.push(line) },
    );

    expect(lines).toEqual([OVERSIZED_OUTPUT_LINE_PLACEHOLDER, 'next']);
  });

  it('preserves empty, CRLF, and unterminated bounded-line semantics', async () => {
    const lines: string[] = [];

    await run(nodeCommand('process.stdout.write("\\nalpha\\r\\nomega")'), {
      onOutput: (_stream, line) => lines.push(line),
    });

    expect(lines).toEqual(['', 'alpha', 'omega']);
  });

  it('keeps stdout and stderr line-limit state independent', async () => {
    const output: Array<{ stream: string; line: string }> = [];
    const oversizedBytes = MAX_OUTPUT_LINE_BYTES + 1;

    await run(
      nodeCommand(
        `process.stdout.write("x".repeat(${oversizedBytes}));` +
          'process.stderr.write("stderr-ok\\n");' +
          'process.stdout.write("\\nstdout-ok\\n");' +
          `process.stderr.write("y".repeat(${oversizedBytes}));`,
      ),
      { onOutput: (stream, line) => output.push({ stream, line }) },
    );

    expect(output.filter(({ stream }) => stream === 'stdout').map(({ line }) => line)).toEqual([
      OVERSIZED_OUTPUT_LINE_PLACEHOLDER,
      'stdout-ok',
    ]);
    expect(output.filter(({ stream }) => stream === 'stderr').map(({ line }) => line)).toEqual([
      'stderr-ok',
      OVERSIZED_OUTPUT_LINE_PLACEHOLDER,
    ]);
  });

  it('measures the limit in UTF-8 bytes rather than JavaScript code units', async () => {
    const lines: string[] = [];
    const threeByteCharacters = Math.floor(MAX_OUTPUT_LINE_BYTES / 3);
    const remainingBytes = MAX_OUTPUT_LINE_BYTES % 3;
    const exactExpression =
      `"€".repeat(${threeByteCharacters}) + ` + `"a".repeat(${remainingBytes})`;

    await run(
      nodeCommand(
        `const exact = ${exactExpression};` +
          'process.stdout.write(exact + "\\n");' +
          'process.stdout.write(exact + "a\\n");',
      ),
      { onOutput: (_stream, line) => lines.push(line) },
    );

    expect(lines).toHaveLength(2);
    expect(Buffer.byteLength(lines[0]!, 'utf8')).toBe(MAX_OUTPUT_LINE_BYTES);
    expect(lines[1]).toBe(OVERSIZED_OUTPUT_LINE_PLACEHOLDER);
  });

  it('passes the environment overlay and the reserved variables to the child', async () => {
    const lines: string[] = [];

    await run(
      nodeCommand('console.log(process.env.GREETING, process.env.RUNE_STEP_ID)', {
        env: { GREETING: 'hello' },
      }),
      { onOutput: (_stream, line) => lines.push(line) },
    );

    expect(lines).toContain('hello step');
  });

  it('unwraps a secret-wrapped argument and env value only for the child', async () => {
    const lines: string[] = [];

    await run(
      {
        ...nodeCommand('console.log(process.argv[1], process.env.TOKEN)'),
        argv: [
          process.execPath,
          '-e',
          'console.log(process.argv[1], process.env.TOKEN)',
          createSecretString('wrapped-arg'),
        ],
        env: { TOKEN: createSecretString('wrapped-env') },
      },
      { onOutput: (_stream, line) => lines.push(line) },
    );

    expect(lines).toContain('wrapped-arg wrapped-env');
  });

  it('reveals a composed plan only at spawn and preserves anchored bytes', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'rune-secret-plan-'));
    const manifest = parseManifestText(
      [
        'schemaVersion: 1',
        'product:',
        '  name: Example',
        '  version: "1.0.0"',
        'inputs:',
        '  runtime:',
        '    type: secret',
        '  work:',
        '    type: secret',
        '  token:',
        '    type: secret',
        'steps:',
        '  - id: opaque',
        '    when: "${token} == \'opaque-${env.SHOULD_NOT_BE_RESCANNED}\'"',
        '    run:',
        '      command: "${runtime}"',
        '      args:',
        '        - -e',
        '        - "console.log(process.cwd(), process.argv[1], process.env.TOKEN)"',
        '        - "arg-${token}"',
        '      cwd: "${work}"',
        '      env:',
        '        TOKEN: "env-${token}"',
        '',
      ].join('\n'),
      join(directory, 'installer.yaml'),
    );
    const context = createRuntimeContext({
      manifestDir: directory,
      product: manifest.product,
      platform: hostPlatform(),
      environment: {},
    });
    const resolution = resolveInputs({
      manifest,
      context,
      environment: {},
      overrides: new Map([
        ['runtime', process.execPath],
        ['work', '.'],
        ['token', 'opaque-${env.SHOULD_NOT_BE_RESCANNED}'],
      ]),
    });
    const plan = buildPlan({
      manifest,
      resolution,
      context,
    });

    const step = plan.steps[0];
    if (step?.state !== 'PENDING') {
      throw new Error('expected a pending step');
    }
    const lines: string[] = [];
    await expect(
      run(step.command, { onOutput: (_stream, line) => lines.push(line) }),
    ).resolves.toEqual({ kind: 'exited', exitCode: 0 });

    expect(lines).toContain(
      `${directory} arg-opaque-\${env.SHOULD_NOT_BE_RESCANNED} env-opaque-\${env.SHOULD_NOT_BE_RESCANNED}`,
    );
  });

  it('runs in the working directory the plan chose', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'rune-cwd-'));
    const lines: string[] = [];

    await run(nodeCommand('console.log(process.cwd())', { cwd: directory }), {
      onOutput: (_stream, line) => lines.push(line),
    });

    expect(lines.join('\n')).toContain(directory.slice(-10));
  });

  it('reports a command that does not exist as failed to start, not as a crash', async () => {
    const outcome = await run(
      nodeCommand('', { argv: ['rune-definitely-not-installed-anywhere'] }),
    );

    expect(outcome).toEqual({ kind: 'failedToStart', reason: 'commandNotFound' });
  });

  it('settles an error/close startup race once and releases cancellation', async () => {
    const cancel = new TrackedCancelToken();
    const pending = run(nodeCommand('', { argv: ['rune-definitely-not-installed-anywhere'] }), {
      cancel,
    });

    await expect(withDeadline(pending, 5000)).resolves.toEqual({
      kind: 'failedToStart',
      reason: 'commandNotFound',
    });
    expect(cancel.activeListeners).toBe(0);
    cancel.cancel();
    expect(cancel.activeListeners).toBe(0);
  });

  it('reports a missing working directory as failed to start, not as a crash', async () => {
    const parent = mkdtempSync(join(tmpdir(), 'rune-missing-cwd-'));
    const outcome = await run(nodeCommand('', { cwd: join(parent, 'missing') }));

    expect(outcome).toEqual({
      kind: 'failedToStart',
      reason: 'invalidCwd',
    });
  });

  it('gives an invalid cwd precedence when the command is also missing', async () => {
    const parent = mkdtempSync(join(tmpdir(), 'rune-both-missing-'));
    const outcome = await run(
      nodeCommand('', {
        argv: ['rune-definitely-not-installed-anywhere'],
        cwd: join(parent, 'missing'),
      }),
    );

    expect(outcome).toEqual({ kind: 'failedToStart', reason: 'invalidCwd' });
  });

  it.each([
    ['executable', nodeCommand('', { argv: ['invalid\0executable'] })],
    ['argument', nodeCommand('', { argv: [process.execPath, 'invalid\0argument'] })],
    ['working directory', nodeCommand('', { cwd: 'invalid\0directory' })],
    ['environment value', nodeCommand('', { env: { INVALID: 'invalid\0value' } })],
    ['environment name', nodeCommand('', { env: { ['INVALID\0NAME']: 'value' } })],
  ])('reports an invalid NUL-containing %s without rejecting', async (_name, command) => {
    await expect(run(command)).resolves.toEqual({
      kind: 'failedToStart',
      reason: 'other',
    });
  });

  it('does not include a secret-wrapped invalid value in a startup failure', async () => {
    const secret = createSecretString('needle-before\0needle-after');
    const outcome = await run(nodeCommand('', { argv: [process.execPath, secret] }));
    const serialized = JSON.stringify(outcome);

    expect(outcome).toEqual({
      kind: 'failedToStart',
      reason: 'other',
    });
    expect(serialized).not.toContain('needle-before');
    expect(serialized).not.toContain('needle-after');
    expect(serialized).not.toContain('\\u0000');
  });

  it('does not expose a secret missing command through its classified outcome', async () => {
    const secret = createSecretString('rune-secret-command-not-installed');
    const outcome = await run(nodeCommand('', { argv: [secret] }));
    const serialized = JSON.stringify(outcome);

    expect(outcome).toEqual({ kind: 'failedToStart', reason: 'commandNotFound' });
    expect(serialized).not.toContain('rune-secret-command-not-installed');
  });

  it('kills a process that exceeds its timeout', async () => {
    const outcome = await run(nodeCommand('setInterval(() => {}, 1000)', { timeoutSeconds: 1 }));

    expect(outcome).toEqual({ kind: 'timedOut' });
  }, 15000);

  it('kills a process when the run is cancelled', async () => {
    const cancel = new CancelToken();
    const pending = run(nodeCommand('setInterval(() => {}, 1000)'), { cancel });
    setTimeout(() => cancel.cancel(), 200);

    await expect(pending).resolves.toEqual({ kind: 'cancelled' });
  }, 15000);

  it('unsubscribes from cancellation after normal settlement', async () => {
    const cancel = new TrackedCancelToken();

    await expect(run(nodeCommand('process.exit(0)'), { cancel })).resolves.toEqual({
      kind: 'exited',
      exitCode: 0,
    });

    expect(cancel.activeListeners).toBe(0);
    cancel.cancel();
    expect(cancel.activeListeners).toBe(0);
  });

  it.skipIf(process.platform === 'win32')(
    'keeps the first timeout cause while cancellation arrives during graceful termination',
    async () => {
      const cancel = new CancelToken();
      const signals: string[] = [];
      const pending = run(
        nodeCommand(
          [
            'let signals = 0;',
            'process.on("SIGTERM", () => {',
            '  console.log(`term:${++signals}`);',
            '  setTimeout(() => process.exit(0), 300);',
            '});',
            'setInterval(() => {}, 1000);',
          ].join('\n'),
          { timeoutSeconds: 0.05 },
        ),
        { cancel, onOutput: (_stream, line) => signals.push(line) },
      );
      const cancelTimer = setTimeout(() => cancel.cancel(), 100);

      try {
        await expect(pending).resolves.toEqual({ kind: 'timedOut' });
        expect(signals.filter((line) => line.startsWith('term:'))).toEqual(['term:1']);
      } finally {
        clearTimeout(cancelTimer);
        cancel.cancel();
      }
    },
    15000,
  );

  it.skipIf(process.platform === 'win32')(
    'keeps the first cancellation cause while timeout arrives during graceful termination',
    async () => {
      const cancel = new CancelToken();
      const signals: string[] = [];
      const pending = run(
        nodeCommand(
          [
            'let signals = 0;',
            'process.on("SIGTERM", () => {',
            '  console.log(`term:${++signals}`);',
            '  setTimeout(() => process.exit(0), 300);',
            '});',
            'setInterval(() => {}, 1000);',
          ].join('\n'),
          { timeoutSeconds: 0.1 },
        ),
        { cancel, onOutput: (_stream, line) => signals.push(line) },
      );
      const cancelTimer = setTimeout(() => cancel.cancel(), 50);

      try {
        await expect(pending).resolves.toEqual({ kind: 'cancelled' });
        expect(signals.filter((line) => line.startsWith('term:'))).toEqual(['term:1']);
      } finally {
        clearTimeout(cancelTimer);
        cancel.cancel();
      }
    },
    15000,
  );

  it('does not resolve termination until a real child process tree is gone', async () => {
    const cancel = new CancelToken();
    const directory = mkdtempSync(join(tmpdir(), 'rune-process-tree-'));
    const readyPath = join(directory, 'grandchild-ready');
    const grandchildScript = [
      'process.on("SIGTERM", () => {});',
      `require("node:fs").writeFileSync(${JSON.stringify(readyPath)}, "ready");`,
      'setInterval(() => {}, 1000);',
    ].join('\n');
    const parentScript = [
      'const { spawn } = require("node:child_process");',
      `const grandchild = spawn(${JSON.stringify(process.execPath)}, ["-e", ${JSON.stringify(grandchildScript)}], { stdio: "ignore" });`,
      `const readyPath = ${JSON.stringify(readyPath)};`,
      'const ready = setInterval(() => {',
      '  if (require("node:fs").existsSync(readyPath)) {',
      '    clearInterval(ready);',
      '    console.log(`${process.pid}:${grandchild.pid}`);',
      '  }',
      '}, 10);',
      'process.on("SIGTERM", () => process.exit(0));',
      'setInterval(() => {}, 1000);',
    ].join('\n');
    let parentPid: number | undefined;
    let grandchildPid: number | undefined;
    let resolveProcessIds = (_ids: readonly [number, number]): void => undefined;
    const processIds = new Promise<readonly [number, number]>((resolveIds) => {
      resolveProcessIds = resolveIds;
    });
    const pending = run(nodeCommand(parentScript), {
      cancel,
      onOutput: (_stream, line) => {
        const match = /^(\d+):(\d+)$/.exec(line);
        if (match?.[1] !== undefined && match[2] !== undefined) {
          resolveProcessIds([Number(match[1]), Number(match[2])]);
        }
      },
    });

    try {
      [parentPid, grandchildPid] = await withDeadline(processIds, 5000);
      expect(processIsAlive(parentPid)).toBe(true);
      expect(processIsAlive(grandchildPid)).toBe(true);

      cancel.cancel();

      await expect(withDeadline(pending, 15000)).resolves.toEqual({ kind: 'cancelled' });
      expect(processIsAlive(parentPid)).toBe(false);
      expect(processIsAlive(grandchildPid)).toBe(false);
    } finally {
      cancel.cancel();
      if (parentPid !== undefined) {
        stopProcess(parentPid);
      }
      if (grandchildPid !== undefined) {
        stopProcess(grandchildPid);
      }
    }
  }, 25000);

  it.runIf(process.platform === 'win32')(
    'falls back safely when taskkill cannot be started',
    async () => {
      const previousPath = process.env.PATH;
      const cancel = new CancelToken();
      try {
        process.env.PATH = '';
        const pending = run(nodeCommand('setInterval(() => {}, 1000)'), { cancel });
        setTimeout(() => cancel.cancel(), 100);

        await expect(withDeadline(pending, 5000)).resolves.toEqual({ kind: 'cancelled' });
      } finally {
        if (previousPath === undefined) {
          delete process.env.PATH;
        } else {
          process.env.PATH = previousPath;
        }
        cancel.cancel();
      }
    },
    10000,
  );

  it.runIf(process.platform === 'win32')(
    'falls back safely when taskkill exits unsuccessfully',
    async () => {
      const directory = mkdtempSync(join(tmpdir(), 'rune-fake-taskkill-'));
      copyFileSync(process.execPath, join(directory, 'taskkill.exe'));
      const previousPath = process.env.PATH;
      const cancel = new CancelToken();
      try {
        process.env.PATH = directory;
        const pending = run(nodeCommand('setInterval(() => {}, 1000)'), { cancel });
        setTimeout(() => cancel.cancel(), 100);

        await expect(withDeadline(pending, 5000)).resolves.toEqual({ kind: 'cancelled' });
      } finally {
        if (previousPath === undefined) {
          delete process.env.PATH;
        } else {
          process.env.PATH = previousPath;
        }
        cancel.cancel();
      }
    },
    10000,
  );
});
