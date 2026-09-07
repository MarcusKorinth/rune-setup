/**
 * The GUI shell from the CLI's side (docs/architecture.md §9.4): `rune gui install`
 * fetches the prebuilt shell into the per-user cache, and `rune run --gui` launches it
 * with the run's invocation and forwards its exit code — the shell hosts the engine, the
 * CLI only waits.
 */

import { spawn } from 'node:child_process';
import {
  createWriteStream,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import { homedir, tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

import { CancelledError, PlatformError, RUNE_VERSION, UsageError } from '@rune/engine';

import type { RunFlags } from './args.js';
import { ExitWithCode, humanStderr, type CliControl, type CliIo } from './io.js';
import type { Interaction } from './prompt.js';

/** GitHub coordinates of the shell releases — one release per engine version (§9.4). */
const RELEASES = 'https://github.com/MarcusKorinth/rune-setup/releases/download';

const SHELL_BINARY = process.platform === 'win32' ? 'rune-gui-shell.exe' : 'rune-gui-shell';

const SHELL_VERSION_PROBE_FLAG = '--rune-version-probe';

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

function requireSupportedHost(): void {
  if (process.platform === 'win32' || process.platform === 'linux') return;
  throw new PlatformError(
    `host platform "${process.platform}" is not supported; supported Node platforms are win32 and linux`,
  );
}

function shellCommand(
  location: ShellLocation,
  argv: readonly string[],
): readonly [command: string, args: readonly string[]] {
  return location.kind === 'binary'
    ? [location.path, argv]
    : [devElectron(location.dir), [location.dir, ...argv]];
}

/**
 * Where the shell lives: the RUNE_GUI_SHELL override (a packaged binary, or a shell
 * package directory for development), else the per-user cache.
 */
export function locateShell(
  environment: Readonly<Record<string, string | undefined>> = process.env,
): ShellLocation | undefined {
  const override = environment['RUNE_GUI_SHELL'];
  if (override !== undefined && override !== '') {
    const location = resolve(override);
    return statSync(location, { throwIfNoEntry: false })?.isDirectory() === true
      ? { kind: 'dev', dir: location }
      : { kind: 'binary', path: location };
  }
  const cached = join(shellCacheDir(), SHELL_BINARY);
  return existsSync(cached) ? { kind: 'binary', path: cached } : undefined;
}

/** `rune gui install`: fetch the release matching this engine version, unpack via OS tar. */
export async function guiInstallCommand(io: CliIo): Promise<void> {
  requireSupportedHost();
  const archiveName =
    process.platform === 'win32' ? `rune-gui-shell-windows.zip` : `rune-gui-shell-linux.tar.gz`;
  const url = `${RELEASES}/v${RUNE_VERSION}/${archiveName}`;
  const target = shellCacheDir();
  let temporaryDirectory: string;
  try {
    temporaryDirectory = mkdtempSync(join(tmpdir(), 'rune-gui-install-'));
  } catch {
    humanStderr(
      io,
      'could not create temporary storage for the GUI shell — check temporary-directory permissions and available disk space',
    );
    throw new ExitWithCode(1);
  }
  const archive = join(temporaryDirectory, archiveName);
  let stagingDirectory: string | undefined;

  try {
    humanStderr(io, `fetching ${url}`);
    let response: Response;
    try {
      response = await fetch(url);
    } catch {
      humanStderr(
        io,
        'could not fetch the GUI shell release — check your network connection and try again',
      );
      throw new ExitWithCode(1);
    }
    if (!response.ok || response.body === null) {
      humanStderr(
        io,
        `no shell release for engine ${RUNE_VERSION} (${response.status} ${response.statusText})`,
      );
      throw new ExitWithCode(1);
    }

    const download = Readable.fromWeb(response.body);
    const output = createWriteStream(archive);
    let firstDownloadError: 'source' | 'output' | undefined;
    download.once('error', () => {
      firstDownloadError ??= 'source';
    });
    output.once('error', () => {
      firstDownloadError ??= 'output';
    });
    try {
      await pipeline(download, output);
    } catch (cause) {
      if (firstDownloadError === 'source') {
        humanStderr(
          io,
          'downloading the GUI shell release failed — check your network connection and try again',
        );
        throw new ExitWithCode(1);
      }
      if (firstDownloadError === 'output') {
        humanStderr(
          io,
          'could not write the GUI shell archive to temporary storage — check temporary-directory permissions and available disk space',
        );
        throw new ExitWithCode(1);
      }
      throw cause;
    }

    const cacheParent = dirname(target);
    try {
      mkdirSync(cacheParent, { recursive: true });
      stagingDirectory = mkdtempSync(join(cacheParent, '.rune-shell-stage-'));
    } catch {
      humanStderr(
        io,
        `could not prepare the GUI shell cache at ${cacheParent} — check directory permissions and available disk space`,
      );
      throw new ExitWithCode(1);
    }
    const extractionDirectory = stagingDirectory;
    // bsdtar ships with Windows 10+ and handles both formats; argv only, never a shell (§12).
    const code = await new Promise<number>((resolve) => {
      const child = spawn('tar', ['-xf', archive, '-C', extractionDirectory], {
        stdio: ['ignore', 'ignore', 'inherit'],
        shell: false,
      });
      child.on('error', () => resolve(70));
      child.on('close', (exit) => resolve(exit ?? 70));
    });
    if (code !== 0) {
      humanStderr(io, `unpacking ${archive} failed (tar exit ${code})`);
      throw new ExitWithCode(1);
    }

    const stagedShell = join(stagingDirectory, SHELL_BINARY);
    let stagedShellIsFile: boolean;
    try {
      stagedShellIsFile = statSync(stagedShell, { throwIfNoEntry: false })?.isFile() === true;
    } catch {
      humanStderr(
        io,
        `could not inspect the unpacked GUI shell at ${stagedShell} — check cache permissions`,
      );
      throw new ExitWithCode(1);
    }
    if (!stagedShellIsFile) {
      humanStderr(io, `unpacked shell is missing the expected binary ${SHELL_BINARY}`);
      throw new ExitWithCode(1);
    }

    promoteStagedDirectory(stagingDirectory, target, io);
    stagingDirectory = undefined;
    humanStderr(io, `GUI shell ${RUNE_VERSION} installed to ${target}`);
  } finally {
    if (stagingDirectory !== undefined) {
      removeBestEffort(stagingDirectory, io);
    }
    removeBestEffort(temporaryDirectory, io);
  }
}

function promoteStagedDirectory(stagingDirectory: string, target: string, io: CliIo): void {
  const backup = `${stagingDirectory}-backup`;
  const hadExistingTarget = existsSync(target);
  if (hadExistingTarget) {
    try {
      renameSync(target, backup);
    } catch {
      humanStderr(
        io,
        `could not preserve the existing GUI shell cache at ${target} — check permissions`,
      );
      throw new ExitWithCode(1);
    }
  }

  try {
    renameSync(stagingDirectory, target);
  } catch {
    if (hadExistingTarget) {
      try {
        renameSync(backup, target);
      } catch {
        humanStderr(
          io,
          `could not install the GUI shell or restore the previous cache; the recoverable backup remains at ${backup}`,
        );
        throw new ExitWithCode(1);
      }
    }
    humanStderr(io, `could not install the GUI shell to ${target} — check cache permissions`);
    throw new ExitWithCode(1);
  }

  if (hadExistingTarget) {
    removeBestEffort(backup, io);
  }
}

function removeBestEffort(path: string, io: CliIo): void {
  try {
    rmSync(path, { recursive: true, force: true });
  } catch {
    humanStderr(io, `warning: could not remove temporary GUI shell files at ${path}`);
  }
}

/** `rune run --gui`: launch the shell with the invocation, forward its exit code (§9.4). */
export async function launchGui(
  manifestPath: string,
  flags: RunFlags,
  io: CliIo,
  interaction: Interaction,
  control: CliControl = {},
): Promise<void> {
  requireSupportedHost();
  const location = locateShell();
  if (location === undefined) {
    throw new UsageError(
      'the GUI shell is not installed for this engine version — run: rune gui install',
    );
  }

  // Keep Electron from interpreting RUNE flags such as `--log-file`. The manifest follows
  // the marker as a literal, so a valid name beginning with `--` stays unambiguous.
  const argv: string[] = ['--', manifestPath];
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
  // The first Ctrl+C or SIGTERM cancels whichever GUI startup process is active (§9.4):
  // terminate the probe, or forward one request to the workflow shell. Only a second
  // Ctrl+C force-exits the CLI; repeated SIGTERM remains idempotent.
  let child: ReturnType<typeof spawn> | undefined;
  let probeChild: ReturnType<typeof spawn> | undefined;
  let probeTerminationSent = false;
  let cancelRequested = false;
  let receivedSigint = false;
  const terminateProbe = (): void => {
    if (probeTerminationSent || probeChild?.pid === undefined) return;
    probeTerminationSent = true;
    if (process.platform === 'win32') {
      // The probe has no cooperative session; terminate its complete process tree.
      const taskkill = spawn('taskkill', ['/PID', String(probeChild.pid), '/T', '/F'], {
        stdio: 'ignore',
        shell: false,
      });
      // Cancellation is already in progress; a failed best-effort terminator must not crash us.
      taskkill.once('error', () => undefined);
      return;
    }
    try {
      process.kill(-probeChild.pid, 'SIGTERM');
    } catch {
      // The detached probe group already exited between the signal and this request.
    }
  };
  const forwardCancel = (): void => {
    if (child?.pid === undefined) return;
    if (process.platform === 'win32') {
      // A close request, not a kill: no /F (§9.4).
      const taskkill = spawn('taskkill', ['/PID', String(child.pid)], {
        stdio: 'ignore',
        shell: false,
      });
      // Cancellation is already in progress; a failed best-effort terminator must not crash us.
      taskkill.once('error', () => undefined);
    } else {
      child.kill('SIGTERM');
    }
  };
  const requestCancel = (): void => {
    if (cancelRequested) return;
    cancelRequested = true;
    if (probeChild !== undefined) {
      terminateProbe();
    } else {
      forwardCancel();
    }
  };
  const onSigint = (): void => {
    if (receivedSigint) {
      interaction.forceExit?.(6);
      return;
    }
    receivedSigint = true;
    requestCancel();
  };
  const onSigterm = (): void => requestCancel();
  const ownsSignals = control.cancel === undefined;
  if (ownsSignals) {
    process.on('SIGINT', onSigint);
    process.on('SIGTERM', onSigterm);
  }
  const disposeCancel = control.cancel?.onCancel(requestCancel);

  try {
    if (cancelRequested) {
      throw new CancelledError('cancelled before the GUI shell started');
    }
    try {
      await verifyShellVersion(location, (probe) => {
        probeChild = probe;
        if (probe !== undefined && cancelRequested) {
          terminateProbe();
        }
      });
    } catch (cause) {
      if (cancelRequested) {
        throw new CancelledError('cancelled before the GUI shell started');
      }
      throw cause;
    }
    if (cancelRequested) {
      throw new CancelledError('cancelled before the GUI shell started');
    }

    const [command, args] = shellCommand(location, argv);
    const launchedChild = spawn(command, args, {
      stdio: ['ignore', 'ignore', 'inherit'],
      shell: false,
      // Its own process group on POSIX: a terminal Ctrl+C must reach only the CLI, which
      // forwards a deliberate SIGTERM — a raw SIGINT would kill the shell past its cancel
      // path (§9.4). Same reason the engine's runner detaches its children.
      detached: process.platform !== 'win32',
    });
    child = launchedChild;

    if (cancelRequested) {
      forwardCancel();
    }

    const outcome = await new Promise<{ code: number | null; failed: boolean }>((resolve) => {
      launchedChild.on('error', (cause) => {
        humanStderr(io, `could not launch the GUI shell: ${cause.message}`);
        resolve({ code: null, failed: true });
      });
      launchedChild.on('close', (code) => resolve({ code, failed: false }));
    });

    // Signal death or an unknown (e.g. Chromium crash) code is an internal error (§9.4).
    const exit =
      !outcome.failed && outcome.code !== null && FORWARDABLE.has(outcome.code) ? outcome.code : 70;
    if (exit !== 0) {
      throw new ExitWithCode(exit);
    }
  } finally {
    disposeCancel?.();
    if (ownsSignals) {
      process.removeListener('SIGINT', onSigint);
      process.removeListener('SIGTERM', onSigterm);
    }
  }
}

async function verifyShellVersion(
  location: ShellLocation,
  onProbe: (child: ReturnType<typeof spawn> | undefined) => void,
): Promise<void> {
  const [command, args] = shellCommand(location, [SHELL_VERSION_PROBE_FLAG]);
  const child = spawn(command, args, {
    stdio: ['ignore', 'pipe', 'ignore'],
    shell: false,
    detached: process.platform !== 'win32',
  });
  let stdout = '';
  child.stdout.setEncoding('utf8');
  const onData = (chunk: string): void => {
    if (stdout.length <= 4096) {
      stdout += chunk;
    }
  };
  child.stdout.on('data', onData);

  const outcome = await new Promise<{ code: number | null; failed: boolean }>((resolve) => {
    let settled = false;
    const finish = (result: { code: number | null; failed: boolean }): void => {
      if (settled) return;
      settled = true;
      child.stdout.removeListener('data', onData);
      child.removeListener('error', onError);
      child.removeListener('close', onClose);
      onProbe(undefined);
      resolve(result);
    };
    const onError = (): void => finish({ code: null, failed: true });
    const onClose = (code: number | null): void => finish({ code, failed: false });
    child.once('error', onError);
    child.once('close', onClose);
    onProbe(child);
  });
  const reinstall = 'run: rune gui install';
  if (outcome.failed || outcome.code !== 0 || stdout.length > 4096) {
    throw new UsageError(`the GUI shell version could not be verified — ${reinstall}`);
  }

  let probe: unknown;
  try {
    probe = JSON.parse(stdout);
  } catch {
    throw new UsageError(`the GUI shell does not support the version probe — ${reinstall}`);
  }
  if (
    typeof probe !== 'object' ||
    probe === null ||
    (probe as { protocolVersion?: unknown }).protocolVersion !== 1 ||
    typeof (probe as { runeVersion?: unknown }).runeVersion !== 'string'
  ) {
    throw new UsageError(`the GUI shell returned a malformed version probe — ${reinstall}`);
  }
  const shellVersion = (probe as { runeVersion: string }).runeVersion;
  if (shellVersion !== RUNE_VERSION) {
    throw new UsageError(
      `the GUI shell engine version ${shellVersion} does not match ${RUNE_VERSION} — ${reinstall}`,
    );
  }
}

/** Development launch: the electron binary resolved from the shell package's own tree. */
function devElectron(shellDir: string): string {
  try {
    const require = createRequire(join(shellDir, 'package.json'));
    const moduleDirectory = dirname(require.resolve('electron'));
    // Electron's Node entry may download a missing runtime synchronously. Resolve the
    // prepared binary without executing that entry, so startup never installs software.
    const pathFile = join(moduleDirectory, 'path.txt');
    const executableName = existsSync(pathFile) ? readFileSync(pathFile, 'utf8').trim() : '';
    const overrideDirectory = process.env['ELECTRON_OVERRIDE_DIST_PATH'];
    const executable = overrideDirectory
      ? join(overrideDirectory, executableName || 'electron')
      : join(moduleDirectory, 'dist', executableName);
    if ((!overrideDirectory && executableName === '') || !statSync(executable).isFile()) {
      throw new Error();
    }
    return executable;
  } catch {
    throw new UsageError(
      `RUNE_GUI_SHELL directory "${shellDir}" has no prepared Electron runtime; run npm run prepare:electron in that shell package, or unset RUNE_GUI_SHELL to use the cached shell`,
    );
  }
}
