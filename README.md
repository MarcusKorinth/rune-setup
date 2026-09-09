# RUNE

[![CI](https://img.shields.io/github/actions/workflow/status/MarcusKorinth/rune-setup/ci.yml?branch=main&label=ci)](https://github.com/MarcusKorinth/rune-setup/actions/workflows/ci.yml)
[![Security checks](https://img.shields.io/github/actions/workflow/status/MarcusKorinth/rune-setup/security.yml?branch=main&label=security)](https://github.com/MarcusKorinth/rune-setup/actions/workflows/security.yml)
[![Node.js: 24 LTS](https://img.shields.io/badge/node.js-24%20LTS-green)](.nvmrc)
[![TypeScript: strict](https://img.shields.io/badge/typescript-strict-blueviolet)](tsconfig.base.json)
[![Platforms: Windows and Linux](https://img.shields.io/badge/platforms-Windows%20%7C%20Linux-blue)](docs/releasing.md#runtime-prerequisites)
[![Line coverage gate: ≥87%](https://img.shields.io/badge/line%20coverage%20gate-%E2%89%A587%25-brightgreen)](vitest.config.ts)
[![License: MIT](https://img.shields.io/badge/license-MIT-green.svg)](LICENSE)

RUNE runs setup workflows described in YAML. A workflow defines inputs and commands;
the engine executes it through an interactive terminal, a non-interactive command,
or an Electron wizard. Authors provide the scripts and payload their setup needs.

## Project status

GUI releases target Windows and Linux x64. A version is available when its
[GitHub Release](https://github.com/MarcusKorinth/rune-setup/releases) contains the
download archives. Engine/CLI packages and portable workflows can also be built
from source; public npm installation is not available yet.

RUNE targets Windows and Linux. Development uses Node 24 LTS and
Electron 44; use the checked-in `.nvmrc` for the current
checkout. The public npm name `@rune/cli` belongs to another project, so RUNE's
publication namespace must be settled before registry installation is documented.

See the [remaining work](docs/roadmap.md) and [release acceptance criteria](docs/releasing.md).

## Download the GUI runtime

From a published release, download `rune-gui-shell-windows.zip` or
`rune-gui-shell-linux.tar.gz` and extract the entire archive. It includes the runtime;
RUNE itself does not need a separate Node installation.

Start it with your workflow manifest. On Windows:

```powershell
./rune-gui-shell.exe -- C:/work/my-workflow/installer.yaml
```

On Linux:

```bash
./rune-gui-shell -- /work/my-workflow/installer.yaml
```

These are unsigned runtime archives. See [runtime prerequisites](docs/releasing.md#runtime-prerequisites)
for Linux system libraries and the requirements of authored commands. To distribute an
executable that opens your own workflow directly, follow [workflow packaging](docs/packaging.md).

## Try the example

From the repository root:

```bash
npm ci --ignore-scripts
npm run build
node packages/cli/dist/main.js validate examples/basic/installer.yaml
node packages/cli/dist/main.js run examples/basic/installer.yaml --dry-run
node packages/cli/dist/main.js run examples/basic/installer.yaml --non-interactive --set profile=production --result examples/basic/output/result.json
```

The [basic example](examples/basic/README.md) writes a configuration file and optional
notes under `examples/basic/output/`. It also produces a setup log; the command above
writes a structured result beside it. It performs no system installation.

For an interactive run, omit `--non-interactive`. The terminal shows the plan and lets
you change inputs before executing it. [CLI usage](packages/cli/README.md) covers values
files, environment inputs, validation, and result output.

## Write a workflow

Start from the [basic manifest](examples/basic/installer.yaml). Relative `cwd` values
and command paths containing a path separator resolve from the manifest directory;
bare command names use `PATH`. Argument paths are passed through after interpolation.
Use `${manifestDir}/scripts/setup.mjs` when a script argument must stay relative to the
manifest directory regardless of `cwd`. Commands receive separate arguments without
an implicit shell and still need their own runtime and tools.

The architecture is also the detailed author and host reference:

- [Manifest fields, input types, and validation](docs/architecture.md#4-manifest-contract)
- [Input value precedence](docs/architecture.md#5-value-resolution)
- [Interpolation, conditions, and localization](docs/architecture.md#6-interpolation-condition-and-text-resolution-semantics)
- [Command execution and timeouts](docs/architecture.md#8-runner-layer)
- [Session API and ordered events](docs/architecture.md#91-session-facade-and-events)
- [Exit codes, results, logs, and masking](docs/architecture.md#10-automation-contract)

Run only workflows and scripts you trust. Validation checks the manifest contract;
it does not sandbox the commands or prevent changes they make with your permissions.
Use declared `secret` inputs for credentials and pass them through command environment
entries. Masking has documented limits, including exact machine fields in results;
see [security and trust boundaries](SECURITY.md) before using sensitive values.
Author-defined text patterns run without a regex timeout, so avoid nested quantifiers
such as `(a+)+`. Use `timeoutSeconds` when a command needs a deadline.

## Try the wizard

Prepare the Electron binary after the build:

```bash
npm run prepare:electron --workspace @rune/gui-shell
```

Point the development launcher at the shell package.
On PowerShell:

```powershell
$env:RUNE_GUI_SHELL = (Resolve-Path packages/gui-shell).Path
```

On Linux:

```bash
export RUNE_GUI_SHELL="$PWD/packages/gui-shell"
```

Then run:

```bash
node packages/cli/dist/main.js run examples/basic/installer.yaml --gui
```

The wizard supports conditional inputs, localized text, and themes. Once the matching
RUNE version has a published GUI archive, `node packages/cli/dist/main.js gui install`
installs it in the per-user cache. Remove `RUNE_GUI_SHELL` to use that cached shell.
To distribute your workflow with its design and runtime, follow [workflow packaging](docs/packaging.md).

## Build a GUI archive

After preparing Electron, build on the target Windows or Linux x64 host:

```bash
npm run build:shell
npm run test:shell:package
```

The builder writes a ZIP or tar.gz beneath `output/shell/`, including Electron, the
engine, and the interface resources. The check extracts a fresh copy and exercises
the packaged application. Linux graphical checks require a display. These are local,
unsigned builds; they do not package a workflow or publish a release.
See the [runtime prerequisites](docs/releasing.md#runtime-prerequisites) before running
an archive; Linux still needs Electron's system libraries and sandbox support.

## Package your workflow

`rune package` combines an extracted GUI shell with your manifest, scripts, payload,
assets and translations. The resulting Windows ZIP or Linux tar.gz opens your workflow
when its executable starts, with no RUNE or Node installation on the user's machine.
Commands in your workflow retain their own tool and permission requirements.

Until the CLI is published, invoke it from this checkout:

```bash
node packages/cli/dist/main.js package path/to/installer.yaml --shell path/to/extracted-shell --output output/my-setup.zip
```

Use `.tar.gz` when building on Linux. Additional resources require explicit `--include`
arguments. See [packaging and end-user commands](docs/packaging.md) for the layout,
customization and automation instructions.

## Development

The npm workspace contains `packages/engine`, `packages/cli`, and `packages/gui-shell`.
For core work without the Electron binary, install with `npm ci --ignore-scripts`.
GUI work also requires the explicit `prepare:electron` command above.

```bash
npm run typecheck
npm run lint
npm run format:check
npm run depcruise
npm run test:coverage
npm run test:packages
```

Use `npm test` for local runs without coverage instrumentation.
The shell also has a Playwright smoke suite:
`npm run test:smoke --workspace @rune/gui-shell`.
Linux CI runs it under `xvfb-run --auto-servernum`.

See [CONTRIBUTING.md](CONTRIBUTING.md) for contributions,
[architecture](docs/architecture.md) for engine and frontend contracts, and
[release checks and known limitations](docs/releasing.md) before distributing a build.
RUNE is licensed under [MIT](LICENSE).
