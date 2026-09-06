# RUNE

*Declarative setup workflows for GUI, CLI and CI/CD*

> **One manifest. Guided or automated.**

**RUNE** ("Runtime for User Guided and Non Interactive Execution") is an open source
declarative installer and setup workflow engine. Define inputs, conditions and
executable steps in a single YAML file, then run the same workflow through a graphical
installer, the command line or a CI/CD pipeline.

## Status

RUNE's **v0.1 core (Milestones 0–2)** and the Milestone 3 Electron wizard shell are
implemented: the engine, validation and schema commands, both CLI modes, the `Session`
facade, mode-parity suite, sandboxed renderer, theme, and cross-platform shell smoke tests.
Shell distribution through `rune gui install`, CLI launching through `rune run --gui`, and
packaging remain planned in the [roadmap](docs/roadmap.md); the binding contract is documented
in [docs/architecture.md](docs/architecture.md).

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

Text `pattern` values are manifest-authored ECMAScript regular expressions. Values checked
against them are capped at 4 KiB, but regex execution has no timeout; avoid ambiguous or nested
quantifiers such as `(a+)+`.

The same manifest, three ways (CLI launching of the shell is still being wired):

```bash
# Guided on a TTY; non-interactive fallback when stdin is not a TTY
rune run installer.yaml
```

```bash
# Planned CLI integration:
# rune run installer.yaml --gui
```

```bash
rune run installer.yaml --non-interactive --values pipeline-values.yaml --result result.json
```

## The graphical wizard shell (Milestone 3)

The repository currently provides an Electron development shell for the wizard. Its main
process hosts the RUNE engine in-process; its window is a pure renderer that reaches the
engine only through an IPC bridge — all planning, validation and execution happen in the
engine, exactly as in the two CLI modes. A planned packaging target is a self-contained
end-user artifact that needs nothing installed, runs without admin rights, and renders
identically on every platform because it ships its own rendering engine.

- **Themeable** — set `gui.accentColor`, `gui.logo`, `gui.banner` or `gui.windowTitle`
  in the manifest, or point `gui.theme` at your own CSS file
- **Multi-language** — every user-visible text (titles, descriptions, option labels,
  wizard buttons) is overridable per locale via `locales/<lang>.yaml` files, selected
  with `--locale` / `RUNE_LOCALE`
- **Author tooling** — remaining Milestone 3 work includes `rune gui install`, which will
  fetch the prebuilt shell for your OS into a per-user cache; `rune package` (roadmap
  milestone 4) will bundle shell, engine and manifest into one portable end-user artifact
  that needs nothing installed

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

The core local gate mirrors the core CI job (`npm run format` fixes formatting):

```bash
npm run typecheck && npm run lint && npm run format:check && npm run depcruise && npm test
```

The Electron CI lane additionally runs `npm run build` and
`npm run test:smoke --workspace @rune/gui-shell` on Windows and Linux.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). Start with
[docs/architecture.md](docs/architecture.md) — it is the canonical contract for
semantics and invariants.

## License

[MIT](LICENSE)
