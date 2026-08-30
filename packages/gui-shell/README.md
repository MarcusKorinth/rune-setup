# @rune/gui-shell

The RUNE GUI shell: an Electron wizard whose main process hosts `@rune/engine` in-process and
owns the Session, while the renderer is a pure renderer behind the `contextBridge` IPC bridge —
see [docs/architecture.md](../../docs/architecture.md) §9.

The package is private: it is never published to npm and never part of the `@rune/cli` package.
The Milestone 3 shell and `rune gui install`, followed by Milestone 4 `rune package`, are
planned; they are not currently implemented.

Milestones 0–2 / v0.1 core are implemented elsewhere; this package remains a Milestone 3
placeholder. See [docs/roadmap.md](../../docs/roadmap.md).
