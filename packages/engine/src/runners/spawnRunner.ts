/**
 * The one runner of the MVP (docs/architecture.md §8).
 *
 * `child_process.spawn` with an argv array and never a shell; output consumed as streams and
 * split into lines; timeout and cancellation share one kill path that takes the whole process
 * tree with it, because an installer step that leaves orphans behind is worse than one that
 * fails.
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { readdir, readFile } from 'node:fs/promises';

import { SecretString } from '../engine/secrets.js';
import type { Runner, SpawnOutcome, SpawnRequest } from './base.js';

/** How long a process gets between the polite signal and the firm one (§7). */
const KILL_GRACE_MS = 5000;

/** Polling keeps process-group termination awaitable without blocking the event loop. */
const PROCESS_POLL_MS = 25;

/** Startup failures may contain argv, cwd, or environment values in Node's error text. */
const FAILED_TO_START_MESSAGE = 'process could not be started';

/** Maximum UTF-8 payload retained for one logical stdout/stderr line (§8). */
export const MAX_OUTPUT_LINE_BYTES = 64 * 1024;

/** Value-free replacement for a logical output line that exceeds the payload limit (§8). */
export const OVERSIZED_OUTPUT_LINE_PLACEHOLDER = '[output line omitted: exceeds 64 KiB]';

type TerminationCause = 'timedOut' | 'cancelled';

/** The one place in RUNE a secret is unwrapped (§8): the child needs the value, not `***`. */
function reveal(value: string | SecretString): string {
  return value instanceof SecretString ? value.reveal() : value;
}

/** Batch files need an explicit Windows command interpreter; the runner never adds one. */
export function isUnsupportedBatchExecutable(
  executable: string,
  platform: NodeJS.Platform,
): boolean {
  return platform === 'win32' && /\.(?:bat|cmd)$/i.test(executable);
}

/** Merges spawn environment layers with the host platform's variable-name semantics. */
export function mergeSpawnEnvironment(
  parentEnv: Readonly<Record<string, string | undefined>>,
  commandEnv: Readonly<Record<string, string | undefined>>,
  extraEnv: Readonly<Record<string, string | undefined>>,
  platform: NodeJS.Platform,
): Record<string, string | undefined> {
  const merged: Record<string, string | undefined> = {};

  for (const layer of [parentEnv, commandEnv, extraEnv]) {
    for (const [name, value] of Object.entries(layer)) {
      if (platform === 'win32') {
        const foldedName = name.toUpperCase();
        for (const existingName of Object.keys(merged)) {
          if (existingName.toUpperCase() === foldedName) {
            delete merged[existingName];
          }
        }
      }
      merged[name] = value;
    }
  }

  return merged;
}

