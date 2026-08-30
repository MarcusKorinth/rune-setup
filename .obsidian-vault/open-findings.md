# Open Findings

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
