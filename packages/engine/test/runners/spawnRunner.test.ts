import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { EventEmitter } from 'node:events';
import type { ChildProcess, spawn as spawnChildProcess } from 'node:child_process';
import { subscribe, unsubscribe } from 'node:diagnostics_channel';
import { tmpdir } from 'node:os';
import { join, win32 } from 'node:path';
import { Readable } from 'node:stream';
import { setTimeout as scheduleTimeout } from 'node:timers';

import { describe, expect, it, vi } from 'vitest';

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
  spawnRunnerTestSeam,
  waitForTaskkill,
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
  options: {
    cancel?: CancelToken;
    onOutput?: (stream: string, line: string) => unknown;
    parentEnv?: Readonly<Record<string, string | undefined>>;
    extraEnv?: Readonly<Record<string, string>>;
  } = {},
) {
  return new SpawnRunner().run({
    command,
    parentEnv: options.parentEnv ?? Object.freeze({ ...process.env }),
    extraEnv: options.extraEnv ?? { RUNE_RUN_ID: 'run', RUNE_STEP_ID: 'step' },
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

const TEST_TERMINATION_TIMINGS = {
  graceMs: 50,
  confirmationMs: 50,
  pollMs: 10,
} as const;

function errno(code?: string): Error {
  const error = new Error('injected process signal failure') as NodeJS.ErrnoException;
  if (code !== undefined) {
    error.code = code;
  }
  return error;
}

function processStat(pid: number, state: string, processGroupId: number): string {
  return `${pid} (synthetic process) ${state} 1 ${processGroupId} 0`;
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

function createRealProcessTreeFixture(): {
  readonly directory: string;
  readonly parentScript: string;
} {
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
  return { directory, parentScript };
}

/**
 * A snapshotted SystemRoot whose taskkill helper is this Node binary: it exits non-zero for the
 * runner's argv without touching any process, which is what taskkill reports for a PID that has
 * already gone. Children still need the real SystemRoot to start.
 */
function createFailingTaskkillFixture(): {
  readonly directory: string;
  readonly helper: string;
  readonly parentEnv: Readonly<Record<string, string | undefined>>;
  readonly childSystemRoot: string;
} {
  const childSystemRoot = process.env.SystemRoot;
  if (childSystemRoot === undefined) {
    throw new Error('Windows test host has no SystemRoot');
  }
  const directory = mkdtempSync(join(tmpdir(), 'rune-failing-taskkill-'));
  const system32 = join(directory, 'System32');
  mkdirSync(system32);
  const helper = join(system32, 'taskkill.exe');
  copyFileSync(process.execPath, helper);
  const parentEnv = Object.freeze({
    ...Object.fromEntries(
      Object.entries(process.env).filter(([name]) => name.toUpperCase() !== 'SYSTEMROOT'),
    ),
    SystemRoot: directory,
  });
  return { directory, helper, parentEnv, childSystemRoot };
}

interface SpawnRecorder {
  readonly spawned: readonly ChildProcess[];
  readonly stop: () => void;
}

/**
 * Records every child process this worker spawns, through the runtime's own `child_process`
 * diagnostics channel: the runner keeps spawning for real, and a test can tell an invocation of
 * the Windows tree-kill helper apart from its absence.
 */
function recordSpawnedProcesses(): SpawnRecorder {
  const spawned: ChildProcess[] = [];
  const record = (message: unknown): void => {
    spawned.push((message as { readonly process: ChildProcess }).process);
  };
  subscribe('child_process', record);
  return {
    spawned,
    stop: () => {
      unsubscribe('child_process', record);
    },
  };
}

/** The argv of every recorded run of one executable, in spawn order. */
function recordedRuns(recorder: SpawnRecorder, executable: string): readonly (readonly string[])[] {
  return recorder.spawned
    .filter((child) => child.spawnfile === executable)
    .map((child) => [...child.spawnargs]);
}

/** The recorded child process that reported this PID on its own stdout. */
function recordedProcess(recorder: SpawnRecorder, pid: number): ChildProcess {
  const child = recorder.spawned.find((candidate) => candidate.pid === pid);
  if (child === undefined) {
    throw new Error(`no spawned process with PID ${String(pid)} was recorded`);
  }
  return child;
}

/** Waits until the runner has observed the child's exit, which is what the pre-check reads. */
async function waitForObservedExit(child: ChildProcess, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (child.exitCode === null && child.signalCode === null) {
    if (Date.now() > deadline) {
      throw new Error('the direct child did not end within the deadline');
    }
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 10));
  }
}

/** A direct child that exits while a detached grandchild keeps its inherited stdio open. */
function orphanSpawnerScript(exitAfterMs: number): string {
  return [
    'const { spawn } = require("node:child_process");',
    `const grandchild = spawn(${JSON.stringify(process.execPath)}, ["-e", "setInterval(() => {}, 1000)"], { stdio: "inherit", detached: true });`,
    'grandchild.unref();',
    'console.log(`${process.pid}:${grandchild.pid}`);',
    `setTimeout(() => process.exit(0), ${String(exitAfterMs)});`,
  ].join('\n');
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

  it('preserves __proto__ as an enumerable environment entry across layers', () => {
    const environment = mergeSpawnEnvironment(
      Object.fromEntries([['__proto__', 'parent']]),
      Object.fromEntries([['__proto__', 'command']]),
      Object.fromEntries([['__proto__', 'extra']]),
      'linux',
    );

    expect(Object.getPrototypeOf(environment)).toBeNull();
    expect(Object.hasOwn(environment, '__proto__')).toBe(true);
    expect(Object.prototype.propertyIsEnumerable.call(environment, '__proto__')).toBe(true);
    expect(environment['__proto__']).toBe('extra');
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
  }, 15_000);

  it('preserves argument boundaries and contents in a real child process', async () => {
    const args = [
      '',
      'two words',
      'embedded "double quotes"',
      'C:\\Program Files\\RUNE\\',
      '$HOME & echo | pipe; semi',
      'ümlaut 🚀 日本語',
    ];
    const lines: string[] = [];

    await run(
      nodeCommand('console.log(JSON.stringify(process.argv.slice(1)))', {
        argv: [
          process.execPath,
          '-e',
          'console.log(JSON.stringify(process.argv.slice(1)))',
          ...args,
        ],
      }),
      { onOutput: (_stream, line) => lines.push(line) },
    );

    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0]!)).toEqual(args);
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

  it('ignores arbitrary then methods returned by an output callback', async () => {
    const then = vi.fn(() => {
      throw new Error('untrusted then method');
    });
    await expect(
      run(nodeCommand('console.log("line")'), {
        onOutput: () => ({ then }),
      }),
    ).resolves.toEqual({ kind: 'exited', exitCode: 0 });
    expect(then).not.toHaveBeenCalled();
  });

  it('bounds stream read-ahead while a slow sink retains a line, then drains every line', async () => {
    let produced = 0;
    let release = (): void => undefined;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const lines: string[] = [];
    const stream = new Readable({
      highWaterMark: 32,
      read() {
        this.push(produced === 1000 ? null : `${String(produced++).padStart(8, '0')}\n`);
      },
    });
    const forwarding = forwardLines(
      stream,
      (line) => {
        lines.push(line);
        return lines.length === 1 ? held : undefined;
      },
      () => {
        throw new Error('unexpected stream failure');
      },
    );
    try {
      await vi.waitFor(() => expect(lines).toHaveLength(1));
      expect(produced).toBeLessThan(20);
      expect(stream.readableLength).toBeLessThanOrEqual(41);
    } finally {
      release();
    }
    await forwarding;
    expect(lines).toEqual(
      Array.from({ length: 1000 }, (_, index) => String(index).padStart(8, '0')),
    );
  });

  it('cuts off fresh reads after draining the current chunk and buffered snapshot', async () => {
    const cutoff = new AbortController();
    let release = (): void => undefined;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const lines: string[] = [];
    let failures = 0;
    const stream = new Readable({
      read: () => undefined,
      destroy: (_error, callback) => callback(new Error('cutoff iterator stop')),
    });
    const forwarding = forwardLines(
      stream,
      (line) => {
        lines.push(line);
        return lines.length === 1 ? held : undefined;
      },
      () => {
        failures += 1;
      },
      cutoff.signal,
    );

    stream.push('first\ncurrent\nprefix-');
    await vi.waitFor(() => expect(lines).toEqual(['first']));
    stream.push('suffix\nbuffered\nunterminated');
    await vi.waitFor(() => expect(stream.readableLength).toBeGreaterThan(0));

    cutoff.abort();
    expect(stream.destroyed).toBe(true);
    release();
    await forwarding;

    expect(lines).toEqual(['first', 'current', 'prefix-suffix', 'buffered']);
    expect(failures).toBe(0);
  });

  it('cancels a child while preserving buffered output across a prolonged sink stall', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'rune-cancel-drain-'));
    const releasePath = join(directory, 'release-output');
    const expected = [
      'primed',
      ...Array.from({ length: 99 }, (_, index) => `${index}:${'x'.repeat(512)}`),
    ];
    // These ASCII lines fit one parent readable buffer, so `readableLength` can prove the
    // complete post-prime write arrived without depending on OS pipe capacity.
    const bufferedOutput = `${expected.slice(1).join('\n')}\n`;
    const cancel = new CancelToken();
    let release = (): void => undefined;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const lines: string[] = [];
    let pid: number | undefined;
    const recorder = recordSpawnedProcesses();
    let settled = false;
    const pending = run(
      nodeCommand(
        [
          'const fs = require("node:fs");',
          'process.stdout.write("primed\\n");',
          'const lines = Array.from({ length: 99 }, (_, index) => `${index}:${"x".repeat(512)}`);',
          'const waitForRelease = setInterval(() => {',
          `  if (!fs.existsSync(${JSON.stringify(releasePath)})) return;`,
          '  clearInterval(waitForRelease);',
          '  process.stdout.write(lines.join("\\n") + "\\n");',
          '}, 10);',
          'setInterval(() => {}, 1000);',
        ].join('\n'),
      ),
      {
        cancel,
        onOutput: (_stream, line) => {
          lines.push(line);
          return line === 'primed' ? held : undefined;
        },
      },
    ).then((outcome) => {
      settled = true;
      return outcome;
    });
    try {
      await vi.waitFor(
        () => {
          expect(lines).toEqual(['primed']);
          expect(recorder.spawned).toHaveLength(1);
          pid = recorder.spawned[0]?.pid;
          expect(pid).toBeTypeOf('number');
        },
        { timeout: 5000 },
      );
      const child = recorder.spawned[0];
      expect(child?.stdout).not.toBeNull();
      writeFileSync(releasePath, 'release');
      await vi.waitFor(
        () => expect(child?.stdout?.readableLength).toBe(Buffer.byteLength(bufferedOutput, 'utf8')),
        { timeout: 5000 },
      );

      cancel.cancel();
      await vi.waitFor(() => expect(processIsAlive(pid!)).toBe(false), { timeout: 15000 });
      // The runner has closed its read end after the fixed child-close cutoff, but the healthy
      // sink is still pending and must drain the complete parent-accepted buffer when released.
      await vi.waitFor(() => expect(child?.stdout?.destroyed).toBe(true), { timeout: 15000 });
      expect(settled).toBe(false);
      release();
      await expect(withDeadline(pending, 5000)).resolves.toEqual({ kind: 'cancelled' });
      expect(lines).toEqual(expected);
    } finally {
      recorder.stop();
      release();
      cancel.cancel();
      if (pid !== undefined) stopProcess(pid);
      await withDeadline(pending, 15000);
      rmSync(directory, { recursive: true, force: true });
    }
  }, 35000);

  it('waits for a pending output sink after the real child has exited', async () => {
    let release = (): void => undefined;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const lines: string[] = [];
    let settled = false;
    const pending = run(nodeCommand('console.log("first\\nlast")'), {
      onOutput: (_stream, line) => {
        lines.push(line);
        return line === 'last' ? held : undefined;
      },
    }).then((outcome) => {
      settled = true;
      return outcome;
    });
    try {
      await vi.waitFor(() => expect(lines).toEqual(['first', 'last']));
      expect(settled).toBe(false);
    } finally {
      release();
    }
    await expect(pending).resolves.toEqual({ kind: 'exited', exitCode: 0 });
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

    const forwarding = forwardLines(
      stream,
      (line) => lines.push(line),
      () => undefined,
    );
    await ended;
    await forwarding;

    expect(lines).toHaveLength(1);
    expect(lines[0]).toBe('x'.repeat(MAX_OUTPUT_LINE_BYTES));
    expect(Buffer.byteLength(lines[0]!, 'utf8')).toBe(MAX_OUTPUT_LINE_BYTES);
    expect(lines[0]).not.toBe(OVERSIZED_OUTPUT_LINE_PLACEHOLDER);
  });

  it('contains a stream error once and ignores later data and end without exposing it', async () => {
    const lines: string[] = [];
    let failures = 0;
    const stream = new Readable({ read: () => undefined });

    const forwarding = forwardLines(
      stream,
      (line) => lines.push(line),
      () => {
        failures += 1;
      },
    );

    expect(stream.listenerCount('error')).toBeGreaterThanOrEqual(1);
    stream.push('before\n');
    await vi.waitFor(() => expect(lines).toEqual(['before']));
    expect(() => stream.emit('error', new Error('private stream failure'))).not.toThrow();
    expect(() => stream.emit('error', new Error('second private failure'))).not.toThrow();
    stream.push('after\n');
    stream.emit('end');
    await forwarding;

    expect(failures).toBe(1);
    expect(lines).toEqual(['before']);
    expect(JSON.stringify({ lines, failures })).not.toContain('private stream failure');
  });

  it('drains complete lines already read when a stream fails during a pending sink write', async () => {
    let release = (): void => undefined;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const lines: string[] = [];
    let failures = 0;
    const stream = new Readable({ read: () => undefined });
    const forwarding = forwardLines(
      stream,
      (line) => {
        lines.push(line);
        return line === 'first' ? held : undefined;
      },
      () => {
        failures += 1;
      },
    );

    try {
      stream.push('first\nsecond\nunfinished');
      await vi.waitFor(() => expect(lines).toEqual(['first']));
      stream.emit('error', new Error('private read failure'));
      stream.emit('data', 'later chunk\n');
      expect(failures).toBe(1);
      expect(lines).toEqual(['first']);

      release();
      await forwarding;

      expect(lines).toEqual(['first', 'second']);
      expect(failures).toBe(1);
    } finally {
      release();
      stream.destroy();
    }
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

  it('passes a __proto__ environment variable to a real child process', async () => {
    const lines: string[] = [];

    await run(
      nodeCommand('console.log(process.env["__proto__"])', {
        env: Object.fromEntries([['__proto__', 'command']]),
      }),
      {
        parentEnv: Object.freeze(
          Object.fromEntries([...Object.entries(process.env), ['__proto__', 'parent']]),
        ),
        extraEnv: Object.fromEntries([
          ['__proto__', 'extra'],
          ['RUNE_RUN_ID', 'run'],
          ['RUNE_STEP_ID', 'step'],
        ]),
        onOutput: (_stream, line) => lines.push(line),
      },
    );

    expect(lines).toContain('extra');
  });

  it('inherits only the supplied parent snapshot and preserves environment precedence', async () => {
    const inheritedName = 'RUNE_RUNNER_PARENT_ENV_TEST';
    const layeredName = 'RUNE_RUNNER_LAYERED_ENV_TEST';
    const previousValue = process.env[inheritedName];
    const lines: string[] = [];
    process.env[inheritedName] = 'live-parent';

    try {
      await run(
        nodeCommand(
          `console.log([process.env.${inheritedName}, process.env.${layeredName}, process.env.RUNE_STEP_ID].join('|'))`,
          {
            env: {
              [layeredName]: 'command',
              RUNE_STEP_ID: 'command-step',
            },
          },
        ),
        {
          parentEnv: Object.freeze({
            ...process.env,
            [inheritedName]: 'snapshot-parent',
            [layeredName]: 'parent',
            RUNE_STEP_ID: 'parent-step',
          }),
          extraEnv: { RUNE_RUN_ID: 'run', RUNE_STEP_ID: 'extra-step' },
          onOutput: (_stream, line) => lines.push(line),
        },
      );

      expect(lines).toContain('snapshot-parent|command|extra-step');
    } finally {
      if (previousValue === undefined) {
        delete process.env[inheritedName];
      } else {
        process.env[inheritedName] = previousValue;
      }
    }
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
    try {
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
        locale: 'en',
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
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('runs in the working directory the plan chose', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'rune-cwd-'));
    try {
      const lines: string[] = [];

      await run(nodeCommand('console.log(process.cwd())', { cwd: directory }), {
        onOutput: (_stream, line) => lines.push(line),
      });

      expect(lines.join('\n')).toContain(directory.slice(-10));
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  }, 15_000);

  it('reports a command that does not exist as failed to start, not as a crash', async () => {
    const outcome = await run(
      nodeCommand('', { argv: ['rune-definitely-not-installed-anywhere'] }),
    );

    expect(outcome).toEqual({ kind: 'failedToStart', reason: 'commandNotFound' });
  });

  it('does not start a missing command when cancellation was already requested', async () => {
    const cancel = new CancelToken();
    cancel.cancel();

    await expect(
      run(nodeCommand('', { argv: ['rune-definitely-not-installed-anywhere'] }), { cancel }),
    ).resolves.toEqual({ kind: 'cancelled' });
  });

  it('reports cancellation requested before a missing command emits its startup error', async () => {
    const cancel = new CancelToken();
    const pending = run(nodeCommand('', { argv: ['rune-definitely-not-installed-anywhere'] }), {
      cancel,
    });

    cancel.cancel();

    await expect(withDeadline(pending, 5000)).resolves.toEqual({ kind: 'cancelled' });
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
    try {
      const outcome = await run(nodeCommand('', { cwd: join(parent, 'missing') }));

      expect(outcome).toEqual({
        kind: 'failedToStart',
        reason: 'invalidCwd',
      });
    } finally {
      rmSync(parent, { recursive: true, force: true });
    }
  });

  it('gives an invalid cwd precedence when the command is also missing', async () => {
    const parent = mkdtempSync(join(tmpdir(), 'rune-both-missing-'));
    try {
      const outcome = await run(
        nodeCommand('', {
          argv: ['rune-definitely-not-installed-anywhere'],
          cwd: join(parent, 'missing'),
        }),
      );

      expect(outcome).toEqual({ kind: 'failedToStart', reason: 'invalidCwd' });
    } finally {
      rmSync(parent, { recursive: true, force: true });
    }
  });

  it('reports a working-directory file as invalid', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'rune-file-cwd-'));
    const file = join(directory, 'not-a-directory');
    writeFileSync(file, '');

    try {
      await expect(run(nodeCommand('', { cwd: file }))).resolves.toEqual({
        kind: 'failedToStart',
        reason: 'invalidCwd',
      });
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it.skipIf(process.platform === 'win32')(
    'does not blame a valid cwd for ENOTDIR in the executable path',
    async () => {
      const directory = mkdtempSync(join(tmpdir(), 'rune-file-command-'));
      const file = join(directory, 'not-a-directory');
      writeFileSync(file, '');

      try {
        await expect(
          run(
            nodeCommand('', {
              argv: [join(file, 'command')],
              cwd: directory,
            }),
          ),
        ).resolves.toEqual({ kind: 'failedToStart', reason: 'other' });
      } finally {
        rmSync(directory, { recursive: true, force: true });
      }
    },
  );

  it.each([
    ['executable', nodeCommand('', { argv: ['invalid\0executable'] }), 'other'],
    ['argument', nodeCommand('', { argv: [process.execPath, 'invalid\0argument'] }), 'other'],
    ['working directory', nodeCommand('', { cwd: 'invalid\0directory' }), 'invalidCwd'],
    ['environment value', nodeCommand('', { env: { INVALID: 'invalid\0value' } }), 'other'],
    ['environment name', nodeCommand('', { env: { ['INVALID\0NAME']: 'value' } }), 'other'],
  ])('reports an invalid NUL-containing %s without rejecting', async (_name, command, reason) => {
    const outcome = await run(command);

    expect(outcome).toEqual({
      kind: 'failedToStart',
      reason,
    });
    expect(JSON.stringify(outcome)).not.toContain('\\u0000');
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

  // Windows has no POSIX wait status; Node reports this termination as exit code 1.
  it.skipIf(process.platform === 'win32')(
    'reports external signal termination without inventing an exit code',
    async () => {
      const cancel = new CancelToken();
      let pid: number | undefined;
      let resolvePid = (_pid: number): void => undefined;
      const childPid = new Promise<number>((resolve) => {
        resolvePid = resolve;
      });
      const pending = run(nodeCommand('console.log(process.pid); setInterval(() => {}, 1000)'), {
        cancel,
        onOutput: (stream, line) => {
          if (stream === 'stdout') {
            resolvePid(Number(line));
          }
        },
      });

      try {
        pid = await withDeadline(childPid, 5000);
        process.kill(pid, 'SIGTERM');

        await expect(withDeadline(pending, 5000)).resolves.toEqual({ kind: 'signalled' });
      } finally {
        cancel.cancel();
        if (pid !== undefined && processIsAlive(pid)) {
          stopProcess(pid);
        }
        await withDeadline(pending, 15000);
      }
    },
    20000,
  );

  it('uses the snapshotted Windows SystemRoot after a live-environment mutation', async () => {
    const originalSetEncoding = Readable.prototype.setEncoding;
    const encodedStreams = new Set<Readable>();
    const previousSystemRoot = process.env.SystemRoot;
    let parentEnv: Readonly<Record<string, string | undefined>> = Object.freeze({
      ...process.env,
    });
    if (process.platform === 'win32') {
      if (previousSystemRoot === undefined) {
        throw new Error('Windows test host has no SystemRoot');
      }
      parentEnv = Object.freeze({
        ...Object.fromEntries(
          Object.entries(process.env).filter(([name]) => name.toUpperCase() !== 'SYSTEMROOT'),
        ),
        sYsTeMrOoT: previousSystemRoot,
      });
    }
    let pid: number | undefined;
    const setEncoding = vi.spyOn(Readable.prototype, 'setEncoding').mockImplementation(function (
      this: Readable,
      encoding: BufferEncoding,
    ) {
      encodedStreams.add(this);
      return originalSetEncoding.call(this, encoding);
    });

    try {
      const pending = run(nodeCommand('console.log(process.pid); setInterval(() => {}, 1000)'), {
        parentEnv,
        onOutput: (stream, line) => {
          if (stream !== 'stdout' || pid !== undefined) {
            return;
          }
          pid = Number(line);
          if (process.platform === 'win32') {
            process.env.SystemRoot = 'relative-missing-root';
          }
          encodedStreams.values().next().value?.emit('error', new Error('private stdout failure'));
        },
      });

      await expect(withDeadline(pending, 15000)).resolves.toEqual({
        kind: 'streamFailed',
        stream: 'stdout',
      });
      expect(pid).toBeTypeOf('number');
      expect(processIsAlive(pid!)).toBe(false);
    } finally {
      if (previousSystemRoot === undefined) {
        delete process.env.SystemRoot;
      } else {
        process.env.SystemRoot = previousSystemRoot;
      }
      setEncoding.mockRestore();
      if (pid !== undefined && processIsAlive(pid)) {
        stopProcess(pid);
      }
    }
  }, 20000);

  it('bounds a taskkill helper that never closes and contains its later events', async () => {
    vi.useFakeTimers();
    try {
      const helper = new EventEmitter() as EventEmitter & {
        kill: ReturnType<typeof vi.fn>;
      };
      helper.kill = vi.fn(() => true);
      let settlements = 0;
      const pending = waitForTaskkill(
        helper as unknown as Parameters<typeof waitForTaskkill>[0],
        10,
      ).then((result) => {
        settlements += 1;
        return result;
      });

      await vi.advanceTimersByTimeAsync(10);

      await expect(pending).resolves.toBe(false);
      expect(helper.kill).toHaveBeenCalledExactlyOnceWith('SIGKILL');
      expect(() => helper.emit('error', new Error('late helper error'))).not.toThrow();
      helper.emit('close', 0);
      await Promise.resolve();
      expect(settlements).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it.each([
    '\\Windows',
    '/Windows',
    '///Windows',
    String.raw`\\\Windows`,
    String.raw`\\server`,
    String.raw`C:Windows`,
    String.raw`\\?\C:\Windows`,
    String.raw`\\.\Windows`,
  ])('rejects an invalid Windows SystemRoot %s without spawning taskkill', async (systemRoot) => {
    const spawnTaskkill = vi.fn();

    await expect(
      spawnRunnerTestSeam.runTaskkill(
        123,
        { SystemRoot: systemRoot },
        spawnTaskkill as unknown as typeof spawnChildProcess,
      ),
    ).resolves.toBe(false);
    expect(spawnTaskkill).not.toHaveBeenCalled();
  });

  it.each(['C:\\Windows', 'C:/Windows', '\\\\server\\share\\Windows', '//server/share/Windows'])(
    'accepts fully qualified Windows SystemRoot %s for taskkill',
    async (systemRoot) => {
      const helper = new EventEmitter() as EventEmitter & {
        kill: ReturnType<typeof vi.fn>;
      };
      helper.kill = vi.fn(() => true);
      const spawnTaskkill = vi.fn(() => {
        queueMicrotask(() => helper.emit('close', 0));
        return helper;
      });

      await expect(
        spawnRunnerTestSeam.runTaskkill(
          123,
          { SystemRoot: systemRoot },
          spawnTaskkill as unknown as typeof spawnChildProcess,
        ),
      ).resolves.toBe(true);
      expect(spawnTaskkill).toHaveBeenCalledExactlyOnceWith(
        win32.join(systemRoot, 'System32', 'taskkill.exe'),
        ['/PID', '123', '/T', '/F'],
        {
          env: { SystemRoot: systemRoot },
          stdio: 'ignore',
          shell: false,
        },
      );
    },
  );

  it('bounds /proc stat reads to four workers while fully checking zombies and foreign groups', async () => {
    const processIds = Array.from({ length: 100 }, (_, index) => String(index + 1));
    let activeReads = 0;
    let maximumActiveReads = 0;

    await expect(
      spawnRunnerTestSeam.scanProcProcessGroup(71, new AbortController().signal, {
        readProcessIds: async () => processIds,
        readProcessStat: async (processId) => {
          activeReads += 1;
          maximumActiveReads = Math.max(maximumActiveReads, activeReads);
          await Promise.resolve();
          activeReads -= 1;
          const numericPid = Number(processId);
          return numericPid % 2 === 0
            ? processStat(numericPid, 'Z', 71)
            : processStat(numericPid, 'S', 72);
        },
      }),
    ).resolves.toBe(false);

    expect(maximumActiveReads).toBe(4);
    expect(activeReads).toBe(0);
  });

  it('short-circuits /proc scanning without starting more reads after a live member', async () => {
    const processIds = Array.from({ length: 100 }, (_, index) => String(index + 1));
    const reads: string[] = [];

    await expect(
      spawnRunnerTestSeam.scanProcProcessGroup(73, new AbortController().signal, {
        readProcessIds: async () => processIds,
        readProcessStat: (processId, signal) => {
          reads.push(processId);
          if (processId === '1') {
            return Promise.resolve(processStat(1, 'S', 73));
          }
          return new Promise((_resolve, reject) => {
            signal.addEventListener('abort', () => reject(signal.reason), { once: true });
          });
        },
      }),
    ).resolves.toBe(true);

    expect(reads).toEqual(['1', '2', '3', '4']);
    await Promise.resolve();
    expect(reads).toHaveLength(4);
  });

  it('ignores /proc disappearance races while checking the remaining entries', async () => {
    const errors = new Map([
      ['1', 'ENOENT'],
      ['2', 'ESRCH'],
    ]);

    await expect(
      spawnRunnerTestSeam.scanProcProcessGroup(74, new AbortController().signal, {
        readProcessIds: async () => ['1', '2', '3'],
        readProcessStat: async (processId) => {
          const code = errors.get(processId);
          if (code !== undefined) {
            throw errno(code);
          }
          return processStat(3, 'S', 75);
        },
      }),
    ).resolves.toBe(false);
  });

  it.each([
    ['EACCES', (): Promise<string> => Promise.reject(errno('EACCES'))],
    ['EIO', (): Promise<string> => Promise.reject(errno('EIO'))],
    ['malformed stat', (): Promise<string> => Promise.resolve('malformed')],
  ])('treats an unclear /proc entry (%s) as live', async (_case, readProcessStat) => {
    await expect(
      spawnRunnerTestSeam.scanProcProcessGroup(76, new AbortController().signal, {
        readProcessIds: async () => ['1'],
        readProcessStat,
      }),
    ).resolves.toBe(true);
  });

  it('confirms an initially absent POSIX process group only for ESRCH', async () => {
    const signal = vi.fn((): never => {
      throw errno('ESRCH');
    });
    const probe = vi.fn(async () => true);

    await expect(
      spawnRunnerTestSeam.terminateProcessGroup(41, {
        signal,
        exists: vi.fn(() => false),
        probe,
        timings: TEST_TERMINATION_TIMINGS,
      }),
    ).resolves.toBe(true);
    expect(signal).toHaveBeenCalledExactlyOnceWith(-41, 'SIGTERM');
    expect(probe).not.toHaveBeenCalled();
  });

  it.each(['EPERM', 'EACCES', 'EIO', undefined])(
    'does not confirm an initial POSIX signal failure with code %s',
    async (code) => {
      const signal = vi.fn((): never => {
        throw errno(code);
      });
      const probe = vi.fn(async () => false);

      await expect(
        spawnRunnerTestSeam.terminateProcessGroup(42, {
          signal,
          exists: vi.fn(() => false),
          probe,
          timings: TEST_TERMINATION_TIMINGS,
        }),
      ).resolves.toBe(false);
      expect(signal).toHaveBeenCalledExactlyOnceWith(-42, 'SIGTERM');
      expect(probe).not.toHaveBeenCalled();
    },
  );

  it('confirms POSIX group exit during the SIGTERM grace period', async () => {
    vi.useFakeTimers();
    try {
      const signal = vi.fn(() => true);
      const exists = vi.fn().mockReturnValueOnce(true).mockReturnValueOnce(false);
      const probe = vi.fn(async () => false);
      const pending = spawnRunnerTestSeam.terminateProcessGroup(43, {
        signal,
        exists,
        probe,
        timings: TEST_TERMINATION_TIMINGS,
      });

      await vi.advanceTimersByTimeAsync(10);

      await expect(pending).resolves.toBe(true);
      expect(signal).toHaveBeenCalledExactlyOnceWith(-43, 'SIGTERM');
      expect(exists).toHaveBeenCalledTimes(2);
      expect(probe).not.toHaveBeenCalled();
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not trust a pre-SIGKILL /proc snapshot while the group still exists', async () => {
    vi.useFakeTimers();
    try {
      let firmSignalSent = false;
      const firmSignalStateAtProbe: boolean[] = [];
      const signal = vi.fn((_pid: number, signalName: NodeJS.Signals) => {
        firmSignalSent ||= signalName === 'SIGKILL';
      });
      const exists = vi.fn(() => true);
      const probe = vi.fn(async () => {
        firmSignalStateAtProbe.push(firmSignalSent);
        return false;
      });
      const pending = spawnRunnerTestSeam.terminateProcessGroup(78, {
        signal,
        exists,
        probe,
        timings: TEST_TERMINATION_TIMINGS,
      });

      await vi.advanceTimersByTimeAsync(50);

      await expect(pending).resolves.toBe(true);
      expect(signal.mock.calls).toEqual([
        [-78, 'SIGTERM'],
        [-78, 'SIGKILL'],
      ]);
      expect(exists).toHaveBeenCalled();
      expect(probe).toHaveBeenCalledOnce();
      expect(firmSignalStateAtProbe).toEqual([true]);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('confirms POSIX termination when SIGKILL finds the group absent', async () => {
    vi.useFakeTimers();
    try {
      const signal = vi.fn((_pid: number, signalName: NodeJS.Signals) => {
        if (signalName === 'SIGKILL') {
          throw errno('ESRCH');
        }
      });
      const pending = spawnRunnerTestSeam.terminateProcessGroup(44, {
        signal,
        exists: () => true,
        probe: async () => true,
        timings: TEST_TERMINATION_TIMINGS,
      });

      await vi.advanceTimersByTimeAsync(50);

      await expect(pending).resolves.toBe(true);
      expect(signal.mock.calls).toEqual([
        [-44, 'SIGTERM'],
        [-44, 'SIGKILL'],
      ]);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not confirm POSIX termination when SIGKILL is denied', async () => {
    vi.useFakeTimers();
    try {
      const signal = vi.fn((_pid: number, signalName: NodeJS.Signals) => {
        if (signalName === 'SIGKILL') {
          throw errno('EPERM');
        }
      });
      const pending = spawnRunnerTestSeam.terminateProcessGroup(45, {
        signal,
        exists: () => true,
        probe: async () => true,
        timings: TEST_TERMINATION_TIMINGS,
      });

      await vi.advanceTimersByTimeAsync(50);

      await expect(pending).resolves.toBe(false);
      expect(signal.mock.calls).toEqual([
        [-45, 'SIGTERM'],
        [-45, 'SIGKILL'],
      ]);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('confirms POSIX group exit after SIGKILL', async () => {
    vi.useFakeTimers();
    try {
      let firmSignalSent = false;
      let firmProbes = 0;
      const signal = vi.fn((_pid: number, signalName: NodeJS.Signals) => {
        firmSignalSent ||= signalName === 'SIGKILL';
      });
      const probe = vi.fn(async () => {
        if (!firmSignalSent) {
          return true;
        }
        firmProbes += 1;
        return firmProbes === 1;
      });
      const pending = spawnRunnerTestSeam.terminateProcessGroup(46, {
        signal,
        exists: () => true,
        probe,
        timings: TEST_TERMINATION_TIMINGS,
      });

      await vi.advanceTimersByTimeAsync(60);

      await expect(pending).resolves.toBe(true);
      expect(signal.mock.calls).toEqual([
        [-46, 'SIGTERM'],
        [-46, 'SIGKILL'],
      ]);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('fails POSIX confirmation when the group stays live through both deadlines', async () => {
    vi.useFakeTimers();
    try {
      const signal = vi.fn(() => true);
      const pending = spawnRunnerTestSeam.terminateProcessGroup(47, {
        signal,
        exists: () => true,
        probe: async () => true,
        timings: TEST_TERMINATION_TIMINGS,
      });

      await vi.advanceTimersByTimeAsync(100);

      await expect(pending).resolves.toBe(false);
      expect(signal.mock.calls).toEqual([
        [-47, 'SIGTERM'],
        [-47, 'SIGKILL'],
      ]);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('bounds a post-SIGKILL /proc probe that never settles', async () => {
    vi.useFakeTimers();
    try {
      const signal = vi.fn(() => true);
      const never = new Promise<boolean>(() => undefined);
      const pending = spawnRunnerTestSeam.terminateProcessGroup(48, {
        signal,
        exists: () => true,
        probe: () => never,
        timings: TEST_TERMINATION_TIMINGS,
      });

      await vi.advanceTimersByTimeAsync(100);

      await expect(pending).resolves.toBe(false);
      expect(signal.mock.calls).toEqual([
        [-48, 'SIGTERM'],
        [-48, 'SIGKILL'],
      ]);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('aborts an expired post-SIGKILL /proc probe at the confirmation deadline', async () => {
    vi.useFakeTimers();
    try {
      const signal = vi.fn(() => true);
      const probeSignals: AbortSignal[] = [];
      const lateSettlements: Array<() => void> = [];
      let activeReads = 0;
      let maximumActiveReads = 0;
      let readsStarted = 0;
      const probe = (pid: number, probeSignal: AbortSignal): Promise<boolean> => {
        probeSignals.push(probeSignal);
        return spawnRunnerTestSeam.scanProcProcessGroup(pid, probeSignal, {
          readProcessIds: async () => Array.from({ length: 100 }, (_, index) => String(index + 1)),
          readProcessStat: (_processId, readSignal) => {
            readsStarted += 1;
            activeReads += 1;
            maximumActiveReads = Math.max(maximumActiveReads, activeReads);
            return new Promise((resolve, reject) => {
              let settled = false;
              const settleLate = (): void => {
                if (settled) {
                  return;
                }
                settled = true;
                activeReads -= 1;
                resolve(processStat(1, 'S', pid + 1));
              };
              lateSettlements.push(settleLate);
              readSignal.addEventListener(
                'abort',
                () => {
                  if (settled) {
                    return;
                  }
                  settled = true;
                  activeReads -= 1;
                  reject(readSignal.reason);
                },
                { once: true },
              );
            });
          },
        });
      };
      const pending = spawnRunnerTestSeam.terminateProcessGroup(77, {
        signal,
        exists: () => true,
        probe,
        timings: TEST_TERMINATION_TIMINGS,
      });

      await vi.advanceTimersByTimeAsync(100);

      await expect(pending).resolves.toBe(false);
      expect(signal.mock.calls).toEqual([
        [-77, 'SIGTERM'],
        [-77, 'SIGKILL'],
      ]);
      expect(probeSignals).toHaveLength(1);
      expect(probeSignals.every((probeSignal) => probeSignal.aborted)).toBe(true);
      expect(maximumActiveReads).toBe(4);
      expect(activeReads).toBe(0);
      expect(readsStarted).toBe(4);

      for (const settleLate of lateSettlements) {
        settleLate();
      }
      await Promise.resolve();
      await Promise.resolve();
      expect(readsStarted).toBe(4);
      expect(signal).toHaveBeenCalledTimes(2);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('cleans POSIX timers and ignores a late post-SIGKILL probe settlement', async () => {
    vi.useFakeTimers();
    try {
      let resolveLateProbe = (_live: boolean): void => undefined;
      const lateProbe = new Promise<boolean>((resolve) => {
        resolveLateProbe = resolve;
      });
      const signal = vi.fn(() => true);
      const pending = spawnRunnerTestSeam.terminateProcessGroup(49, {
        signal,
        exists: () => true,
        probe: () => lateProbe,
        timings: TEST_TERMINATION_TIMINGS,
      });

      await vi.advanceTimersByTimeAsync(100);

      await expect(pending).resolves.toBe(false);
      expect(signal.mock.calls).toEqual([
        [-49, 'SIGTERM'],
        [-49, 'SIGKILL'],
      ]);
      expect(vi.getTimerCount()).toBe(0);

      resolveLateProbe(true);
      await Promise.resolve();
      await Promise.resolve();
      expect(signal).toHaveBeenCalledTimes(2);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('bounds child-close completion and contains a late close', async () => {
    vi.useFakeTimers();
    try {
      let resolveClose = (): void => undefined;
      const close = new Promise<void>((resolve) => {
        resolveClose = resolve;
      });
      const pending = spawnRunnerTestSeam.waitForCompletion(close, 25);

      await vi.advanceTimersByTimeAsync(25);

      await expect(pending).resolves.toBe(false);
      expect(vi.getTimerCount()).toBe(0);
      resolveClose();
      await Promise.resolve();
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('cleans the child-close watchdog after early completion', async () => {
    vi.useFakeTimers();
    try {
      await expect(spawnRunnerTestSeam.waitForCompletion(Promise.resolve(), 25)).resolves.toBe(
        true,
      );
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

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

  it.skipIf(process.platform === 'win32').each(['timedOut', 'cancelled'] as const)(
    'keeps the first %s cause during graceful termination',
    async (firstCause) => {
      const cancel = new CancelToken();
      const signals: string[] = [];
      let ready = (): void => undefined;
      let terminated = (): void => undefined;
      const childReady = new Promise<void>((resolve) => {
        ready = resolve;
      });
      const childTerminated = new Promise<void>((resolve) => {
        terminated = resolve;
      });
      let expire = (): void => {
        throw new Error('run deadline was not armed');
      };
      // Capture only the run deadline. Drive it after the real child has installed
      // its signal handler; process startup speed must not decide the winning cause.
      const timer = vi.spyOn(globalThis, 'setTimeout').mockImplementationOnce((callback) => {
        expire = callback;
        return scheduleTimeout(() => undefined, 15000);
      });
      const pending = run(
        nodeCommand(
          [
            'let signals = 0;',
            'process.on("SIGTERM", () => {',
            '  console.log(`term:${++signals}`);',
            '  setTimeout(() => process.exit(0), 300);',
            '});',
            'console.log("ready");',
            'setInterval(() => {}, 1000);',
          ].join('\n'),
          { timeoutSeconds: 0.05 },
        ),
        {
          cancel,
          onOutput: (_stream, line) => {
            signals.push(line);
            if (line === 'ready') ready();
            if (line === 'term:1') terminated();
          },
        },
      );
      timer.mockRestore();

      try {
        await withDeadline(childReady, 5000);
        if (firstCause === 'timedOut') expire();
        else cancel.cancel();
        await withDeadline(childTerminated, 5000);
        if (firstCause === 'timedOut') cancel.cancel();
        else expire();

        await expect(withDeadline(pending, 10000)).resolves.toEqual({ kind: firstCause });
        expect(signals.filter((line) => line.startsWith('term:'))).toEqual(['term:1']);
      } finally {
        timer.mockRestore();
        cancel.cancel();
      }
    },
    15000,
  );

  it('does not resolve termination until a real child process tree is gone', async () => {
    const cancel = new CancelToken();
    const previousPath = process.env.PATH;
    const { directory, parentScript } = createRealProcessTreeFixture();
    let parentPid: number | undefined;
    let grandchildPid: number | undefined;
    let resolveProcessIds = (_ids: readonly [number, number]): void => undefined;
    const processIds = new Promise<readonly [number, number]>((resolveIds) => {
      resolveProcessIds = resolveIds;
    });
    if (process.platform === 'win32') {
      process.env.PATH = '';
    }
    const pending = run(nodeCommand(parentScript), {
      cancel,
      onOutput: (_stream, line) => {
        const match = /^(\d+):(\d+)$/.exec(line);
        if (match?.[1] !== undefined && match[2] !== undefined) {
          parentPid = Number(match[1]);
          grandchildPid = Number(match[2]);
          resolveProcessIds([parentPid, grandchildPid]);
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
      if (process.platform === 'win32') {
        if (previousPath === undefined) {
          delete process.env.PATH;
        } else {
          process.env.PATH = previousPath;
        }
      }
      cancel.cancel();
      if (parentPid !== undefined) {
        stopProcess(parentPid);
      }
      if (grandchildPid !== undefined) {
        stopProcess(grandchildPid);
      }
      try {
        await withDeadline(pending, 5000);
      } catch {
        // The explicit PID cleanup below remains the integration-test backstop.
      }
      if (parentPid !== undefined) {
        stopProcess(parentPid);
      }
      if (grandchildPid !== undefined) {
        stopProcess(grandchildPid);
      }
      rmSync(directory, { recursive: true, force: true });
    }
  }, 25000);

  it('waits for descendant EOF without an implicit normal-completion deadline', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'rune-descendant-output-'));
    const releasePath = join(directory, 'release-output');
    const grandchildScript = [
      'const { existsSync } = require("node:fs");',
      'const poll = setInterval(() => {',
      `  if (!existsSync(${JSON.stringify(releasePath)})) return;`,
      '  clearInterval(poll);',
      '  process.stdout.write("late:first\\nlate:stdout-tail");',
      '  process.stderr.write("late:error\\nlate:stderr-tail");',
      '}, 10);',
    ].join('\n');
    const parentScript = [
      'const { spawn } = require("node:child_process");',
      `const grandchild = spawn(${JSON.stringify(process.execPath)}, ["-e", ${JSON.stringify(grandchildScript)}], { stdio: "inherit", detached: true });`,
      'grandchild.unref();',
      'process.stdout.write(`${process.pid}:${grandchild.pid}\\n`, () => process.exit(0));',
    ].join('\n');
    const recorder = recordSpawnedProcesses();
    const cancel = new TrackedCancelToken();
    const stdout: string[] = [];
    const stderr: string[] = [];
    let settled = false;
    let parentPid: number | undefined;
    let grandchildPid: number | undefined;
    let reportProcessIds = (_ids: readonly [number, number]): void => undefined;
    const processIds = new Promise<readonly [number, number]>((resolveIds) => {
      reportProcessIds = resolveIds;
    });
    const pending = run(nodeCommand(parentScript), {
      cancel,
      onOutput: (stream, line) => {
        (stream === 'stdout' ? stdout : stderr).push(line);
        const match = /^(\d+):(\d+)$/.exec(line);
        if (match?.[1] !== undefined && match[2] !== undefined) {
          reportProcessIds([Number(match[1]), Number(match[2])]);
        }
      },
    }).then((outcome) => {
      settled = true;
      return outcome;
    });

    try {
      [parentPid, grandchildPid] = await withDeadline(processIds, 5000);
      const directChild = recordedProcess(recorder, parentPid);
      await waitForObservedExit(directChild, 5000);
      expect(directChild.exitCode).toBe(0);
      expect(processIsAlive(grandchildPid)).toBe(true);
      // Normal completion has no counterpart to the five-second close deadline used after
      // termination. Only this test's explicit release lets the descendant reach EOF.
      await new Promise<void>((resolveDelay) => setTimeout(resolveDelay, 6000));
      expect(settled).toBe(false);
      expect(cancel.activeListeners).toBe(1);
      expect(directChild.stdout?.readableEnded).toBe(false);
      expect(directChild.stderr?.readableEnded).toBe(false);
      expect(stdout).toEqual([`${parentPid}:${grandchildPid}`]);
      expect(stderr).toEqual([]);

      writeFileSync(releasePath, 'release');

      await expect(withDeadline(pending, 5000)).resolves.toEqual({ kind: 'exited', exitCode: 0 });
      expect(stdout).toEqual([`${parentPid}:${grandchildPid}`, 'late:first', 'late:stdout-tail']);
      expect(stderr).toEqual(['late:error', 'late:stderr-tail']);
      expect(directChild.stdout?.readableEnded).toBe(true);
      expect(directChild.stderr?.readableEnded).toBe(true);
      expect(cancel.activeListeners).toBe(0);
    } finally {
      recorder.stop();
      cancel.cancel();
      if (parentPid !== undefined) stopProcess(parentPid);
      if (grandchildPid !== undefined) stopProcess(grandchildPid);
      try {
        await withDeadline(pending, 5000);
      } finally {
        rmSync(directory, { recursive: true, force: true });
      }
    }
  }, 20000);

  it('keeps a fixed close cutoff while an escaped descendant continues output', async () => {
    // The grandchild inherits the step's stdout/stderr pipes, leaves the process group, and
    // outlives the direct child; only the runner's read ends decide whether the host can exit.
    const grandchildScript = [
      'process.stdout.on("error", () => {});',
      'const heartbeat = setInterval(() => console.log("orphan:tick"), 100);',
      'setTimeout(() => clearInterval(heartbeat), 20000);',
    ].join('\n');
    const parentScript = [
      'const { spawn } = require("node:child_process");',
      `const grandchild = spawn(${JSON.stringify(process.execPath)}, ["-e", ${JSON.stringify(grandchildScript)}], { stdio: "inherit", detached: true });`,
      'grandchild.unref();',
      'console.log(`${process.pid}:${grandchild.pid}`);',
      'setTimeout(() => process.exit(0), 200);',
    ].join('\n');
    // Node reports libuv pipe handles as PipeWrap on Windows and Linux alike. The baseline
    // holds the worker's own pipes, which do not change during this test.
    const pipeCount = (): number =>
      process.getActiveResourcesInfo().filter((resource) => resource === 'PipeWrap').length;
    const baseline = pipeCount();
    const recorder = recordSpawnedProcesses();
    let reportProcessIds = (_ids: readonly [number, number]): void => undefined;
    const processIds = new Promise<readonly [number, number]>((resolveIds) => {
      reportProcessIds = resolveIds;
    });
    let parentPid: number | undefined;
    let grandchildPid: number | undefined;
    let heartbeatLines = 0;
    let settled = false;
    const pending = run(nodeCommand(parentScript, { timeoutSeconds: 2 }), {
      onOutput: (_stream, line) => {
        const match = /^(\d+):(\d+)$/.exec(line);
        if (match?.[1] !== undefined && match[2] !== undefined) {
          reportProcessIds([Number(match[1]), Number(match[2])]);
        }
        if (line === 'orphan:tick') heartbeatLines += 1;
        // The sink remains healthy and faster than the producer. Its Promises must not let fresh
        // descendant output extend the fixed child-close cutoff.
        return line === 'orphan:tick'
          ? new Promise<void>((resolveLine) => setTimeout(resolveLine, 75))
          : Promise.resolve();
      },
    }).then((outcome) => {
      settled = true;
      return outcome;
    });

    try {
      [parentPid, grandchildPid] = await withDeadline(processIds, 5000);
      const directChild = recordedProcess(recorder, parentPid);
      await waitForObservedExit(directChild, 5000);
      expect(directChild.exitCode).toBe(0);
      expect(directChild.stdout?.readableEnded).toBe(false);
      expect(processIsAlive(grandchildPid)).toBe(true);
      expect(settled).toBe(false);

      // The direct child has ended, so both platforms confirm the tree absent and keep the
      // timeout cause; the bounded close wait expires despite the orphan's regular output.
      await expect(withDeadline(pending, 15000)).resolves.toEqual({ kind: 'timedOut' });
      expect(heartbeatLines).toBeGreaterThanOrEqual(3);
      // The orphan is still alive: the host is released by dropping the pipe ends, not by
      // killing it.
      expect(processIsAlive(grandchildPid)).toBe(true);

      const linesAtSettlement = heartbeatLines;
      await new Promise<void>((resolveDelay) => setTimeout(resolveDelay, 300));
      expect(heartbeatLines).toBe(linesAtSettlement);

      const settledAt = Date.now();
      while (pipeCount() !== baseline && Date.now() - settledAt < 2000) {
        await new Promise((resolveDelay) => setTimeout(resolveDelay, 25));
      }
      expect(pipeCount()).toBe(baseline);
    } finally {
      recorder.stop();
      if (parentPid !== undefined) stopProcess(parentPid);
      if (grandchildPid !== undefined) {
        stopProcess(grandchildPid);
      }
      try {
        await withDeadline(pending, 5000);
      } catch {
        // The explicit PID cleanup above remains the integration-test backstop.
      }
    }
  }, 20000);

  it('does not resolve a timeout until a real child process tree is gone', async () => {
    const { directory, parentScript } = createRealProcessTreeFixture();
    let parentPid: number | undefined;
    let grandchildPid: number | undefined;
    let resolveProcessIds = (_ids: readonly [number, number]): void => undefined;
    const processIds = new Promise<readonly [number, number]>((resolveIds) => {
      resolveProcessIds = resolveIds;
    });
    const pending = run(nodeCommand(parentScript, { timeoutSeconds: 8 }), {
      onOutput: (_stream, line) => {
        const match = /^(\d+):(\d+)$/.exec(line);
        if (match?.[1] !== undefined && match[2] !== undefined) {
          parentPid = Number(match[1]);
          grandchildPid = Number(match[2]);
          resolveProcessIds([parentPid, grandchildPid]);
        }
      },
    });

    try {
      [parentPid, grandchildPid] = await withDeadline(processIds, 5000);
      expect(processIsAlive(parentPid)).toBe(true);
      expect(processIsAlive(grandchildPid)).toBe(true);

      await expect(withDeadline(pending, 15000)).resolves.toEqual({ kind: 'timedOut' });
      expect(processIsAlive(parentPid)).toBe(false);
      expect(processIsAlive(grandchildPid)).toBe(false);
    } finally {
      if (parentPid !== undefined) {
        stopProcess(parentPid);
      }
      if (grandchildPid !== undefined) {
        stopProcess(grandchildPid);
      }
      try {
        await withDeadline(pending, 15000);
      } catch {
        // The explicit PID cleanup below remains the integration-test backstop.
      }
      if (parentPid !== undefined) {
        stopProcess(parentPid);
      }
      if (grandchildPid !== undefined) {
        stopProcess(grandchildPid);
      }
      rmSync(directory, { recursive: true, force: true });
    }
  }, 25000);

  it.runIf(process.platform === 'win32')(
    'reports unconfirmed termination when snapshotted SystemRoot contains no taskkill',
    async () => {
      const childSystemRoot = process.env.SystemRoot;
      if (childSystemRoot === undefined) {
        throw new Error('Windows test host has no SystemRoot');
      }
      const systemRoot = mkdtempSync(join(tmpdir(), 'rune-empty-system-root-'));
      const parentEnv = Object.freeze({
        ...Object.fromEntries(
          Object.entries(process.env).filter(([name]) => name.toUpperCase() !== 'SYSTEMROOT'),
        ),
        SystemRoot: systemRoot,
      });
      const cancel = new CancelToken();
      let pending: ReturnType<typeof run> | undefined;
      let pid: number | undefined;
      let resolvePid = (_pid: number): void => undefined;
      const ready = new Promise<number>((resolve) => {
        resolvePid = resolve;
      });
      try {
        pending = run(
          nodeCommand('console.log(process.pid); setInterval(() => {}, 1000)', {
            env: { SystemRoot: childSystemRoot },
          }),
          {
            cancel,
            parentEnv,
            onOutput: (stream, line) => {
              if (stream === 'stdout') {
                pid = Number(line);
                resolvePid(pid);
              }
            },
          },
        );
        pid = await withDeadline(ready, 5000);
        cancel.cancel();

        await expect(withDeadline(pending, 15000)).resolves.toEqual({
          kind: 'terminationFailed',
        });
        expect(processIsAlive(pid)).toBe(false);
      } finally {
        cancel.cancel();
        if (pid !== undefined && processIsAlive(pid)) {
          stopProcess(pid);
        }
        if (pending !== undefined) {
          try {
            await withDeadline(pending, 5000);
          } catch {
            // The explicit PID cleanup below remains the integration-test backstop.
          }
        }
        if (pid !== undefined && processIsAlive(pid)) {
          stopProcess(pid);
        }
        rmSync(systemRoot, { recursive: true, force: true });
      }
    },
    20000,
  );

  it.runIf(process.platform === 'win32')(
    'reports unconfirmed termination when the absolute taskkill helper is unsuccessful',
    async () => {
      const childSystemRoot = process.env.SystemRoot;
      if (childSystemRoot === undefined) {
        throw new Error('Windows test host has no SystemRoot');
      }
      const directory = mkdtempSync(join(tmpdir(), 'rune-fake-system-root-'));
      const system32 = join(directory, 'System32');
      mkdirSync(system32);
      copyFileSync(process.execPath, join(system32, 'taskkill.exe'));
      const parentEnv = Object.freeze({
        ...Object.fromEntries(
          Object.entries(process.env).filter(([name]) => name.toUpperCase() !== 'SYSTEMROOT'),
        ),
        SystemRoot: directory,
      });
      const cancel = new CancelToken();
      let pending: ReturnType<typeof run> | undefined;
      let pid: number | undefined;
      let resolvePid = (_pid: number): void => undefined;
      const ready = new Promise<number>((resolve) => {
        resolvePid = resolve;
      });
      try {
        pending = run(
          nodeCommand('console.log(process.pid); setInterval(() => {}, 1000)', {
            env: { SystemRoot: childSystemRoot },
          }),
          {
            cancel,
            parentEnv,
            onOutput: (stream, line) => {
              if (stream === 'stdout') {
                pid = Number(line);
                resolvePid(pid);
              }
            },
          },
        );
        pid = await withDeadline(ready, 5000);
        cancel.cancel();

        await expect(withDeadline(pending, 15000)).resolves.toEqual({
          kind: 'terminationFailed',
        });
        expect(processIsAlive(pid)).toBe(false);
      } finally {
        cancel.cancel();
        if (pid !== undefined && processIsAlive(pid)) {
          stopProcess(pid);
        }
        if (pending !== undefined) {
          try {
            await withDeadline(pending, 5000);
          } catch {
            // The explicit PID cleanup below remains the integration-test backstop.
          }
        }
        if (pid !== undefined && processIsAlive(pid)) {
          stopProcess(pid);
        }
        rmSync(directory, { recursive: true, force: true });
      }
    },
    20000,
  );

  it.runIf(process.platform === 'win32')(
    'confirms cancellation of a direct child that had already ended, without the helper',
    async () => {
      const fixture = createFailingTaskkillFixture();
      const recorder = recordSpawnedProcesses();
      const cancel = new CancelToken();
      let pending: ReturnType<typeof run> | undefined;
      let parentPid: number | undefined;
      let grandchildPid: number | undefined;
      let resolveProcessIds = (_ids: readonly [number, number]): void => undefined;
      const processIds = new Promise<readonly [number, number]>((resolveIds) => {
        resolveProcessIds = resolveIds;
      });
      try {
        // The grandchild keeps the inherited pipes open, so the direct child's exit is observed
        // while its close is still pending: the window a console Ctrl+C opens on Windows.
        pending = run(
          nodeCommand(orphanSpawnerScript(100), { env: { SystemRoot: fixture.childSystemRoot } }),
          {
            cancel,
            parentEnv: fixture.parentEnv,
            onOutput: (_stream, line) => {
              const match = /^(\d+):(\d+)$/.exec(line);
              if (match?.[1] !== undefined && match[2] !== undefined) {
                resolveProcessIds([Number(match[1]), Number(match[2])]);
              }
            },
          },
        );
        [parentPid, grandchildPid] = await withDeadline(processIds, 5000);
        // The runner must have observed the exit before the cancel arrives; the OS reports the
        // PID gone about thirty milliseconds earlier, which is not yet the state under test.
        await waitForObservedExit(recordedProcess(recorder, parentPid), 5000);
        expect(processIsAlive(parentPid)).toBe(false);

        cancel.cancel();
        // Release the pipes only after the cause is recorded, so the close cannot settle first.
        stopProcess(grandchildPid);

        await expect(withDeadline(pending, 15000)).resolves.toEqual({ kind: 'cancelled' });
        // The pre-check keeps the forced tree kill away from a PID Windows may have recycled.
        expect(recordedRuns(recorder, fixture.helper)).toEqual([]);
      } finally {
        recorder.stop();
        cancel.cancel();
        if (grandchildPid !== undefined) {
          stopProcess(grandchildPid);
        }
        if (pending !== undefined) {
          try {
            await withDeadline(pending, 5000);
          } catch {
            // The explicit PID cleanup above remains the integration-test backstop.
          }
        }
        rmSync(fixture.directory, { recursive: true, force: true });
      }
    },
    20000,
  );

  it.runIf(process.platform === 'win32')(
    'confirms cancellation of a direct child that ends while the failing helper runs',
    async () => {
      const fixture = createFailingTaskkillFixture();
      const recorder = recordSpawnedProcesses();
      const cancel = new CancelToken();
      let pending: ReturnType<typeof run> | undefined;
      let pid: number | undefined;
      try {
        // The child exits on its own the moment its READY line is out, and the cancel request
        // arrives on that line — the runner then re-checks the child after the helper fails.
        pending = run(
          nodeCommand(
            'process.stdout.write(String(process.pid) + String.fromCharCode(10), () => process.exit(0))',
            { env: { SystemRoot: fixture.childSystemRoot } },
          ),
          {
            cancel,
            parentEnv: fixture.parentEnv,
            onOutput: (stream, line) => {
              if (stream === 'stdout') {
                pid = Number(line);
                cancel.cancel();
              }
            },
          },
        );

        await expect(withDeadline(pending, 15000)).resolves.toEqual({ kind: 'cancelled' });
        expect(pid).toBeDefined();
        expect(processIsAlive(pid!)).toBe(false);
        // The exit is not observed yet when the cancel arrives, so the helper runs once and only
        // the re-check after its failure can confirm this termination.
        expect(recordedRuns(recorder, fixture.helper)).toEqual([
          [fixture.helper, '/PID', String(pid), '/T', '/F'],
        ]);
      } finally {
        recorder.stop();
        cancel.cancel();
        if (pending !== undefined) {
          try {
            await withDeadline(pending, 5000);
          } catch {
            // The child exits by itself; nothing else is left to clean up.
          }
        }
        if (pid !== undefined && processIsAlive(pid)) {
          stopProcess(pid);
        }
        rmSync(fixture.directory, { recursive: true, force: true });
      }
    },
    20000,
  );
});
