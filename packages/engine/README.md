# @rune/engine

The RUNE engine: manifest loading and validation, value resolution, interpolation and
conditions, planning, execution, results. It is a library — the `rune` CLI and the GUI
shell's main process drive it through the `Session` facade described in
[docs/architecture.md](../../docs/architecture.md).

Milestones 0–2 / v0.1 core are implemented: engine functionality including validation,
schema generation, non-interactive execution, interactive-session support, and the frozen
`Session` facade. See [docs/roadmap.md](../../docs/roadmap.md).
