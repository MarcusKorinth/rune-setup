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

## OOS-002 — Unsafe integer literals in conditions

- **Priority / category:** P2 correctness/data integrity.
- **Affected component:** The existing condition-language tokenizer and evaluator, used by
  manifest validation and input resolution now, and later by step planning.
- **Description:** Integer literals are accepted at arbitrary length and converted to JavaScript
  `number` values. Distinct literals outside the safe-integer range can therefore round to the
  same value, causing comparisons to produce incorrect results.
- **Code evidence:** `packages/engine/src/engine/conditions.ts:209` calls
  `Number.parseInt(number[0], 10)` without checking
  `Number.MIN_SAFE_INTEGER..Number.MAX_SAFE_INTEGER` or retaining an exact integer form.
- **Why out of scope:** This is a pre-existing condition-language range limitation, not
  introduced by the current input and secret-handling work. Fixing it requires an explicit
  language choice: reject unsafe literals or introduce exact integer representation.
- **Risk:** A condition comparing adjacent large positive or negative literals may evaluate as
  equal when the source literals differ, changing whether a step or input is selected.
- **Recommended next step:** Resolve the integer semantics in a dedicated condition-language
  change and update the architecture contract. Add tests at both safe-integer boundaries and for
  adjacent large positive and negative literals in step and input conditions.
