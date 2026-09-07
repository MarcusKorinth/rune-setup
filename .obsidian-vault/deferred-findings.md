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

## PR11-D001 — Define a deadline for the GUI shell version probe

- **Priority:** P2 (startup availability)
- **Affected components:** `packages/cli/src/guiCmd.ts`, GUI shell version handshake
- **Description:** A shell that starts but never closes can leave the version probe waiting
  indefinitely.
- **Reason for deferral:** A correct fix needs a documented timeout policy, child-tree cleanup,
  and deterministic error/result ownership. No timeout is part of the current §9.4 contract, and
  adding an arbitrary value in PR #11 would be hardening rather than completing its launch flow.
- **Risk:** `rune run --gui` can hang during startup when a corrupt shell override never answers
  the probe.
- **Recommended next step:** Define the handshake deadline and timeout exit/result contract, then
  add deterministic probe-timeout and cleanup tests on Windows and Linux.

## PR11-D002 — Make GUI cache promotion crash-consistent

- **Priority:** P2 (installation recovery)
- **Affected components:** `packages/cli/src/guiCmd.ts`, per-user GUI shell cache
- **Description:** A hard process or power failure between moving the current cache to its backup
  and promoting staging can leave no live target, although the backup still exists.
- **Reason for deferral:** Crash recovery requires a transaction/recovery policy or immutable
  versioned targets plus a pointer. That is broader than the PR's atomic error-path fix and belongs
  with M4 release engineering.
- **Risk:** An interrupted replacement can make a previously working cached shell appear
  uninstalled until repaired.
- **Recommended next step:** Choose a recovery model, recover orphaned backups at install/launch,
  and test injected crashes plus concurrent installers.

## PR11-D003 — Add GUI shell cancellation readiness signaling

- **Priority:** P2 (startup cancellation)
- **Affected components:** `packages/cli/src/guiCmd.ts`, `packages/gui-shell/src/main/index.ts`
- **Description:** On POSIX, a forwarded SIGTERM can arrive after the workflow shell process is
  spawned but before its JavaScript SIGTERM relay is installed, allowing default process
  termination and a resultless exit 70.
- **Reason for deferral:** Closing the race reliably needs an explicit parent/child readiness
  handshake; a delay or earlier listener merely narrows it. Introducing that protocol now would
  be disproportionate hardening for PR #11.
- **Risk:** A cancellation issued in the narrow startup window can be reported as an internal
  shell crash instead of cancellation 6.
- **Recommended next step:** Add a private readiness token or channel, buffer parent cancellation
  until the shell acknowledges its relay, and test the pre-ack and post-ack paths on Windows and
  Linux.
