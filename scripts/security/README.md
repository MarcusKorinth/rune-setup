# Security checks

The Security workflow runs for every pull request, main-branch push, and weekly.
`npm audit --audit-level=high` checks the complete locked dependency tree, including
development tools, and fails for high or critical advisories. Lower-severity findings
remain visible for triage. Network or registry failures also fail the job.

Static analysis uses Semgrep's community engine with the upstream JavaScript and
TypeScript rules. The workflow pins the rule repository commit; the Dockerfile pins
the scanner image digest. Dependabot proposes weekly npm, action, and scanner-image
updates. Review the rule repository pin alongside scanner updates; it is not updated
automatically. Review rule changes and run the scan before changing that pin.

The scanner runs without network access, credentials, telemetry, or source upload.
It checks engine, CLI, GUI, build scripts, and examples, including `.mjs` files. Semgrep
applies `--scan-unknown-extensions` to explicit file targets only, so the GUI preload
`.cts` file is also passed explicitly. Tests, generated output, and third-party sources
are outside this scan.
Findings and scan errors fail the job; its JSON report is retained as a CI artifact.
Investigate findings rather than adding broad exclusions or silently ignoring errors.

To reproduce the static check locally, follow the `static-analysis` job in
[security.yml](../../.github/workflows/security.yml): check out its exact rule commit,
build the Dockerfile with that checkout as the build context, then run the same
offline scan command. Docker is required only for this security check.

These checks run in private repositories without GitHub Code Security or a scanner
service account. GitHub-native scanning and dependency-review integrations may be
added when the destination repository supports them.
