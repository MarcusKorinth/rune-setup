# @rune/gui-shell

The RUNE GUI shell: an Electron wizard whose main process hosts `@rune/engine` in-process and
owns the Session, while the renderer is a pure renderer behind the `contextBridge` IPC bridge —
see [docs/architecture.md](../../docs/architecture.md) §9.

The package is private: it is never published to npm and never part of the `@rune/cli` package.
It ships as prebuilt per-OS artifacts (`rune gui install`, `rune package`) under the MIT license
in [LICENSE](LICENSE).

Milestone 0: package skeleton only. See [docs/roadmap.md](../../docs/roadmap.md).
