# @rune/gui-shell

The RUNE GUI shell is an Electron wizard whose main process hosts `@rune/engine`
in-process and owns the Session, while the renderer is a pure renderer behind the
`contextBridge` IPC bridge — see [docs/architecture.md](../../docs/architecture.md) §9.

The package is private: it is never published to npm and never part of the `@rune/cli` package.
M4 release engineering will ship it as prebuilt per-OS artifacts (`rune gui install`,
`rune package`) under the MIT license in [LICENSE](LICENSE).

MVP (v0.1.0): milestones 0–3 complete. See [docs/roadmap.md](../../docs/roadmap.md).
