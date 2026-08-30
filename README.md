# RUNE

*Declarative setup workflows for GUI, CLI and CI/CD*

> **One manifest. Guided or automated.**

**RUNE** ("Runtime for User Guided and Non Interactive Execution") is an open source
declarative installer and setup workflow engine. Define inputs, conditions and
executable steps in a single YAML file, then run the same workflow through a graphical
installer, the command line or a CI/CD pipeline.

## Status

RUNE's **v0.1 core (Milestones 0–2)** is implemented: the engine,
validation/schema and non-interactive execution, the interactive CLI, the `Session` facade,
and the mode-parity contract suite. [docs/roadmap.md](docs/roadmap.md) tracks the remaining
MVP scope and what comes after. The Milestone 3 GUI shell and its `rune gui install` /
`rune run --gui` commands are planned, not currently implemented.

Engine, CLI and GUI shell are TypeScript. Authors and CI need **Node 22 LTS** and
install the CLI with `npm install -g @rune/cli` (or run it via `npx @rune/cli`); end
users of a packaged installer need nothing installed.

## The idea

One configuration, three operating modes with identical execution semantics:

1. a graphical installation wizard
2. an interactive command line installer
3. a fully non-interactive run for CI/CD pipelines

```yaml
schemaVersion: 1

product:
  name: Example Application
  version: 1.0.0

inputs:
  installDirectory:
    type: directory
    title: Installation directory
    default: "${home}/example"

  installDatabase:
    type: boolean
    title: Install local database
    default: true

  databasePort:
    type: text
    title: Database port
    default: "5432"
    pattern: "[0-9]{2,5}"
    when: "${installDatabase}"      # greyed out / skipped unless the database is installed

steps:
  - id: install-application
    title: Install application
    run:
      windows:
        command: pwsh
        args: [-File, scripts/install.ps1, -Directory, "${installDirectory}"]
      linux:
        command: bash
        args: [scripts/install.sh, "${installDirectory}"]

  - id: install-database
    title: Install database
    when: "${installDatabase}"
    run:
      windows:
        command: pwsh
        args: [-File, scripts/install-database.ps1, -Port, "${databasePort}"]
      linux:
        command: bash
        args: [scripts/install-database.sh, "${databasePort}"]
```

The same manifest, three ways (the graphical mode is planned for Milestone 3):

```bash
rune run installer.yaml
```

```bash
rune run installer.yaml --gui
```

```bash
rune run installer.yaml --non-interactive --values pipeline-values.yaml --result result.json
```

## The planned graphical wizard (Milestone 3)

The planned wizard is a bundled, self-contained, Electron-based app. It will need nothing
installed on the target machine, run without admin rights, and look identical on every
platform because it ships its own rendering engine. Its main process will host the RUNE
engine in-process; its window will be a pure renderer that reaches the engine only through
an IPC bridge — all planning, validation and execution will happen in the engine, exactly
as in the two CLI modes.

- **Themeable** — set `gui.accentColor`, `gui.logo`, `gui.banner` or `gui.windowTitle`
  in the manifest, or point `gui.theme` at your own CSS file
- **Multi-language** — every user-visible text (titles, descriptions, option labels,
  wizard buttons) is overridable per locale via `locales/<lang>.yaml` files, selected
  with `--locale` / `RUNE_LOCALE`
- **Author tooling** — planned `rune gui install` will fetch the prebuilt shell for your OS
  into a per-user cache; `rune package` (roadmap milestone 4) will bundle shell, engine and
  manifest into one portable end-user artifact that needs nothing installed

## Design principles

- **Declarative** — one YAML manifest describes inputs, conditions and steps;
  installer authors write no code
- **Mode parity** — GUI, interactive CLI and CI/CD share one planner and one executor;
  frontends render, they never decide
- **Safe by default** — commands run as argv arrays, never through an implicit shell;
  no code evaluation; secrets are masked end-to-end
- **Automation-first** — every interactive input is also settable via `--set`,
  `RUNE_INPUT_*` environment variables or `--values` files; stable exit codes and a
  machine-readable result file
- **Extensible** — input types and runners sit behind small, defined seams; new
  capabilities land as new schema versions, never as silent reinterpretation

## Development

Requires Node 22 LTS. The repository is an npm-workspaces monorepo
(`packages/engine`, `packages/cli`, `packages/gui-shell`, cross-package suites in
`tests/`).

```bash
npm ci
```

The local gate is exactly what CI runs (`npm run format` fixes formatting):

```bash
npm run typecheck && npm run lint && npm run format:check && npm run depcruise && npm test
```

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). Start with
[docs/architecture.md](docs/architecture.md) — it is the canonical contract for
semantics and invariants.

## License

[MIT](LICENSE)
