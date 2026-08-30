# @rune/engine

The RUNE engine: manifest loading and validation, value resolution, interpolation and
conditions, planning, execution, results. It is a library — the `rune` CLI and the GUI
shell's main process drive it through the `Session` facade described in
[docs/architecture.md](../../docs/architecture.md).

The current engine implements the manifest pipeline and `Session` facade: loading and
validation, value resolution, interpolation and conditions, planning, execution, logs and
results, JSON Schema generation, and dry-run support. Interactive frontend layers are
added by later milestones. See [docs/roadmap.md](../../docs/roadmap.md).
