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
