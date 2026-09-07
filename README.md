# RUNE

RUNE runs setup workflows described in YAML. A workflow defines inputs and commands;
the engine executes it through an interactive terminal, a non-interactive command,
or an Electron wizard. Authors provide the scripts and payload their setup needs.

## Project status

The engine, CLI, and wizard run from a development checkout. Engine/CLI tarballs and
GUI shell archives can be built locally. Registry publication, downloadable releases,
and portable workflow packaging remain unfinished.

RUNE targets Windows and Linux. Development uses Node 24 LTS and
Electron 44; use the checked-in `.nvmrc` for the current
checkout. The public npm name `@rune/cli` belongs to another project, so RUNE's
publication namespace must be settled before registry installation is documented.

See the [remaining work](docs/roadmap.md) and [release acceptance criteria](docs/releasing.md).

## Try the example

From the repository root:

```bash
npm ci
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

The wizard supports conditional inputs, localized text, and themes. `rune gui install`
expects published release archives; these are not yet available. `rune package` is not
implemented.

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

## Development

The npm workspace contains `packages/engine`, `packages/cli`, and `packages/gui-shell`.
For core work without the Electron binary, install with `npm ci --ignore-scripts`.
GUI work also requires the explicit `prepare:electron` command above.

```bash
npm run typecheck
npm run lint
npm run format:check
npm run depcruise
npm test
npm run test:packages
```

The shell also has a Playwright smoke suite:
`npm run test:smoke --workspace @rune/gui-shell`.
Linux CI runs it under `xvfb-run --auto-servernum`.

See [CONTRIBUTING.md](CONTRIBUTING.md) for contributions,
[architecture](docs/architecture.md) for engine and frontend contracts, and
[release checks and known limitations](docs/releasing.md) before distributing a build.
RUNE is licensed under [MIT](LICENSE).