export class SpawnRunner implements Runner {
  run(request: SpawnRequest): Promise<SpawnOutcome> {
    return new Promise((resolve) => {
      const { command } = request;
      let child: ReturnType<typeof spawn>;
      try {
        const [executableValue, ...args] = command.argv;
        const executable = reveal(executableValue ?? '');
        if (isUnsupportedBatchExecutable(executable, process.platform)) {
          resolve({ kind: 'failedToStart', message: FAILED_TO_START_MESSAGE });
          return;
        }
        const commandEnv: Record<string, string> = {};
        for (const [name, value] of Object.entries(command.env)) {
          commandEnv[name] = reveal(value);
        }
        const env = mergeSpawnEnvironment(
          process.env,
          commandEnv,
          request.extraEnv,
          process.platform,
        );

        child = spawn(executable, args.map(reveal), {
          cwd: reveal(command.cwd),
          env,
          stdio: ['ignore', 'pipe', 'pipe'],
          shell: false,
          // Its own process group on POSIX, so the kill path can address the whole tree.
          detached: process.platform !== 'win32',
        });
      } catch {
        resolve({ kind: 'failedToStart', message: FAILED_TO_START_MESSAGE });
        return;
      }

      let settled = false;
      let terminationCause: TerminationCause | undefined;
      let terminationTask: Promise<void> | undefined;
      let timeout: NodeJS.Timeout | undefined;
      let unsubscribeCancel = (): void => undefined;
      let childDone = false;
      let closeCode: number | null = null;
      let resolveChildDone = (): void => undefined;
      const childDonePromise = new Promise<void>((resolveDone) => {
        resolveChildDone = resolveDone;
      });

      const completeChild = (code: number | null = null): void => {
        if (childDone) {
          return;
        }
        childDone = true;
        closeCode = code;
        resolveChildDone();
      };

      const clearRunTimeout = (): void => {
        if (timeout !== undefined) {
          clearTimeout(timeout);
          timeout = undefined;
        }
      };

      const settle = (outcome: SpawnOutcome): void => {
        if (settled) {
          return;
        }
        settled = true;
        clearRunTimeout();
        unsubscribeCancel();
        resolve(outcome);
      };

      const requestTermination = (cause: TerminationCause): void => {
        if (settled || terminationCause !== undefined) {
          return;
        }
        terminationCause = cause;
        clearRunTimeout();
        terminationTask = (async () => {
          await terminateTree(child);
          await childDonePromise;
          settle({ kind: cause });
        })();
        // The task is stored to make the single in-flight termination explicit. Its helpers
        // absorb platform process errors and therefore cannot reject.
        void terminationTask;
      };

      child.once('error', () => {
        completeChild();
        if (terminationCause === undefined) {
          settle({ kind: 'failedToStart', message: FAILED_TO_START_MESSAGE });
        }
      });

      forwardLines(child.stdout, (line) => request.onOutput('stdout', line));
      forwardLines(child.stderr, (line) => request.onOutput('stderr', line));

      child.once('close', (code) => {
        completeChild(code);
        if (terminationCause === undefined) {
          settle({ kind: 'exited', exitCode: closeCode ?? 1 });
        }
      });

      if (command.timeoutSeconds !== null) {
        timeout = setTimeout(() => requestTermination('timedOut'), command.timeoutSeconds * 1000);
        timeout.unref();
      }

      unsubscribeCancel = request.cancel.onCancel(() => requestTermination('cancelled'));
    });
  }
}

/** Terminates the platform process tree and resolves only after the kill operation is complete. */
async function terminateTree(child: ChildProcess): Promise<void> {
  const { pid } = child;
  if (pid === undefined) {
    return;
  }
  if (process.platform === 'win32') {
    const killedTree = await runTaskkill(pid);
    if (!killedTree) {
      killDirectChild(child);
    }
    return;
  }
  await terminateProcessGroup(pid);
}

/** Windows has no stdlib Job Objects; taskkill is the documented tree-kill mechanism. */
function runTaskkill(pid: number): Promise<boolean> {
  return new Promise((resolve) => {
    let taskkill: ChildProcess;
    try {
      taskkill = spawn('taskkill', ['/PID', String(pid), '/T', '/F'], {
        stdio: 'ignore',
        shell: false,
      });
    } catch {
      resolve(false);
      return;
    }

    let completed = false;
    const complete = (succeeded: boolean): void => {
      if (completed) {
        return;
      }
      completed = true;
      resolve(succeeded);
    };
    taskkill.once('error', () => complete(false));
    taskkill.once('close', (code) => complete(code === 0));
  });
}

/** Best-effort fallback when Windows cannot start or complete taskkill. */
function killDirectChild(child: ChildProcess): void {
  try {
    child.kill('SIGKILL');
  } catch {
    // The child is already gone.
  }
}

/** SIGTERM the group, give it the documented grace period, then confirm SIGKILL completion. */
async function terminateProcessGroup(pid: number): Promise<void> {
  if (!signalProcessGroup(pid, 'SIGTERM')) {
    return;
  }
  if (await waitForProcessGroupExit(pid, KILL_GRACE_MS)) {
    return;
  }
  signalProcessGroup(pid, 'SIGKILL');
  // There is no later settlement until the firm signal has actually removed the group. This
  // prevents a surviving grandchild and eliminates a delayed signal against a reused PGID.
  await waitForProcessGroupExit(pid);
}

function signalProcessGroup(pid: number, signal: NodeJS.Signals): boolean {
  try {
    process.kill(-pid, signal);
    return true;
  } catch {
    // The group is already gone (or could not be signalled); no delayed signal is retained.
    return false;
  }
}

async function waitForProcessGroupExit(pid: number, timeoutMs?: number): Promise<boolean> {
  const deadline = timeoutMs === undefined ? undefined : Date.now() + timeoutMs;
  while (await processGroupHasLiveMembers(pid)) {
    let waitMs = PROCESS_POLL_MS;
    if (deadline !== undefined) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) {
        return false;
      }
      waitMs = Math.min(PROCESS_POLL_MS, remaining);
    }
    await delay(waitMs);
  }
  return true;
}

