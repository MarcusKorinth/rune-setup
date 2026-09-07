# Release acceptance

A release candidate needs verified installation and execution workflows on Windows
and Linux. This document is a checklist; unchecked work remains before release.

## User workflows

- [ ] Install the CLI from the chosen owner-controlled npm namespace in a clean
      environment and run the documented example without repository implementation files.
- [ ] Install a GUI archive through `rune gui install`, then run the same example with
      `--gui` without `RUNE_GUI_SHELL` or a development checkout.
- [ ] Run the example interactively and non-interactively with equivalent input values;
      compare commands, outcomes, and results across all three modes.
- [ ] Package a workflow with its scripts, payload, assets, and locales. Run its portable
      artifact as an ordinary user without Node installed, both graphically and headlessly.
- [ ] Exercise invalid input, a failed step, timeout, cancellation, log/result failures,
      and declared-secret masking using the delivered artifacts.
- [ ] Document supported OS versions and architectures, installation prerequisites, and
      remaining limitations.

## Build and verification

The runtime target is Node 24 LTS and Electron 44. Confirm `.nvmrc`,
package engine requirements, CI, and the shell's embedded runtime agree before testing.
Use a clean checkout for candidate verification. npm prepack removes generated output
before rebuilding; the shell builder selects runtime files from the current source tree.
Both paths prevent obsolete files in `dist` from entering their archives.

Run the core gate on Windows and Linux:

```bash
npm ci --ignore-scripts
npm run typecheck
npm run lint
npm run format:check
npm run depcruise
npm test
npm run test:packages
```

Core CI skips installation scripts with `npm ci --ignore-scripts`. Shell tests also
prepare the Electron binary and build the application. On Windows:

```powershell
npm run prepare:electron --workspace @rune/gui-shell
npm run build
npm run test:smoke --workspace @rune/gui-shell
```

On Linux:

```bash
npm run prepare:electron --workspace @rune/gui-shell
npm run build
xvfb-run --auto-servernum npm run test:smoke --workspace @rune/gui-shell
```

- [ ] All CI jobs pass for the exact candidate commit, including tests of produced
      packages and GUI archives.
- [ ] Run `npm audit` and `npm audit --omit=dev`; review both development and runtime
      findings and record any unresolved risk with its impact.
- [ ] Check package versions, dependency pins, exported versions, and GUI version
      matching. Review the changelog and repository/package links.
- [ ] Replace the default Electron icon with approved project artwork and decide
      release signing. Current local archives are unsigned.
- [ ] Record the verified commit, artifact checksums, and results before approving
      publication. Keep the changelog unreleased until publication occurs.

## Package inspection

With the current workspace names, local archives can be inspected without publishing:

```bash
npm pack --workspace @rune/engine --workspace @rune/cli --dry-run --json
npm pack --workspace @rune/engine --workspace @rune/cli
```

- [ ] Inspect code, declarations, package metadata, README, and LICENSE. Exclude stale
      build output, caches, tests, and local files. The CLI dependency tree contains no Electron.
- [ ] Install both local tarballs together in an empty consumer directory with
      `npm install --omit=dev --ignore-scripts <engine-tarball> <cli-tarball>`, using
      actual absolute archive paths. Run the installed binary and import the engine.
- [ ] Verify `--version`, both schemas, validation, and a non-interactive run with result
      and log files. Test from a different working directory and a path containing spaces.
- [ ] Test the GUI archive separately with its complete runtime and static resources;
      copying compiled JavaScript alone does not produce a usable shell.

Build a host x64 shell archive after preparing Electron:

```bash
npm run build:shell
npm run test:shell:package
```

Linux graphical checks run under a desktop display or `xvfb-run --auto-servernum` and
require usable Chromium sandbox support. CI enables user namespaces for its temporary
Linux runner; it does not add `--no-sandbox` to the artifact check. The build records
the archive checksum and locked runtime dependencies in `build-metadata.json` beside
the archive under `output/shell/`. CI retains tested archives as build artifacts;
it does not publish a GitHub release or npm packages.

The artifact check removes `DISPLAY` and `WAYLAND_DISPLAY` for Linux version probes
and non-interactive runs. It also exercises real child processes, masked result/log output,
input and step failures, timeouts, unwritable destinations, and cancellation.

- [ ] Resolve the native Windows Electron stdout prefix and verify exact empty and
      serialized artifact stdout before publication. Archive smoke checks that compare
      native whitespace and parse JSON do not establish byte-exact compliance.

The public npm name `@rune/cli` currently belongs to another project. Settle the
namespace and update these commands before any registry publication.

## Runtime prerequisites

Current local archives are x64. Electron 44 supports Windows 10 and later and Linux
distributions still supported by both Chromium and their vendor; this is an upstream
boundary, not evidence that every such system has passed RUNE's checks. See Electron's
[platform support](https://github.com/electron/electron/blob/v44.2.0/README.md#platform-support).
The verified local environments are Windows 11 Pro x64 and a Debian 12 x64 container
(glibc 2.36) on a WSL2 host. The container uses an ordinary user, permitted user namespaces,
and Xvfb for graphical checks. The configured GitHub runner matrix still needs to pass
for the eventual candidate commit.

The Linux executable dynamically links to system libraries even in headless mode:
glibc, GLib, NSS/NSPR, GTK 3, ATK/AT-SPI, Cairo/Pango, X11/XCB, xkbcommon, GBM, ALSA,
CUPS, D-Bus, udev, and Expat, including their dependencies. A minimal server image may
lack them. Chromium sandbox support must also be available; host restrictions on
unprivileged user namespaces can prevent startup. RUNE does not disable the sandbox.
See Ubuntu's [user namespace restrictions](https://documentation.ubuntu.com/security/security-features/privilege-restriction/apparmor/)
when diagnosing that failure on Ubuntu.

The archive includes the Node runtime used by the engine. Commands declared by a
workflow retain their own prerequisites: for example, the basic example's `command: node`
still needs Node on the command search path. Bundling Electron does not install an
external `node` command or other tools used by the author's scripts.

## Known limitations

- A background process that inherits stdout or stderr can keep a step pending after
  its direct process exits. Redirect background-process streams and configure
  `timeoutSeconds` when a bounded run is required.
- GUI-cache updates retain previously published generations so a running application
  keeps its files. Unused version directories can be removed manually when no shell
  uses them; automatic cache pruning is not implemented.
- Windows Electron 44.2.0 currently adds a native CRLF before application stdout in
  subprocess and headless invocations, including before `--result -` JSON; an
  Electron-only app reproduces it. This remains an unresolved deviation from the
  exact stdout requirement; see the [historical upstream issue](https://github.com/electron/electron/issues/12578).
  Result-file delivery and Node CLI output are unaffected; use `--result PATH` for
  exact serialized bytes. The strict stdout requirement remains open before publication.
