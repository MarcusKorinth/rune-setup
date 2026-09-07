import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { Duplex } from 'node:stream';
import { fileURLToPath } from 'node:url';

import { expect, test } from '@playwright/test';

const packageDirectory = dirname(dirname(fileURLToPath(import.meta.url)));
const launcherPath = join(packageDirectory, 'tests', 'fixtures', 'launch.cjs');
const electronExecutable = createRequire(join(packageDirectory, 'package.json'))(
  'electron',
) as string;
const token = '0123456789abcdef0123456789abcdef';

interface StartupRun {
  child: ChildProcess;
  channel: Duplex;
  ready: Promise<string>;
  exit: Promise<number>;
  resultPath: string;
  markerPath: string;
  stdout(): string;
  stderr(): string;
}

async function launch(directory: string, headless = true): Promise<StartupRun> {
  const manifestPath = join(directory, 'installer.yaml');
  const scriptPath = join(directory, 'step.mjs');
  const markerPath = join(directory, 'executed.json');
  const resultPath = join(directory, 'result.json');
  await writeFile(
    scriptPath,
    [
      "import { writeFileSync } from 'node:fs';",
      'writeFileSync(process.argv[2], JSON.stringify({',
      "  privateTokenPresent: Object.hasOwn(process.env, 'RUNE_GUI_STARTUP_TOKEN'),",
      '}));',
    ].join('\n'),
  );
  await writeFile(
    manifestPath,
    [
      'schemaVersion: 1',
      'product: { name: Startup handshake, version: 1.0.0 }',
      'inputs: {}',
      'steps:',
      '  - id: marker',
      '    run:',
      `      command: ${JSON.stringify(process.execPath)}`,
      `      args: [${JSON.stringify(scriptPath)}, ${JSON.stringify(markerPath)}]`,
      '',
    ].join('\n'),
  );
  const child = spawn(
    electronExecutable,
    [
      '--no-sandbox',
      launcherPath,
      '--',
      manifestPath,
      ...(headless ? ['--non-interactive'] : []),
      '--result',
      resultPath,
    ],
    {
      env: { ...process.env, ELECTRON_RUN_AS_NODE: undefined, RUNE_GUI_STARTUP_TOKEN: token },
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe', 'pipe'],
      shell: false,
    },
  );
  const channel = child.stdio[3];
  if (!(channel instanceof Duplex)) throw new Error('the shell startup pipe is not duplex');
  let stdout = '';
  let stderr = '';
  child.stdout?.setEncoding('utf8').on('data', (text: string) => {
    stdout += text;
  });
  child.stderr?.setEncoding('utf8').on('data', (text: string) => {
    stderr += text;
  });
  const ready = new Promise<string>((resolve, reject) => {
    let frame = '';
    channel.setEncoding('utf8');
    channel.on('data', (text: string) => {
      frame += text;
      if (frame.length > 128) reject(new Error('the shell startup frame exceeded its limit'));
      else if (frame.includes('\n')) resolve(frame);
    });
    channel.once('error', reject);
    channel.once('close', () => reject(new Error('the shell closed before READY')));
  });
  const exit = new Promise<number>((resolve, reject) => {
    const timeout = setTimeout(() => {
      stop(child);
      reject(new Error('the shell startup smoke did not terminate within 25 seconds'));
    }, 25_000);
    child.once('error', (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.once('close', (code, signal) => {
      clearTimeout(timeout);
      if (signal !== null) reject(new Error(`the shell ended from ${signal}`));
      else resolve(code ?? 70);
    });
  });
  void ready.catch(() => undefined);
  void exit.catch(() => undefined);
  return {
    child,
    channel,
    ready,
    exit,
    resultPath,
    markerPath,
    stdout: () => stdout,
    stderr: () => stderr,
  };
}

function stop(child: ChildProcess): void {
  if (child.exitCode !== null || child.signalCode !== null || child.pid === undefined) return;
  try {
    process.kill(-child.pid, 'SIGKILL');
  } catch {
    // The dedicated process group may already have exited.
  }
}

async function cleanup(run: StartupRun | undefined, directory: string): Promise<void> {
  if (run !== undefined) {
    stop(run.child);
    await run.exit.catch(() => undefined);
    run.channel.destroy();
  }
  await rm(directory, { force: true, recursive: true });
}

test.describe('the real Linux shell startup pipe', () => {
  test.skip(process.platform !== 'linux', 'the private fd3 launcher protocol is Linux-only');

  for (const { decision, headless } of [
    { decision: 'START', headless: true },
    { decision: 'CANCEL', headless: true },
    { decision: 'CANCEL', headless: false },
  ] as const) {
    test(`accepts ${decision} after READY (headless=${headless}) without exposing its token`, async () => {
      const directory = await mkdtemp(join(tmpdir(), 'rune-startup-handshake-'));
      let run: StartupRun | undefined;
      try {
        run = await launch(directory, headless);
        expect(await run.ready).toBe(`READY ${token}\n`);
        expect(existsSync(run.resultPath)).toBe(false);
        expect(existsSync(run.markerPath)).toBe(false);
        run.channel.end(`${decision} ${token}\n`);

        expect(await run.exit, run.stderr()).toBe(decision === 'START' ? 0 : 6);
        expect(JSON.parse(await readFile(run.resultPath, 'utf8'))).toMatchObject({
          status: decision === 'START' ? 'succeeded' : 'cancelled',
          mode: headless ? 'non-interactive' : 'gui',
          stepsExecuted: decision === 'START' ? 1 : 0,
        });
        if (decision === 'START') {
          expect(JSON.parse(await readFile(run.markerPath, 'utf8'))).toEqual({
            privateTokenPresent: false,
          });
        } else {
          expect(existsSync(run.markerPath)).toBe(false);
        }
        expect(run.stdout()).toBe('');
        expect(run.stderr()).not.toContain(token);
      } finally {
        await cleanup(run, directory);
      }
    });
  }

  for (const phase of ['before READY', 'after READY'] as const) {
    test(`exits without a Session result when the launcher disappears ${phase}`, async () => {
      const directory = await mkdtemp(join(tmpdir(), 'rune-startup-disconnect-'));
      let run: StartupRun | undefined;
      try {
        run = await launch(directory);
        if (phase === 'after READY') expect(await run.ready).toBe(`READY ${token}\n`);
        run.channel.destroy();

        expect(await run.exit).toBe(70);
        expect(existsSync(run.resultPath)).toBe(false);
        expect(existsSync(run.markerPath)).toBe(false);
        expect(run.stdout()).toBe('');
        expect(run.stderr()).not.toContain(token);
      } finally {
        await cleanup(run, directory);
      }
    });
  }
});
