# Deferred Findings

## F025 — Define observer backpressure policy

- **Priority:** P3 (performance and operational resilience)
- **Affected components:** `EngineObserver`, child-output delivery, CLI rendering, log sinks,
  and the future GUI bridge
- **Description:** Run events are deliberately synchronous and in order. Output producers and
  observer callbacks currently have no explicit bounded-queue, drop, or backpressure policy.
  A sustained child-output rate above a frontend sink's throughput can therefore grow host-side
  buffering.
- **Reason for deferral:** A correct fix changes the shared frontend contract and requires one
  explicit product decision between producer backpressure, bounded buffering, and a documented
  drop/coalescing policy. Adding an ad hoc queue in PR #8 would expand its Session/non-interactive
  CLI scope and risk mode-parity drift.
- **Risk:** Very high-volume child output can increase memory use or responsiveness pressure in a
  slow host even though execution correctness and output ordering remain intact.
- **Recommended next step:** Decide the event-delivery/backpressure contract in
  `docs/architecture.md`, then implement it once in the engine-facing boundary with bounded
  output-flood tests covering CLI, log-file finalization, and the future IPC projection.

## F026 — Decide when a step settles if a descendant holds its stdio

- **Priority:** P2 (run lifetime and automation contract)
- **Affected components:** `SpawnRunner` normal settlement path, `Executor` step loop, the
  `§8` line-splitting and `§10` log/`outputTail` completeness guarantees
- **Description:** `SpawnRunner` settles an ordinary step from the child's `close` event, which
  Node emits only once the process has ended **and** every inherited stdio stream is closed. A
  step whose process exits normally after handing its stdout/stderr to a detached descendant
  (a service starter, a daemon that does not redirect its streams) therefore leaves the runner
  pending: no `StepFinished`, no result file, no exit code, for as long as the descendant lives.
  With the default `timeoutSeconds: null` no kill path bounds it. The termination path already
  releases those ends after its bounded wait; the ordinary path has no equivalent rule.
- **Reason for deferral:** `docs/architecture.md` §8 states that the runner awaits "the process
  exit and the stream ends", so the current behaviour is the documented design and matches
  ordinary subprocess semantics. Changing it means deciding a new contract: settling on `exit`
  plus a bounded stream grace period can truncate output that the §8 line-splitting and the §10
  log and `outputTail` guarantees promise to deliver whole. That trade-off is a product decision,
  and the settlement listener is pre-existing runner code untouched by the session/CLI slice.
- **Risk:** An installer step that starts a background service without redirecting its stdio
  stalls the run instead of completing it, and an author sees it only as a step that never
  finishes. A declared `timeoutSeconds` bounds it today; nothing else does.
- **Recommended next step:** Decide in `docs/architecture.md` §8 whether an ordinary step settles
  at process exit with a bounded stream grace period, and what happens to output still in flight
  when that period expires. Then implement it once in the runner beside the existing termination
  release, with tests covering a descendant that inherits the pipes on both platforms and a case
  that proves no complete line is lost.
