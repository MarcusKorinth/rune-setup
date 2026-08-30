# @rune/gui-shell

The RUNE GUI shell is a planned Electron wizard whose main process will host `@rune/engine`
in-process and own the Session, while the renderer will be a pure renderer behind the
`contextBridge` IPC bridge — see [docs/architecture.md](../../docs/architecture.md) §9.

The package is private: it is never published to npm and never part of the `@rune/cli` package.
It will ship as prebuilt per-OS artifacts (`rune gui install`, `rune package`) under the MIT license
in [LICENSE](LICENSE).

Milestone 3 is planned; this package is currently a skeleton. See
[docs/roadmap.md](../../docs/roadmap.md).
