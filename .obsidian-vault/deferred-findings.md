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
