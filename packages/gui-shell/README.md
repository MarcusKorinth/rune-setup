# @rune/gui-shell

The RUNE GUI shell: a planned Electron wizard whose main process will host `@rune/engine`
in-process and own the Session, while the renderer will be a pure renderer behind the
`contextBridge` IPC bridge — see [docs/architecture.md](../../docs/architecture.md) §9.

The package is private: it is never published to npm and never part of the `@rune/cli` package.
It will ship as prebuilt per-OS artifacts (`rune gui install`, `rune package`) under the MIT license
in [LICENSE](LICENSE).

The current package contains the source/package skeleton only. A usable Electron shell,
`rune gui install`, and GUI execution are planned for Milestone 3. The architecture above
describes the intended shell and IPC boundaries. See
[docs/roadmap.md](../../docs/roadmap.md).
