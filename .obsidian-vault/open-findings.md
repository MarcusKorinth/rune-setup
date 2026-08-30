# Open Findings

## OOS-001 — Secret fragments in planned command representations

- **Priority / category:** Security; high risk once the planner/runner is implemented,
  currently unreachable because those components do not yet exist.
- **Planned components:** Planner interpolation and the spawn runner, including the
  `ResolvedCommand` representation and preview/serialization paths.
- **Description:** Interpolating a value that mixes literal text with a secret reference
  (for example, `prefix-${token}`) must preserve which fragment is secret. A plain string
  result would lose the `SecretString` wrapper while constructing the command field. The
  architecture contract requires secret-wrapped `ResolvedCommand` fields, masking during
  preview and serialization, and revealing secret text only immediately at spawn.
- **Evidence:** `docs/architecture.md` §7 requires the plan to carry secret-wrapped command
  fields and §8 requires reveal only at spawn. Planner and runner components are not present
  in the current implementation, so no reachable product path currently exhibits this risk.
- **Why out of scope:** Implementing fragment-aware interpolation or choosing its planner and
  runner representation would be a later design decision and would expand the current input
  and secret-handling scope.
- **Risk:** Once planner/runner work begins, mixed literal-and-secret values in argv, `env`,
  `cwd`, or `command` could be exposed in previews, serialized results, logs, or process
  arguments if their sensitivity is flattened to an ordinary string.
- **Recommended next step:** During planner/runner implementation, design a fragment-aware
  secret-preserving representation and keep masking at preview/serialization boundaries;
  reveal only at the final spawn boundary. Add tests covering mixed literal + secret values in
  argv, `env`, `cwd`, and `command`, preview/serialization masking, and reveal only at spawn.
