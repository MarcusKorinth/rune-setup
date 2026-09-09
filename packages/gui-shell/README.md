# GUI shell

The Electron main process hosts the engine and owns the Session. The sandboxed renderer
uses the preload bridge for values, plans, events, and results; it performs no engine work.

From the repository root, with Node 24 LTS:

```bash
npm ci --ignore-scripts
npm run prepare:electron --workspace @rune/gui-shell
npm run build
```

Set `RUNE_GUI_SHELL` to the absolute path of `packages/gui-shell`, then run:

```bash
node packages/cli/dist/main.js run examples/basic/installer.yaml --gui
```

The [root README](../../README.md#try-the-wizard) includes platform-specific environment
commands. Run the real Electron tests with
`npm run test:smoke --workspace @rune/gui-shell`; Linux needs a display or `xvfb-run`.

This package is private. `npm run build:shell` at the repository root creates a host x64
archive under `output/shell/`, including Electron, the engine, compiled JavaScript, and
HTML/CSS. The build uses the production dependency versions and integrity values from
the repository lockfile. `npm run test:shell:package` checks a freshly extracted copy.
The Linux archive's launcher selects a display-free runtime for non-interactive runs
and version probes. Graphical runs still need a display, and both modes need the
[documented system libraries and sandbox support](../../docs/releasing.md#runtime-prerequisites).

Builds use RUNE artwork and are unsigned. To distribute a configured workflow with
its scripts and design, follow [workflow packaging](../../docs/packaging.md).
Public release delivery follows [release acceptance](../../docs/releasing.md).

Bridge failures preserve `code`, `message`, `location`, and `exitCode` as plain data.
The renderer displays the main-composed `displayText` verbatim. Stacks and causes remain
in main; unknown failures use a fixed RUNE-500 / exit 70 diagnostic.
The [architecture](../../docs/architecture.md#92-electron-ipc-bridge-main--renderer)
defines transport, masking, lifecycle, and error ownership.

Licensed under [MIT](LICENSE).
