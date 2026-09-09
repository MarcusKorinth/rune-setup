# Package a workflow

Workflow packages contain the RUNE GUI runtime and your workflow files. The first
formats are Windows x64 ZIP and Linux x64 tar.gz; build on the target operating
system. End users extract the archive and start its executable. Node is needed on
the author's build machine, but the package includes RUNE's execution runtime.

## Build

Build the CLI from the repository with `npm ci --ignore-scripts` and `npm run build`.
Use an extracted GUI shell from the same RUNE version, downloaded from its
[published release](https://github.com/MarcusKorinth/rune-setup/releases) when available.
To build the shell yourself, run `npm run build:shell` after preparing Electron, then
extract the archive under `output/shell/`. See [shell build prerequisites](releasing.md#build-and-verification).

From the RUNE checkout, on Windows:

```powershell
node packages/cli/dist/main.js package C:/work/my-workflow/installer.yaml --shell C:/work/rune-shell --output C:/work/releases/my-setup.zip
```

On Linux:

```bash
node packages/cli/dist/main.js package /work/my-workflow/installer.yaml --shell /work/rune-shell --output /work/releases/my-setup.tar.gz
```

When a matching shell is installed through `rune gui install`, omit `--shell` to
use that cache. A source shell selected through `RUNE_GUI_SHELL` is insufficient;
packaging needs the complete extracted runtime. The packager checks both the
engine version and support for bundled workflows. Existing output archives are
never overwritten.

The default inputs are the manifest and its adjacent `scripts/`, `payload/`,
`assets/`, and `locales/` directories. Add other files or directories explicitly:

```text
--include license.txt --include config
```

Paths are relative to the manifest directory. Absolute paths, `..` components,
symbolic links and special files are refused. Review the selected resources before
distribution; every file inside an included directory is shipped. Values files
and unrelated repository files are not collected automatically.

Keep resource references relative or anchored with `${manifestDir}`. Packaging
preserves the manifest and scripts unchanged; it does not discover dependencies
inside arbitrary scripts. Commands such as `node`, Python, or an external database
client still require those tools on the target machine unless you supply them.
Linux also retains the [runtime prerequisites](releasing.md#runtime-prerequisites).

## Customize and launch

The manifest's `gui` fields configure the window title, accent, logo, banner and
local CSS. Put those files in `assets/` or include them explicitly. Locale files
remain in `locales/`. Stable CSS variables and the limits of author CSS are described
in [theming](architecture.md#theming). Packaging retains the native executable
identity and signature state of the supplied RUNE shell.

The archive has the runtime at its root and the workflow beneath
`resources/workflow/`. Its `resources/rune-workflow.json` binds the executable to
the original manifest filename. Start `rune-gui-shell.exe` on Windows or
`./rune-gui-shell` on Linux; no manifest argument is needed, and the caller's
working directory does not select the workflow.

For automation, the same executable accepts the existing run options:

```powershell
./rune-gui-shell.exe --non-interactive --values C:/work/answers.yaml --result C:/work/result.json
```

Use `./rune-gui-shell` on Linux. Input values, cancellation, logs and exit codes
follow the same engine contract as the CLI. Result/log paths supplied as arguments
remain relative to the caller's working directory, or absolute when specified.

## Verify and automate

`npm run test:workflow:package` exercises a small generated workflow against the
fresh GUI archive. It removes the author's source files, starts the packaged
workflow graphically and headlessly with no Node in `PATH`, and checks resource
inclusion, custom styling, localization, real script execution and secret masking.
Linux graphical checks need a display or `xvfb-run --auto-servernum`.

In a product CI pipeline, pin the RUNE checkout and shell download to the same
version, run the packaging command on each target host, then test and publish the
resulting archive as a product release asset. Product versions and RUNE versions
are independent.
