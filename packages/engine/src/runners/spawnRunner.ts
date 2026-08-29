/**
 * The one runner of the MVP (docs/architecture.md §8).
 *
 * `child_process.spawn` with an argv array and never a shell; output consumed as streams and
 * split into lines; timeout and cancellation share one kill path that takes the whole process
 * tree with it, because an installer step that leaves orphans behind is worse than one that
 * fails.
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { readdir, readFile, stat } from 'node:fs/promises';

import { isSecretString, revealSecretString, type SecretString } from '../engine/secrets.js';
import type { Runner, SpawnOutcome, SpawnRequest, StartFailureReason } from './base.js';

/** How long a process gets between the polite signal and the firm one (§7). */
const KILL_GRACE_MS = 5000;

/** Polling keeps process-group termination awaitable without blocking the event loop. */
const PROCESS_POLL_MS = 25;

/** Maximum UTF-8 payload retained for one logical stdout/stderr line (§8). */
export const MAX_OUTPUT_LINE_BYTES = 64 * 1024;

/** Value-free replacement for a logical output line that exceeds the payload limit (§8). */
export const OVERSIZED_OUTPUT_LINE_PLACEHOLDER = '[output line omitted: exceeds 64 KiB]';

type TerminationCause =
  | { readonly kind: 'timedOut' }
  | { readonly kind: 'cancelled' }
  | { readonly kind: 'streamFailed'; readonly stream: 'stdout' | 'stderr' };

/** The one place in RUNE a secret is unwrapped (§8): the child needs the value, not `***`. */
function reveal(value: string | SecretString): string {
  return isSecretString(value) ? revealSecretString(value) : value;
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
      let cwd: string;
      try {
        const [executableValue, ...args] = command.argv;
        const executable = reveal(executableValue ?? '');
        if (isUnsupportedBatchExecutable(executable, process.platform)) {
          resolve({ kind: 'failedToStart', reason: 'shellRequired' });
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

        cwd = reveal(command.cwd);
        child = spawn(executable, args.map(reveal), {
          cwd,
          env,
          stdio: ['ignore', 'pipe', 'pipe'],
          shell: false,
          // Its own process group on POSIX, so the kill path can address the whole tree.
          detached: process.platform !== 'win32',
        });
      } catch {
        resolve({ kind: 'failedToStart', reason: 'other' });
        return;
      }

      let settled = false;
      let startupFailureClaimed = false;
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
        if (settled || startupFailureClaimed || terminationCause !== undefined) {
          return;
        }
        terminationCause = cause;
        clearRunTimeout();
        terminationTask = (async () => {
          await terminateTree(child);
          await childDonePromise;
          settle(cause);
        })();
        // The task is stored to make the single in-flight termination explicit. Its helpers
        // absorb platform process errors and therefore cannot reject.
        void terminationTask;
      };

      child.once('error', (error) => {
        completeChild();
        if (settled || startupFailureClaimed || terminationCause !== undefined) {
          return;
        }
        // Claim the startup failure synchronously. `stat()` is asynchronous, so close,
        // cancellation, or timeout must not settle the run while classification is pending.
        startupFailureClaimed = true;
        clearRunTimeout();
        unsubscribeCancel();
        void classifyStartFailure(error, cwd).then((reason) =>
          settle({ kind: 'failedToStart', reason }),
        );
      });

      forwardLines(
        child.stdout,
        (line) => request.onOutput('stdout', line),
        () => requestTermination({ kind: 'streamFailed', stream: 'stdout' }),
      );
      forwardLines(
        child.stderr,
        (line) => request.onOutput('stderr', line),
        () => requestTermination({ kind: 'streamFailed', stream: 'stderr' }),
      );

      child.once('close', (code) => {
        completeChild(code);
        if (!startupFailureClaimed && terminationCause === undefined) {
          settle({ kind: 'exited', exitCode: closeCode ?? 1 });
        }
      });

      if (command.timeoutSeconds !== null) {
        timeout = setTimeout(
          () => requestTermination({ kind: 'timedOut' }),
          command.timeoutSeconds * 1000,
        );
        timeout.unref();
      }

      unsubscribeCancel = request.cancel.onCancel(() => requestTermination({ kind: 'cancelled' }));
    });
  }
}

/** ENOENT names both a missing executable and a bad cwd; inspect only the already-revealed cwd. */
async function classifyStartFailure(error: Error, cwd: string): Promise<StartFailureReason> {
  if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
    return 'other';
  }
  try {
    return (await stat(cwd)).isDirectory() ? 'commandNotFound' : 'invalidCwd';
  } catch {
    return 'invalidCwd';
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
  onError: () => void,
): void {
  if (stream === null) {
    return;
  }

  let parts: string[] = [];
  let byteLength = 0;
  let endsWithCarriageReturn = false;
  let discarding = false;
  let failed = false;

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

  // Keep one listener installed after the first error so a broken stream cannot emit a later
  // unhandled `error`. The callback is deliberately value-free and runs at most once.
  stream.on('error', () => {
    if (failed) {
      return;
    }
    failed = true;
    onError();
  });
  stream.setEncoding('utf8');
  stream.on('data', (chunk: string) => {
    if (failed) {
      return;
    }
    let start = 0;
    let newline = chunk.indexOf('\n');
    while (newline !== -1) {
      finishLine(chunk.slice(start, newline));
      if (failed) {
        return;
      }
      start = newline + 1;
      newline = chunk.indexOf('\n', start);
    }
    append(chunk.slice(start), false);
  });
  stream.on('end', () => {
    if (failed || discarding) {
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
