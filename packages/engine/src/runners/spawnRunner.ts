/**
 * The one runner of the MVP (docs/architecture.md §8).
 *
 * `child_process.spawn` with an argv array and never a shell; output consumed as streams and
 * split into lines; timeout and cancellation share one kill path that takes the whole process
 * tree with it, because an installer step that leaves orphans behind is worse than one that
 * fails.
 */

import { spawn } from 'node:child_process';

import { SecretString } from '../engine/secrets.js';
import type { Runner, SpawnOutcome, SpawnRequest } from './base.js';

/** How long a process gets between the polite signal and the firm one (§7). */
const KILL_GRACE_MS = 5000;

/** The one place in RUNE a secret is unwrapped (§8): the child needs the value, not `***`. */
function reveal(value: string | SecretString): string {
  return value instanceof SecretString ? value.reveal() : value;
}

export class SpawnRunner implements Runner {
  run(request: SpawnRequest): Promise<SpawnOutcome> {
    return new Promise((resolve) => {
      const { command } = request;
      const [executable, ...args] = command.argv;
      const env: Record<string, string | undefined> = { ...process.env };
      for (const [name, value] of Object.entries(command.env)) {
        env[name] = reveal(value);
      }

      const child = spawn(reveal(executable ?? ''), args.map(reveal), {
        cwd: reveal(command.cwd),
        env: { ...env, ...request.extraEnv },
        stdio: ['ignore', 'pipe', 'pipe'],
        shell: false,
        // Its own process group on POSIX, so the kill path can address the whole tree.
        detached: process.platform !== 'win32',
      });

      let settled = false;
      let timedOut = false;
      let cancelled = false;
      let timer: NodeJS.Timeout | undefined;

      const settle = (outcome: SpawnOutcome): void => {
        if (settled) {
          return;
        }
        settled = true;
        if (timer !== undefined) {
          clearTimeout(timer);
        }
        resolve(outcome);
      };

      const killTree = (): void => {
        if (child.pid === undefined) {
          return;
        }
        if (process.platform === 'win32') {
          // Node has no Job Objects; taskkill's tree kill is the standard (§7).
          spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], {
            stdio: 'ignore',
            shell: false,
          });
          return;
        }
        try {
          process.kill(-child.pid, 'SIGTERM');
        } catch {
          // The group is already gone; nothing left to stop.
          return;
        }
        const escalate = setTimeout(() => {
          try {
            process.kill(-(child.pid as number), 'SIGKILL');
          } catch {
            // Terminated within the grace period.
          }
        }, KILL_GRACE_MS);
        escalate.unref();
      };

      child.on('error', (cause) => {
        settle({ kind: 'failedToStart', message: cause.message });
      });

      forwardLines(child.stdout, (line) => request.onOutput('stdout', line));
      forwardLines(child.stderr, (line) => request.onOutput('stderr', line));

      if (command.timeoutSeconds !== null) {
        timer = setTimeout(() => {
          timedOut = true;
          killTree();
        }, command.timeoutSeconds * 1000);
        timer.unref();
      }

      request.cancel.onCancel(() => {
        if (!settled) {
          cancelled = true;
          killTree();
        }
      });

      child.on('close', (code) => {
        if (cancelled) {
          settle({ kind: 'cancelled' });
        } else if (timedOut) {
          settle({ kind: 'timedOut' });
        } else {
          settle({ kind: 'exited', exitCode: code ?? 1 });
        }
      });
    });
  }
}

/** Splits a stream into lines as it arrives; a last unterminated line is flushed at the end. */
function forwardLines(stream: NodeJS.ReadableStream | null, onLine: (line: string) => void): void {
  if (stream === null) {
    return;
  }
  let rest = '';
  stream.setEncoding('utf8');
  stream.on('data', (chunk: string) => {
    const lines = (rest + chunk).split('\n');
    rest = lines.pop() ?? '';
    for (const line of lines) {
      onLine(line.endsWith('\r') ? line.slice(0, -1) : line);
    }
  });
  stream.on('end', () => {
    if (rest !== '') {
      onLine(rest);
    }
  });
}
