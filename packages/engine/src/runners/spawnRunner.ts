/**
 * The one runner of the MVP (docs/architecture.md §8).
 *
 * `child_process.spawn` with an argv array and never a shell; output consumed as streams and
 * split into lines; every termination cause shares one kill path for the spawned POSIX process
 * group or Windows task tree, matching the platform contract.
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { readdir, readFile, stat } from 'node:fs/promises';
import { win32 } from 'node:path';

import { isFullyQualifiedWindowsPath } from '../engine/paths.js';
import { isSecretString, revealSecretString, type SecretString } from '../engine/secrets.js';
import type { Runner, SpawnOutcome, SpawnRequest, StartFailureReason } from './base.js';

/** How long a process gets between the polite signal and the firm one (§7). */
const KILL_GRACE_MS = 5000;

/** How long the firm signal gets to produce confirmed process-group removal. */
const KILL_CONFIRMATION_MS = 5000;

/** A child close event must not keep a completed tree-kill operation pending forever. */
const CHILD_CLOSE_TIMEOUT_MS = 5000;

/** A stuck Windows helper must not leave an engine run pending forever. */
const TASKKILL_TIMEOUT_MS = 5000;

/** Polling keeps process-group termination awaitable without blocking the event loop. */
const PROCESS_POLL_MS = 25;

/** Keep Linux process-group probes from flooding the filesystem worker pool. */
const PROC_STAT_READ_WORKERS = 4;

/** Maximum UTF-8 payload retained for one logical stdout/stderr line (§8). */
export const MAX_OUTPUT_LINE_BYTES = 64 * 1024;

/** Value-free replacement for a logical output line that exceeds the payload limit (§8). */
export const OVERSIZED_OUTPUT_LINE_PLACEHOLDER = '[output line omitted: exceeds 64 KiB]';

type TerminationCause =
  | { readonly kind: 'timedOut' }
  | { readonly kind: 'cancelled' }
  | { readonly kind: 'streamFailed'; readonly stream: 'stdout' | 'stderr' };

interface TaskkillProcess {
  readonly once: ChildProcess['once'];
  readonly kill: ChildProcess['kill'];
}

type TaskkillSpawner = typeof spawn;

type ProcessGroupSignalResult = 'sent' | 'absent' | 'failed';

interface ProcessGroupTerminationDependencies {
  readonly signal: (pid: number, signal: NodeJS.Signals) => unknown;
  readonly exists: (pid: number) => boolean;
  readonly probe: (pid: number, signal: AbortSignal) => Promise<boolean>;
  readonly timings: {
    readonly graceMs: number;
    readonly confirmationMs: number;
    readonly pollMs: number;
  };
}

interface ProcProcessGroupProbeDependencies {
  readonly readProcessIds: (signal: AbortSignal) => Promise<readonly string[]>;
  readonly readProcessStat: (processId: string, signal: AbortSignal) => Promise<string>;
}

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
  const merged: Record<string, string | undefined> = Object.create(null);

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
    if (request.cancel.isCancelled) {
      return Promise.resolve({ kind: 'cancelled' });
    }

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
          request.parentEnv,
          commandEnv,
          request.extraEnv,
          process.platform,
        );

        cwd = reveal(command.cwd);
        if (cwd.includes('\0')) {
          resolve({ kind: 'failedToStart', reason: 'invalidCwd' });
          return;
        }
        try {
          child = spawn(executable, args.map(reveal), {
            cwd,
            env,
            stdio: ['ignore', 'pipe', 'pipe'],
            shell: false,
            // A dedicated process group lets the POSIX kill path address that group as a unit.
            detached: process.platform !== 'win32',
          });
        } catch (error) {
          void classifyStartFailure(error, cwd).then((reason) =>
            resolve({ kind: 'failedToStart', reason }),
          );
          return;
        }
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
      let childClosed = false;
      let resolveChildClosed = (): void => undefined;
      const childClosePromise = new Promise<void>((resolveClose) => {
        resolveChildClosed = resolveClose;
      });

      const completeChildClose = (): void => {
        if (childClosed) {
          return;
        }
        childClosed = true;
        resolveChildClosed();
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
          const terminationConfirmed = await terminateTree(child, request.parentEnv);
          if (!childClosed) {
            await waitForCompletion(childClosePromise, CHILD_CLOSE_TIMEOUT_MS);
          }
          settle(terminationConfirmed ? cause : { kind: 'terminationFailed' });
        })();
        // The task is stored to make the single in-flight termination explicit. Its helpers
        // absorb platform process errors and therefore cannot reject.
        void terminationTask;
      };

      child.once('error', (error) => {
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
        completeChildClose();
        if (!startupFailureClaimed && terminationCause === undefined) {
          settle(
            typeof code === 'number' ? { kind: 'exited', exitCode: code } : { kind: 'signalled' },
          );
        }
      });

      if (command.timeoutSeconds !== null) {
        timeout = setTimeout(
          () => requestTermination({ kind: 'timedOut' }),
          command.timeoutSeconds * 1000,
        );
        timeout.unref();
      }

      unsubscribeCancel = request.cancel.onCancel(() => {
        requestTermination({ kind: 'cancelled' });
      });
    });
  }
}

