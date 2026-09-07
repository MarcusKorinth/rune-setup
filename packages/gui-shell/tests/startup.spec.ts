import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

import { expect, test } from '@playwright/test';

const packageDirectory = dirname(dirname(fileURLToPath(import.meta.url)));
const fixture = join(packageDirectory, 'tests', 'fixtures', 'cli-shell');
const electron = createRequire(join(packageDirectory, 'package.json'))('electron') as string;

test.skip(process.platform !== 'linux', 'the private startup channel is Linux-specific');

async function alive(pid: number): Promise<boolean> {
  try {
    process.kill(pid, 0);
    const stat = await readFile(`/proc/${pid}/stat`, 'utf8');
    return stat.slice(stat.lastIndexOf(')') + 2, stat.lastIndexOf(')') + 3) !== 'Z';
  } catch {
    return false;
  }
}

interface StartupRun {
  readonly child: ChildProcess;
  readonly exited: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
  readonly closed: Promise<void>;
  readonly stderr: () => string;
}

function launch(directory: string): StartupRun {
  const child = spawn(
    process.execPath,
    [
      join(packageDirectory, '..', 'cli', 'dist', 'main.js'),
      'run',
      join(fixture, 'failure.yaml'),
      '--gui',
      '--result',
      join(directory, 'result.json'),
    ],
    {
      cwd: packageDirectory,
      env: {
        ...process.env,
        RUNE_GUI_SHELL: join(fixture, 'launch-linux.sh'),
        RUNE_TEST_ELECTRON: electron,
        RUNE_TEST_SHELL: fixture,
        RUNE_TEST_USER_DATA: join(directory, 'user-data'),
        RUNE_TEST_STARTUP_GATE: join(directory, 'gate'),
      },
      stdio: ['ignore', 'ignore', 'pipe'],
      shell: false,
    },
  );
  let stderr = '';
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk: string) => {
    stderr = (stderr + chunk).slice(-8192);
  });
  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
    (resolve, reject) => {
      child.once('error', reject);
      child.once('exit', (code, signal) => resolve({ code, signal }));
    },
  );
  const closed = new Promise<void>((resolve) => child.once('close', () => resolve()));
  void exited.catch(() => undefined);
  return { child, exited, closed, stderr: () => stderr };
}

for (const forced of [false, true]) {
  test(
    forced
      ? 'a second CLI interrupt before shell readiness cannot start an orphaned workflow'
      : 'CLI cancellation before shell readiness produces the shell cancellation result',
    async () => {
      const directory = await mkdtemp(join(tmpdir(), 'rune-cli-startup-'));
      const run = launch(directory);
      let shellPid: number | undefined;
      try {
        await expect
          .poll(
            async () => {
              const marker = await readFile(join(directory, 'gate.started'), 'utf8').catch(
                () => undefined,
              );
              shellPid = marker === undefined ? undefined : Number(marker);
              return shellPid;
            },
            { timeout: 15_000, message: 'the actual workflow shell must reach the pre-ready gate' },
          )
          .toBeGreaterThan(0);

        expect(run.child.kill(forced ? 'SIGINT' : 'SIGTERM')).toBe(true);
        // Keep the real shell in its unprotected startup window while the parent handles cancellation.
        await delay(150);
        expect(await alive(shellPid!)).toBe(true);
        expect(run.child.exitCode).toBeNull();
        if (forced) {
          expect(run.child.kill('SIGINT')).toBe(true);
          await expect(run.exited).resolves.toEqual({ code: 6, signal: null });
        }
        await writeFile(join(directory, 'gate.release'), 'continue');

        if (forced) {
          await expect.poll(() => alive(shellPid!), { timeout: 10_000 }).toBe(false);
          await expect(readFile(join(directory, 'result.json'))).rejects.toMatchObject({
            code: 'ENOENT',
          });
        } else {
          const exit = await run.exited;
          expect(exit, run.stderr()).toEqual({ code: 6, signal: null });
          const result: unknown = JSON.parse(
            await readFile(join(directory, 'result.json'), 'utf8'),
          );
          expect(result).toMatchObject({
            mode: 'gui',
            status: 'cancelled',
            exitCode: 6,
            steps: [{ id: 'cli-shell-failure', state: 'NOT_RUN', exitCode: null }],
          });
        }
      } finally {
        if (run.child.exitCode === null) run.child.kill('SIGKILL');
        if (shellPid !== undefined && (await alive(shellPid))) {
          try {
            process.kill(-shellPid, 'SIGKILL');
          } catch {
            // The fixture group may already have exited after its startup pipe closed.
          }
        }
        await run.exited.catch(() => undefined);
        await run.closed;
        await rm(directory, { recursive: true, force: true });
      }
    },
  );
}
