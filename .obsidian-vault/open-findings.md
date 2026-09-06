# Open Findings

## PR8-O001 — Update the inherited fast-uri development dependency

- **Priority:** P3 (dependency maintenance; upstream advisories are rated high)
- **Affected components:** `package-lock.json`; development dependency chain
  `dependency-cruiser` → `ajv` → `fast-uri@3.1.5`
- **Description:** On 2026-09-05, `npm audit` reports four URL-normalization advisories for
  this installed version: [GHSA-5jgf-p345-68v8](https://github.com/advisories/GHSA-5jgf-p345-68v8),
  [GHSA-f65p-4m7j-42xc](https://github.com/advisories/GHSA-f65p-4m7j-42xc),
  [GHSA-fph4-wmhf-6fwf](https://github.com/advisories/GHSA-fph4-wmhf-6fwf), and
  [GHSA-jqff-g426-hqxp](https://github.com/advisories/GHSA-jqff-g426-hqxp).
- **Reason for separate work:** The same version is already present on PR #8's base,
  `d0675e1588d9fb30bc5b1d25e419052ff5b803d7`. Updating inherited development dependencies is
  outside the Session/non-interactive CLI slice.
- **Risk:** A consumer that uses affected URL normalization for outbound requests or host
  policy can misclassify a destination. No such RUNE runtime use was identified; this package
  is installed only through development tooling. The audit remains actionable maintenance,
  without evidence of an exploitable production path in this PR.
- **Recommended next step:** Update the lockfile to a compatible fixed release (3.1.6 or
  newer) in a separate dependency change, then run the standard Windows/Linux checks.

## PR11-O001 — Gate `rune.done` on a terminal outcome

- **Priority:** P1 (GUI lifecycle)
- **Affected components:** `packages/gui-shell/src/main/index.ts`, `rune:done` bridge lifecycle
- **Description:** The inherited `rune:done` handler closes the window without verifying that an
  execution outcome exists.
- **Reason for separate work:** Correcting the renderer trust boundary changes the base GUI
  lifecycle contract and needs coordinated main/renderer state tests outside PR #11's launch
  scope.
- **Risk:** A premature or compromised renderer can close the window and return 0 without a result
  while execution is absent or still active.
- **Recommended next step:** Gate `rune:done` on a delivered terminal outcome and add
  premature-done tests.

## PR11-O002 — Support stdout results in the packaged headless shell

- **Priority:** P1 (automation compatibility)
- **Affected components:** GUI shell headless delivery and argv parser
- **Description:** The direct headless shell hands `--result -` to the engine file writer, so it
  treats `-` as a filename instead of writing machine JSON to stdout.
- **Reason for separate work:** Direct packaged-shell operation belongs to the M4 artifact seam,
  while PR #11 implements CLI-driven GUI launch and rejects stdout for windowed runs.
- **Risk:** A packaged headless invocation can silently violate the documented stdout contract.
- **Recommended next step:** Share host delivery semantics with the CLI and test success, failure,
  and cancellation using stdout.

## PR11-O003 — Classify direct shell argv errors as usage errors

- **Priority:** P2 (exit-code compatibility)
- **Affected components:** GUI shell argv parser and process boundary
- **Description:** The direct shell parser throws generic errors that the process boundary maps to
  exit 70.
- **Reason for separate work:** Direct packaged-shell usage classification belongs to the M4
  artifact entry point rather than PR #11's CLI-owned argument validation.
- **Risk:** Malformed direct invocations are reported as internal errors instead of usage exit 2.
- **Recommended next step:** Use `UsageError` and `exitCodeFor` at the shell boundary and add an
  argv error table.

## PR11-O004 — Preserve structured errors across the GUI bridge

- **Priority:** P2 (bridge contract)
- **Affected components:** GUI main/preload bridge and renderer error handling
- **Description:** The bridge currently flattens a `RuneError` into an ordinary error message even
  though the architecture calls for code, message, location, and exit code.
- **Reason for separate work:** A tagged error envelope requires a coordinated main, preload, and
  renderer API change beyond PR #11's launch integration.
- **Risk:** Error code, exit code, and source location are lost or coupled to message parsing.
- **Recommended next step:** Define a JSON-safe tagged error envelope and test every `RuneError`
  class plus masking and unknown errors.

## PR11-O005 — Align dynamic GUI styling with the CSP

- **Priority:** P2 (GUI behavior)
- **Affected components:** `packages/gui-shell/src/renderer/index.html`, renderer theming and
  progress
- **Description:** The renderer creates a dynamic `<style>` rule and assigns inline progress
  widths while the CSP allows only `style-src 'self'`.
- **Reason for separate work:** The renderer and CSP are inherited from the GUI-shell base, and
  browser-level verification belongs to M4's real-Electron smoke lane.
- **Risk:** Chromium can block accent theming and progress width updates.
- **Recommended next step:** Choose a narrowly scoped nonce or CSS-only policy and verify computed
  styles in the Electron smoke suite.