/** ENOENT/ENOTDIR can name the executable path or cwd; inspect only the revealed cwd. */
async function classifyStartFailure(error: unknown, cwd: string): Promise<StartFailureReason> {
  const code = (error as NodeJS.ErrnoException).code;
  if (code !== 'ENOENT' && code !== 'ENOTDIR') {
    return 'other';
  }
  try {
    if (!(await stat(cwd)).isDirectory()) {
      return 'invalidCwd';
    }
    return code === 'ENOENT' ? 'commandNotFound' : 'other';
  } catch {
    return 'invalidCwd';
  }
}

/** Terminates the spawned POSIX process group or Windows task tree, then confirms completion. */
async function terminateTree(
  child: ChildProcess,
  parentEnv: Readonly<Record<string, string | undefined>>,
): Promise<boolean> {
  const { pid } = child;
  if (pid === undefined) {
    return true;
  }

  let confirmed: boolean;
  if (process.platform === 'win32') {
    confirmed = await runTaskkill(pid, parentEnv);
  } else {
    confirmed = await terminateProcessGroup(pid);
  }
  if (!confirmed) {
    killDirectChild(child);
  }
  return confirmed;
}

/** Windows has no stdlib Job Objects; taskkill is the documented tree-kill mechanism. */
function runTaskkill(
  pid: number,
  parentEnv: Readonly<Record<string, string | undefined>>,
  spawnTaskkill: TaskkillSpawner = spawn,
): Promise<boolean> {
  const systemRoot = windowsEnvironmentValue(parentEnv, 'SystemRoot');
  if (systemRoot === undefined || !isFullyQualifiedWindowsPath(systemRoot)) {
    return Promise.resolve(false);
  }

  let taskkill: ChildProcess;
  try {
    taskkill = spawnTaskkill(
      win32.join(systemRoot, 'System32', 'taskkill.exe'),
      ['/PID', String(pid), '/T', '/F'],
      {
        env: parentEnv,
        stdio: 'ignore',
        shell: false,
      },
    );
  } catch {
    return Promise.resolve(false);
  }

  return waitForTaskkill(taskkill);
}

function windowsEnvironmentValue(
  environment: Readonly<Record<string, string | undefined>>,
  name: string,
): string | undefined {
  const foldedName = name.toUpperCase();
  for (const [candidate, value] of Object.entries(environment)) {
    if (candidate.toUpperCase() === foldedName) {
      return value;
    }
  }
  return undefined;
}

/** @internal Waits for the Windows tree-kill helper without trusting it to terminate. */
export function waitForTaskkill(
  taskkill: TaskkillProcess,
  timeoutMs = TASKKILL_TIMEOUT_MS,
): Promise<boolean> {
  return new Promise((resolve) => {
    let completed = false;
    let watchdog: NodeJS.Timeout | undefined;
    const complete = (succeeded: boolean): void => {
      if (completed) {
        return;
      }
      completed = true;
      if (watchdog !== undefined) {
        clearTimeout(watchdog);
        watchdog = undefined;
      }
      resolve(succeeded);
    };
    taskkill.once('error', () => complete(false));
    taskkill.once('close', (code) => complete(code === 0));

    watchdog = setTimeout(() => {
      try {
        taskkill.kill('SIGKILL');
      } catch {
        // Completion below still releases the engine when the helper refuses its own kill.
      }
      complete(false);
    }, timeoutMs);
  });
}

