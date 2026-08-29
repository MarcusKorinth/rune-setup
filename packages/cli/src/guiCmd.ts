/**
 * The GUI shell from the CLI's side (docs/architecture.md §9.4): `rune gui install`
 * fetches the prebuilt shell into the per-user cache, and `rune run --gui` launches it
 * with the run's invocation and forwards its exit code — the shell hosts the engine, the
 * CLI only waits.
 */

import { spawn } from 'node:child_process';
import { createWriteStream, existsSync, mkdirSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

import { RUNE_VERSION, UsageError } from '@rune/engine';

import type { RunFlags } from './args.js';
import { ExitWithCode, type CliIo } from './io.js';
import type { Interaction } from './prompt.js';

/** GitHub coordinates of the shell releases — one release per engine version (§9.4). */
const RELEASES = 'https://github.com/MarcusKorinth/rune-setup/releases/download';

const SHELL_BINARY = process.platform === 'win32' ? 'rune-gui-shell.exe' : 'rune-gui-shell';

/** The §10 table: only these codes are forwarded; anything else is an internal error. */
const FORWARDABLE = new Set([0, 1, 2, 3, 4, 5, 6, 70]);

/** The per-user cache, keyed by engine version so parity stays real (§9.4). */
export function shellCacheDir(engineVersion: string = RUNE_VERSION): string {
  const base =
    process.platform === 'win32'
      ? (process.env['LOCALAPPDATA'] ?? join(homedir(), 'AppData', 'Local'))
      : (process.env['XDG_CACHE_HOME'] ?? join(homedir(), '.cache'));
  return join(base, 'rune', 'gui-shell', engineVersion);
}

type ShellLocation =
  | { readonly kind: 'binary'; readonly path: string }
  | { readonly kind: 'dev'; readonly dir: string };

/**
 * Where the shell lives: the RUNE_GUI_SHELL override (a packaged binary, or a shell
 * package directory for development), else the per-user cache.
 */
export function locateShell(
  environment: Readonly<Record<string, string | undefined>> = process.env,
): ShellLocation | undefined {
  const override = environment['RUNE_GUI_SHELL'];
  if (override !== undefined && override !== '') {
    return statSync(override, { throwIfNoEntry: false })?.isDirectory() === true
      ? { kind: 'dev', dir: override }
      : { kind: 'binary', path: override };
  }
  const cached = join(shellCacheDir(), SHELL_BINARY);
  return existsSync(cached) ? { kind: 'binary', path: cached } : undefined;
}

/** `rune gui install`: fetch the release matching this engine version, unpack via OS tar. */
export async function guiInstallCommand(io: CliIo): Promise<void> {
  const archiveName =
    process.platform === 'win32' ? `rune-gui-shell-windows.zip` : `rune-gui-shell-linux.tar.gz`;
  const url = `${RELEASES}/v${RUNE_VERSION}/${archiveName}`;
  const target = shellCacheDir();

  io.stderr(`fetching ${url}`);
  const response = await fetch(url);
  if (!response.ok || response.body === null) {
    io.stderr(
      `no shell release for engine ${RUNE_VERSION} (${response.status} ${response.statusText})`,
    );
    throw new ExitWithCode(1);
  }
  const archive = join(tmpdir(), `rune-shell-${process.pid}-${archiveName}`);
  await pipeline(Readable.fromWeb(response.body), createWriteStream(archive));

  mkdirSync(target, { recursive: true });
  // bsdtar ships with Windows 10+ and handles both formats; argv only, never a shell (§12).
  const code = await new Promise<number>((resolve) => {
    const child = spawn('tar', ['-xf', archive, '-C', target], {
      stdio: ['ignore', 'ignore', 'inherit'],
      shell: false,
    });
    child.on('error', () => resolve(70));
    child.on('close', (exit) => resolve(exit ?? 70));
  });
  if (code !== 0) {
    io.stderr(`unpacking ${archive} failed (tar exit ${code})`);
    throw new ExitWithCode(1);
  }
  io.stderr(`GUI shell ${RUNE_VERSION} installed to ${target}`);
}

/** `rune run --gui`: launch the shell with the invocation, forward its exit code (§9.4). */
export async function launchGui(
  manifestPath: string,
  flags: RunFlags,
  io: CliIo,
  interaction: Interaction,
): Promise<void> {
  const location = locateShell();
  if (location === undefined) {
    throw new UsageError(
      'the GUI shell is not installed for this engine version — run: rune gui install',
    );
  }

  const argv: string[] = [manifestPath];
  for (const pair of flags.set ?? []) {
    argv.push('--set', pair);
  }
  for (const file of flags.values ?? []) {
    argv.push('--values', file);
  }
  if (flags.locale !== undefined) {
    argv.push('--locale', flags.locale);
  }
  if (flags.result !== undefined) {
    argv.push('--result', flags.result);
  }
  if (flags.logFile !== undefined) {
    argv.push('--log-file', flags.logFile);
  }

  const [command, args] =
    location.kind === 'binary'
      ? [location.path, argv]
      : [devElectron(location.dir), [location.dir, ...argv]];

  const child = spawn(command, args, {
    stdio: ['ignore', 'ignore', 'inherit'],
    shell: false,
    // Its own process group on POSIX: a terminal Ctrl+C must reach only the CLI, which
    // forwards a deliberate SIGTERM — a raw SIGINT would kill the shell past its cancel
    // path (§9.4). Same reason the engine's runner detaches its children.
    detached: process.platform !== 'win32',
  });

  // The first Ctrl+C forwards a cancel request to the shell (§9.4); a second force-exits
  // the CLI while the shell finishes its own cancel.
  let requested = false;
  const onSigint = (): void => {
    if (requested) {
      interaction.forceExit(6);
      return;
    }
    requested = true;
    if (child.pid !== undefined) {
      if (process.platform === 'win32') {
        // A close request, not a kill: no /F (§9.4).
        spawn('taskkill', ['/PID', String(child.pid)], { stdio: 'ignore', shell: false });
      } else {
        child.kill('SIGTERM');
      }
    }
  };
  process.on('SIGINT', onSigint);

  const outcome = await new Promise<{ code: number | null; failed: boolean }>((resolve) => {
    child.on('error', (cause) => {
      io.stderr(`could not launch the GUI shell: ${cause.message}`);
      resolve({ code: null, failed: true });
    });
    child.on('close', (code) => resolve({ code, failed: false }));
  }).finally(() => process.removeListener('SIGINT', onSigint));

  // Signal death or an unknown (e.g. Chromium crash) code is an internal error (§9.4).
  const exit =
    !outcome.failed && outcome.code !== null && FORWARDABLE.has(outcome.code) ? outcome.code : 70;
  if (exit !== 0) {
    throw new ExitWithCode(exit);
  }
}

/** Development launch: the electron binary resolved from the shell package's own tree. */
function devElectron(shellDir: string): string {
  const resolve = createRequire(join(shellDir, 'package.json'));
  // The electron npm package's export IS the path to the binary.
  return resolve('electron') as string;
}
