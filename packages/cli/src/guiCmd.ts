/**
 * The GUI shell from the CLI's side (docs/architecture.md §9.4): `rune gui install`
 * fetches the prebuilt shell into the per-user cache, and `rune run --gui` launches it
 * with the run's invocation and forwards its exit code — the shell hosts the engine, the
 * CLI only waits.
 */

import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import {
  createWriteStream,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import { homedir, tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { Readable, type Duplex } from 'node:stream';
import { pipeline } from 'node:stream/promises';

import { CancelledError, PlatformError, RUNE_VERSION, UsageError } from '@rune/engine';

import type { RunFlags } from './args.js';
import { locateCachedShell, publishCachedShell } from './guiCache.js';
import { createGuiStartupGate, type GuiStartupGate } from './guiStartup.js';
import { ExitWithCode, humanStderr, type CliControl, type CliIo } from './io.js';
import type { Interaction } from './prompt.js';

/** GitHub coordinates of the shell releases — one release per engine version (§9.4). */
const RELEASES = 'https://github.com/MarcusKorinth/rune-setup/releases/download';

const SHELL_BINARY = process.platform === 'win32' ? 'rune-gui-shell.exe' : 'rune-gui-shell';

const SHELL_VERSION_PROBE_FLAG = '--rune-version-probe';
const SHELL_PROBE_TIMEOUT_MS = 10_000;
const SHELL_PROBE_CLOSE_TIMEOUT_MS = 5000;

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
  const cache = shellCacheDir();
  try {
    const binary = locateCachedShell(cache, SHELL_BINARY, RUNE_VERSION);
    return binary === undefined ? undefined : { kind: 'binary', path: binary };
  } catch {
    throw new UsageError(
      `the GUI shell cache at "${cache}" has no readable complete selection — run: rune gui install`,
    );
  }
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

    try {
      mkdirSync(target, { recursive: true });
      stagingDirectory = mkdtempSync(join(target, '.rune-shell-stage-'));
    } catch {
      humanStderr(
        io,
        `could not prepare the GUI shell cache at ${target} — check directory permissions and available disk space`,
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
      stagedShellIsFile = lstatSync(stagedShell, { throwIfNoEntry: false })?.isFile() === true;
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
  try {
    publishCachedShell(stagingDirectory, target, SHELL_BINARY, RUNE_VERSION, (path) => {
      humanStderr(io, `warning: could not remove temporary GUI shell files at ${path}`);
    });
  } catch {
    humanStderr(
      io,
      `could not publish the GUI shell in ${target} — check cache permissions and available disk space; run: rune gui install`,
    );
    throw new ExitWithCode(1);
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
  let probeTimedOut = false;
  let cancelRequested = false;
  let receivedSigint = false;
  let startup: GuiStartupGate | undefined;
  const terminateProbe = (force = false): void => {
    if ((!force && probeTerminationSent) || probeChild?.pid === undefined) return;
    probeTerminationSent = true;
    if (process.platform === 'win32') {
      // The probe has no cooperative session; terminate its complete process tree.
      try {
        const taskkill = spawn('taskkill', ['/PID', String(probeChild.pid), '/T', '/F'], {
          stdio: 'ignore',
          shell: false,
          timeout: SHELL_PROBE_CLOSE_TIMEOUT_MS,
          killSignal: 'SIGKILL',
        });
        taskkill.once('error', () => undefined);
      } catch {
        // The close deadline also bounds a probe whose terminator cannot start.
      }
      return;
    }
    try {
      process.kill(-probeChild.pid, force ? 'SIGKILL' : 'SIGTERM');
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
      if (process.platform !== 'linux' || startup?.cancel() === true) forwardCancel();
    }
  };
  const onSigint = (): void => {
    if (receivedSigint) {
      if (startup?.transferred() === false) startup.abort();
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
  const onHostExit = (): void => {
    if (startup?.transferred() === false) startup.abort();
  };
  process.once('exit', onHostExit);

  try {
    if (cancelRequested) {
      throw new CancelledError('cancelled before the GUI shell started');
    }
    try {
      await verifyShellVersion(
        location,
        (probe) => {
          probeChild = probe;
          if (probe !== undefined && cancelRequested) {
            terminateProbe();
          }
        },
        () => {
          probeTimedOut = !cancelRequested;
          terminateProbe(true);
        },
      );
    } catch (cause) {
      if (cancelRequested && !probeTimedOut) {
        throw new CancelledError('cancelled before the GUI shell started');
      }
      throw cause;
    }
    if (cancelRequested) {
      throw new CancelledError('cancelled before the GUI shell started');
    }

    const [command, args] = shellCommand(location, argv);
    const startupToken = process.platform === 'linux' ? randomBytes(16).toString('hex') : undefined;
    const launchedChild = spawn(command, args, {
      stdio:
        startupToken === undefined
          ? ['ignore', 'ignore', 'inherit']
          : ['ignore', 'ignore', 'inherit', 'pipe'],
      ...(startupToken === undefined
        ? {}
        : { env: { ...process.env, RUNE_GUI_STARTUP_TOKEN: startupToken } }),
      shell: false,
      // Its own process group on POSIX: a terminal Ctrl+C must reach only the CLI, which
      // forwards a deliberate SIGTERM — a raw SIGINT would kill the shell past its cancel
      // path (§9.4). Same reason the engine's runner detaches its children.
      detached: process.platform !== 'win32',
    });
    child = launchedChild;
    if (startupToken !== undefined) {
      startup = createGuiStartupGate(
        (launchedChild.stdio?.[3] as Duplex | null | undefined) ?? undefined,
        startupToken,
      );
      if (cancelRequested) startup.cancel();
    } else if (cancelRequested) {
      forwardCancel();
    }

    const completion = new Promise<{ code: number | null; failed: boolean }>((resolve) => {
      launchedChild.on('error', (cause) => {
        humanStderr(io, `could not launch the GUI shell: ${cause.message}`);
        startup?.abort();
        resolve({ code: null, failed: true });
      });
      launchedChild.once('close', (code) => {
        startup?.abort();
        resolve({ code, failed: false });
      });
    });
    if (startup !== undefined) {
      try {
        await startup.completion;
      } catch (cause) {
        await terminateUnreadyShell(launchedChild, completion);
        throw cause;
      }
    }
    const outcome = await completion;

    // Signal death or an unknown (e.g. Chromium crash) code is an internal error (§9.4).
    const exit =
      !outcome.failed && outcome.code !== null && FORWARDABLE.has(outcome.code) ? outcome.code : 70;
    if (exit !== 0) {
      throw new ExitWithCode(exit);
    }
  } finally {
    process.off('exit', onHostExit);
    disposeCancel?.();
    if (ownsSignals) {
      process.removeListener('SIGINT', onSigint);
      process.removeListener('SIGTERM', onSigterm);
    }
  }
}

/** A rejected startup gate cannot leave a detached process tree or pipe pinning the CLI. */
async function terminateUnreadyShell(
  child: ReturnType<typeof spawn>,
  completion: Promise<unknown>,
): Promise<void> {
  if (child.pid !== undefined) {
    try {
      process.kill(-child.pid, 'SIGKILL');
    } catch {
      // The startup group may already have exited before its gate failure is observed.
    }
  }
  let deadline: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      completion,
      new Promise<void>((resolveClose) => {
        deadline = setTimeout(resolveClose, SHELL_PROBE_CLOSE_TIMEOUT_MS);
      }),
    ]);
  } finally {
    clearTimeout(deadline);
    child.unref();
  }
}

async function verifyShellVersion(
  location: ShellLocation,
  onProbe: (child: ReturnType<typeof spawn> | undefined) => void,
  onDeadline: () => void,
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
      stdout += chunk.slice(0, 4097 - stdout.length);
    }
  };
  child.stdout.on('data', onData);

  let timedOut = false;
  const outcome = await new Promise<{ code: number | null; failed: boolean }>((resolve) => {
    let settled = false;
    let closeDeadline: NodeJS.Timeout | undefined;
    const finish = (result: { code: number | null; failed: boolean }): void => {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      clearTimeout(closeDeadline);
      child.stdout.removeListener('data', onData);
      child.removeListener('error', onError);
      child.removeListener('close', onClose);
      onProbe(undefined);
      resolve(result);
    };
    const onError = (): void => finish({ code: null, failed: true });
    const onClose = (code: number | null): void => finish({ code, failed: false });
    const deadline = setTimeout(() => {
      timedOut = true;
      closeDeadline = setTimeout(() => {
        child.stdout.destroy();
        child.unref();
        finish({ code: null, failed: true });
        // A late native process error still needs an owner after we release the handle.
        child.once('error', () => undefined);
      }, SHELL_PROBE_CLOSE_TIMEOUT_MS);
      onDeadline();
    }, SHELL_PROBE_TIMEOUT_MS);
    child.once('error', onError);
    child.once('close', onClose);
    onProbe(child);
  });
  const reinstall = 'run: rune gui install';
  if (timedOut) {
    throw new UsageError(
      `the GUI shell did not complete its version probe within 10 seconds — ${reinstall}`,
    );
  }
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
    const executableName = readFileSync(join(moduleDirectory, 'path.txt'), 'utf8').trim();
    const executable = join(
      process.env['ELECTRON_OVERRIDE_DIST_PATH'] ?? join(moduleDirectory, 'dist'),
      executableName,
    );
    if (executableName === '' || !statSync(executable).isFile()) throw new Error();
    return executable;
  } catch {
    throw new UsageError(
      `RUNE_GUI_SHELL directory "${shellDir}" has no prepared Electron runtime; run npm run prepare:electron in that shell package, or unset RUNE_GUI_SHELL to use the cached shell`,
    );
  }
}
