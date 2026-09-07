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
## PR10-O001 — Preserve arbitrary values through the Windows Electron launcher

- **Priority:** P2 (future launcher compatibility)
- **Affected components:** Planned `rune run --gui` invocation construction and packaged
  shell/headless entry points; Electron's native Windows bootstrap.
- **Description:** Electron 39.8.10 rejects a URL-like argument followed by other arguments
  before application JavaScript starts. A value such as `summaryBoundary=failed: 0` triggers
  this rule and can terminate with Windows code `4294967295`, without a RUNE diagnostic or
  result. This was reproduced while constructing a direct Electron smoke invocation.
  See the versioned [argument guard](https://github.com/electron/electron/blob/v39.8.10/shell/app/command_line_args.cc#L18-L49)
  and [Windows entry point](https://github.com/electron/electron/blob/v39.8.10/shell/app/electron_main_win.cc#L209-L218).
- **Reason for separate work:** CLI-to-shell argument forwarding and packaged entry points
  are explicitly outside PR #10's wizard implementation. The runtime guard executes before
  the shell can handle an error; changing or disabling it is not appropriate here. The GUI
  accepts these values through ordinary answers, and values files avoid this native argument
  interpretation.
- **Risk:** A future launcher that forwards arbitrary input values without a supported
  argument boundary can fail before the engine opens, violating expected exit/result handling.
- **Recommended next step:** When implementing the launcher, place application arguments
  behind Electron's supported `--` boundary and account for it at each entry point. Add a
  real Windows test with colon-bearing values followed by further arguments, for windowed
  and headless launches. Retain Electron's native security checks.