/** Best-effort fallback when tree termination cannot be confirmed. */
function killDirectChild(child: ChildProcess): void {
  if (child.pid === undefined || child.exitCode !== null || child.signalCode !== null) {
    return;
  }
  try {
    child.kill('SIGKILL');
  } catch {
    // The unconfirmed result remains authoritative regardless of direct-child kill failure.
  }
}

/** SIGTERM the group, give it the documented grace period, then confirm SIGKILL completion. */
async function terminateProcessGroup(
  pid: number,
  dependencies: ProcessGroupTerminationDependencies = {
    signal: (processId, signal) => process.kill(processId, signal),
    exists: processGroupExists,
    probe: processGroupHasLiveMembers,
    timings: {
      graceMs: KILL_GRACE_MS,
      confirmationMs: KILL_CONFIRMATION_MS,
      pollMs: PROCESS_POLL_MS,
    },
  },
): Promise<boolean> {
  const politeSignal = signalProcessGroup(pid, 'SIGTERM', dependencies.signal);
  if (politeSignal === 'absent') {
    return true;
  }
  if (politeSignal === 'failed') {
    return false;
  }
  if (
    await waitForProcessGroupExit(
      pid,
      dependencies.timings.graceMs,
      dependencies.timings.pollMs,
      async (processId, signal) => {
        signal.throwIfAborted();
        return dependencies.exists(processId);
      },
    )
  ) {
    return true;
  }

  const firmSignal = signalProcessGroup(pid, 'SIGKILL', dependencies.signal);
  if (firmSignal === 'absent') {
    return true;
  }
  if (firmSignal === 'failed') {
    return false;
  }
  return waitForProcessGroupExit(
    pid,
    dependencies.timings.confirmationMs,
    dependencies.timings.pollMs,
    dependencies.probe,
  );
}

