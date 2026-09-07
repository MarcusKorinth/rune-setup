# @rune/gui-shell

The RUNE GUI shell is an Electron wizard whose main process hosts `@rune/engine`
in-process and owns the Session, while the renderer is a pure renderer behind the
`contextBridge` IPC bridge — see [docs/architecture.md](../../docs/architecture.md) §9.

The package is private: it is never published to npm and never part of the `@rune/cli` package.
M4 release engineering will ship it as prebuilt per-OS artifacts consumed by
`rune gui install` and `rune package` under the MIT license in [LICENSE](../../LICENSE).

The package contains the working main, preload, renderer, default theme, unit tests, and
Playwright-for-Electron smoke suite. Build it with `npm run build` from the repository root and
run its smoke suite with `npm run test:smoke --workspace @rune/gui-shell`.

MVP (v0.1.0): milestones 0–3 complete. See [docs/roadmap.md](../../docs/roadmap.md).