async function processGroupHasLiveMembers(pid: number): Promise<boolean> {
  try {
    process.kill(-pid, 0);
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== 'ESRCH';
  }
  if (process.platform !== 'linux') {
    return true;
  }

  // A minimal container without an init process can retain killed orphan descendants as
  // zombies indefinitely. They cannot execute and must not keep a timed-out run open forever.
  // Linux /proc lets us distinguish those from live members of the process group.
  try {
    const entries = await readdir('/proc', { withFileTypes: true });
    const states = await Promise.all(
      entries
        .filter((entry) => entry.isDirectory() && /^\d+$/.test(entry.name))
        .map(async (entry) => {
          try {
            return await readFile(`/proc/${entry.name}/stat`, 'utf8');
          } catch {
            return undefined;
          }
        }),
    );
    return states.some((stat) => stat !== undefined && isLiveGroupMember(stat, pid));
  } catch {
    // A restricted /proc mount cannot provide stronger confirmation; remain conservative.
    return true;
  }
}

function isLiveGroupMember(stat: string, processGroupId: number): boolean {
  const commandEnd = stat.lastIndexOf(')');
  if (commandEnd === -1) {
    return false;
  }
  // Fields after `(comm)` start with state, parent PID and process-group ID.
  const fields = stat.slice(commandEnd + 2).split(' ');
  const state = fields[0];
  const group = Number(fields[2]);
  return group === processGroupId && state !== 'Z' && state !== 'X' && state !== 'x';
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

/**
 * Splits a stream into bounded logical lines without exposing artificial raw fragments.
 * A final CR is held one byte beyond the payload limit until a following LF decides whether it
 * belongs to CRLF framing; every other retained state stays at or below the documented limit.
 *
 * @internal Exported for deterministic stream-framing tests; not part of the package API.
 */
export function forwardLines(
  stream: NodeJS.ReadableStream | null,
  onLine: (line: string) => void,
): void {
  if (stream === null) {
    return;
  }

  let parts: string[] = [];
  let byteLength = 0;
  let endsWithCarriageReturn = false;
  let discarding = false;

  const resetLine = (): void => {
    parts = [];
    byteLength = 0;
    endsWithCarriageReturn = false;
    discarding = false;
  };

  const omitLine = (): void => {
    parts = [];
    byteLength = 0;
    endsWithCarriageReturn = false;
    discarding = true;
    onLine(OVERSIZED_OUTPUT_LINE_PLACEHOLDER);
  };

  const append = (text: string, terminated: boolean): void => {
    if (discarding || text === '') {
      return;
    }

    const nextByteLength = byteLength + Buffer.byteLength(text, 'utf8');
    const nextEndsWithCarriageReturn = text.endsWith('\r');
    const payloadByteLength =
      terminated && nextEndsWithCarriageReturn ? nextByteLength - 1 : nextByteLength;
    const mayBecomeCrLf =
      !terminated && nextByteLength === MAX_OUTPUT_LINE_BYTES + 1 && nextEndsWithCarriageReturn;

    if (payloadByteLength > MAX_OUTPUT_LINE_BYTES && !mayBecomeCrLf) {
      omitLine();
      return;
    }

    parts.push(text);
    byteLength = nextByteLength;
    endsWithCarriageReturn = nextEndsWithCarriageReturn;
  };

  const finishLine = (text: string): void => {
    if (discarding) {
      resetLine();
      return;
    }

    append(text, true);
    if (discarding) {
      resetLine();
      return;
    }

    const line = parts.join('');
    onLine(endsWithCarriageReturn ? line.slice(0, -1) : line);
    resetLine();
  };

  stream.setEncoding('utf8');
  stream.on('data', (chunk: string) => {
    let start = 0;
    let newline = chunk.indexOf('\n');
    while (newline !== -1) {
      finishLine(chunk.slice(start, newline));
      start = newline + 1;
      newline = chunk.indexOf('\n', start);
    }
    append(chunk.slice(start), false);
  });
  stream.on('end', () => {
    if (discarding) {
      return;
    }
    if (byteLength > MAX_OUTPUT_LINE_BYTES) {
      omitLine();
      return;
    }
    if (byteLength !== 0) {
      onLine(parts.join(''));
    }
  });
}
