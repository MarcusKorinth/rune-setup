# Release acceptance

A release candidate needs verified installation and execution workflows on Windows
and Linux. This is a reusable acceptance checklist, not a live record of completed
work: record results against the chosen commit and artifact checksums. Existing CI
already exercises core behavior, installed packages, and GUI archives. The GUI release
workflow publishes verified archives from a version tag. Portable workflow packages
reuse the same shell; their acceptance check is part of the GUI release gate. Registry
delivery remains separate work. A configured workflow is not evidence that a version
has passed acceptance or been published.

## Publish GUI downloads

The [GUI release workflow](../.github/workflows/release-gui.yml) runs on pushed `v*`
tags. A tag must use SemVer without build metadata, match the engine, CLI, GUI shell,
and lockfile versions, and point to a commit already contained in `main`. A matching,
nonempty `## X.Y.Z` or `## X.Y.Z - YYYY-MM-DD` section in `CHANGELOG.md` supplies the
release notes. Prerelease versions such as `X.Y.Z-rc.1` produce GitHub prereleases.

Prepare version constants, package and lockfile versions, dependency pins, and the
changelog in a reviewed PR first. After it is merged, select that exact commit and
push its annotated version tag. Pushing the tag authorizes automatic publication
after the gates succeed; it is not a way to request a verification-only run.

For verification before tagging, run **GUI release** manually in GitHub Actions on
the chosen branch. Manual runs accept the `Unreleased` changelog section, execute
the same core, security, native shell, extracted-archive, and portable workflow checks, and retain the
assembled downloads as the `gui-release-candidate` artifact. They never create or
modify a GitHub release.

Both paths reuse the normal Windows/Linux CI and security workflows against the
triggering commit. Publication waits for all checks, verifies each archive against
its build metadata and the candidate lockfile, and transfers those exact files to
a draft release. Only the final publication job has repository write permission.
It verifies GitHub's uploaded asset digests before making the release public.

Each release contains:

- `rune-gui-shell-windows.zip` and `rune-gui-shell-linux.tar.gz`, both x64
- `build-metadata-windows-x64.json` and `build-metadata-linux-x64.json`
- `release-manifest.json`, identifying the source commit, version, and archive hashes
- `SHA256SUMS` and `release-notes.md`

The archive names match `rune gui install`'s version-specific download URLs. The
release manifest records provenance; it is not a new download protocol. These are
runtime archives, so a workflow author still supplies the manifest and its resources
and can bundle them using [`rune package`](packaging.md).
The source CLI can install a published shell without a development override:

```bash
node packages/cli/dist/main.js gui install
node packages/cli/dist/main.js run /path/to/installer.yaml --gui
```

Archives are currently unsigned. Checksums detect altered downloads but do not
authenticate a publisher independently of GitHub. Windows may show an unknown-publisher
warning. Do not describe these files as signed or as installed system applications.

Publication never replaces an existing asset. A failed upload leaves a draft; rerun
the failed publication job while the same candidate artifact is retained to upload
missing files and verify existing ones. A fully published identical release is a
no-op. Different files, notes, or unexpected assets make the job fail without
overwriting them. Rebuilding a candidate may change archive bytes, so do not assume
rerunning the whole workflow can resume an older draft. Inspect and explicitly remove
an abandoned draft before retrying with different files. Never move a published tag;
fix a published release through a new version.

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
npm run test:coverage
npm run test:packages
```

The coverage command runs the full core suite and enforces the global and package-area
thresholds in [vitest.config.ts](../vitest.config.ts). It includes runtime source files
even when no test imports them. Separate child processes and native Electron execution
are outside that collector; a coverage percentage does not replace their artifact checks.
`npm test` runs the core suite without coverage for local iteration. Shell tests also
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
- [ ] Review source security scan results and follow the
      [security finding policy](../SECURITY.md#security-maintenance).
- [ ] Check package versions, dependency pins, exported versions, and GUI version
      matching. Review the changelog and repository/package links.
- [ ] Verify the RUNE icon and product/version metadata in the extracted executable.
      Shell archives are intentionally unsigned; Windows may show an unknown-publisher
      warning. Do not describe them as signed or promise that operating-system
      reputation checks will accept them without a prompt.
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
npm run test:workflow:package
```

Windows builds also need Visual Studio C++ Build Tools with the x64 compiler and
Windows 10/11 SDK; GitHub's Windows runner includes them. The MSVC build uses its
static CRT, so users do not install another runtime. Alternatively set
`RUNE_WINDOWS_CC` to an absolute LLVM-MinGW `clang.exe` or Zig `zig.exe` path.
The builder compiles only a process transport launcher; Electron still hosts RUNE.

Linux graphical checks run under a desktop display or `xvfb-run --auto-servernum` and
require usable Chromium sandbox support. CI enables user namespaces for its temporary
Linux runner; it does not add `--no-sandbox` to the artifact check. The build records
the archive checksum and locked runtime dependencies in `build-metadata.json` beside
the archive under `output/shell/`. Ordinary CI retains tested archives as build
artifacts. The tag-triggered GUI release workflow publishes these archives after the
complete candidate gate; it does not publish npm packages.

The artifact check removes `DISPLAY` and `WAYLAND_DISPLAY` for Linux version probes
and non-interactive runs. It also exercises real child processes, masked result/log output,
input and step failures, timeouts, unwritable destinations, and cancellation.

- [ ] Verify exact empty stdout and serialized machine output from the published
      entrypoint. The Windows launcher removes Electron's native initial CRLF and
      preserves every subsequent application byte; the archive checks allow no prefix.

The public npm name `@rune/cli` currently belongs to another project. Settle the
namespace and update these commands before any registry publication.

## Runtime prerequisites

Current local archives are x64. Electron 44 supports Windows 10 and later and Linux
distributions still supported by both Chromium and their vendor; this is an upstream
boundary, not evidence that every such system has passed RUNE's checks. See Electron's
[platform support](https://github.com/electron/electron/blob/v44.2.0/README.md#platform-support).
The verified local environments are Windows 11 Pro x64 and a Debian 12 x64 container
(glibc 2.36) on a WSL2 host. The container uses an ordinary user, permitted user namespaces,
and Xvfb for graphical checks. CI also verifies Windows and Linux runners; record the
successful run for the chosen candidate rather than carrying a prior result forward.

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