/** Before SIGKILL, only kernel-confirmed group absence can safely end the grace phase. */
function processGroupExists(pid: number): boolean {
  try {
    process.kill(-pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== 'ESRCH';
  }
}

function signalProcessGroup(
  pid: number,
  signal: NodeJS.Signals,
  sendSignal: (pid: number, signal: NodeJS.Signals) => unknown,
): ProcessGroupSignalResult {
  try {
    sendSignal(-pid, signal);
    return 'sent';
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ESRCH' ? 'absent' : 'failed';
  }
}

function waitForProcessGroupExit(
  pid: number,
  timeoutMs: number,
  pollMs: number,
  probe: (pid: number, signal: AbortSignal) => Promise<boolean>,
): Promise<boolean> {
  return new Promise((resolve) => {
    const probeController = new AbortController();
    let completed = false;
    let watchdog: NodeJS.Timeout | undefined;
    let poll: NodeJS.Timeout | undefined;

    const complete = (gone: boolean): void => {
      if (completed) {
        return;
      }
      completed = true;
      if (watchdog !== undefined) {
        clearTimeout(watchdog);
        watchdog = undefined;
      }
      if (poll !== undefined) {
        clearTimeout(poll);
        poll = undefined;
      }
      probeController.abort();
      resolve(gone);
    };

    const runProbe = (): void => {
      void Promise.resolve()
        .then(() => probe(pid, probeController.signal))
        .then(
          (hasLiveMembers) => {
            if (completed) {
              return;
            }
            if (!hasLiveMembers) {
              complete(true);
              return;
            }
            poll = setTimeout(runProbe, pollMs);
          },
          () => {
            if (!completed) {
              // An unclear probe failure is conservative: the group may still be live.
              poll = setTimeout(runProbe, pollMs);
            }
          },
        );
    };

    // This is installed before the first probe so even a probe Promise that never settles is
    // bounded. Completion clears both this watchdog and any pending poll.
    watchdog = setTimeout(() => complete(false), timeoutMs);
    runProbe();
  });
}

async function processGroupHasLiveMembers(pid: number, signal: AbortSignal): Promise<boolean> {
  signal.throwIfAborted();
  if (!processGroupExists(pid)) {
    return false;
  }
  if (process.platform !== 'linux') {
    return true;
  }

  // A minimal container without an init process can retain killed orphan descendants as
  // zombies indefinitely. They cannot execute and must not keep a timed-out run open forever.
  // Linux /proc lets us distinguish those from live members of the process group.
  try {
    return await scanProcProcessGroup(pid, signal);
  } catch {
    signal.throwIfAborted();
    // A restricted /proc mount cannot provide stronger confirmation; remain conservative.
    return true;
  }
}

async function scanProcProcessGroup(
  processGroupId: number,
  signal: AbortSignal,
  dependencies: ProcProcessGroupProbeDependencies = {
    readProcessIds: async (readSignal) => {
      readSignal.throwIfAborted();
      const entries = await readdir('/proc', { withFileTypes: true });
      readSignal.throwIfAborted();
      return entries
        .filter((entry) => entry.isDirectory() && /^\d+$/.test(entry.name))
        .map((entry) => entry.name);
    },
    readProcessStat: (processId, readSignal) =>
      readFile(`/proc/${processId}/stat`, { encoding: 'utf8', signal: readSignal }),
  },
): Promise<boolean> {
  signal.throwIfAborted();
  const processIds = await dependencies.readProcessIds(signal);
  signal.throwIfAborted();

  const shortCircuitController = new AbortController();
  const readSignal = AbortSignal.any([signal, shortCircuitController.signal]);
  let nextIndex = 0;
  let hasLiveMembers = false;

  const shortCircuit = (): void => {
    if (hasLiveMembers) {
      return;
    }
    hasLiveMembers = true;
    shortCircuitController.abort();
  };

  const readWorker = async (): Promise<void> => {
    while (!hasLiveMembers) {
      readSignal.throwIfAborted();
      const index = nextIndex;
      nextIndex += 1;
      const processId = processIds[index];
      if (processId === undefined) {
        return;
      }

      try {
        const processStat = await dependencies.readProcessStat(processId, readSignal);
        if (isLiveGroupMember(processStat, processGroupId)) {
          shortCircuit();
        }
      } catch (error) {
        if (readSignal.aborted) {
          signal.throwIfAborted();
          return;
        }
        const code = (error as NodeJS.ErrnoException).code;
        if (code !== 'ENOENT' && code !== 'ESRCH') {
          shortCircuit();
        }
      }
    }
  };

  const workerCount = Math.min(PROC_STAT_READ_WORKERS, processIds.length);
  await Promise.all(Array.from({ length: workerCount }, () => readWorker()));
  signal.throwIfAborted();
  return hasLiveMembers;
}

function isLiveGroupMember(stat: string, processGroupId: number): boolean {
  const commandEnd = stat.lastIndexOf(')');
  if (commandEnd === -1) {
    return true;
  }
  // Fields after `(comm)` start with state, parent PID and process-group ID.
  const fields = stat.slice(commandEnd + 2).split(' ');
  const state = fields[0];
  const group = Number(fields[2]);
  if (state === undefined || !Number.isSafeInteger(group)) {
    return true;
  }
  return group === processGroupId && state !== 'Z' && state !== 'X' && state !== 'x';
}

function waitForCompletion(completion: Promise<void>, timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    let completed = false;
    let watchdog: NodeJS.Timeout | undefined;
    const complete = (finished: boolean): void => {
      if (completed) {
        return;
      }
      completed = true;
      if (watchdog !== undefined) {
        clearTimeout(watchdog);
        watchdog = undefined;
      }
      resolve(finished);
    };

    watchdog = setTimeout(() => complete(false), timeoutMs);
    completion.then(
      () => complete(true),
      () => complete(true),
    );
  });
}

/**
 * @internal Narrow deterministic seam for the production POSIX state machine and completion
 * watchdog. It is intentionally not exported from the package root.
 */
export const spawnRunnerTestSeam = Object.freeze({
  runTaskkill,
  scanProcProcessGroup,
  terminateProcessGroup,
  waitForCompletion,
});

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
