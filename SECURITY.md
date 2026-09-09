# Security

RUNE executes setup workflows supplied by their authors. It has no published supported
release line yet. Security fixes are made in the maintained development code; older
development snapshots do not have a backport commitment.

## Reporting

Do not publish suspected vulnerabilities, exploit details, or sensitive logs in public
issues. Once this repository is public, use **Report a vulnerability** on its
[Security tab](https://github.com/MarcusKorinth/rune-setup/security) to submit a private
report. Private vulnerability reporting must be enabled and verified when changing the
repository's visibility. Until then, collaborators can use the restricted issue tracker.

Include the affected commit or release, operating system, Node or Electron version,
expected impact, and a minimal reproduction with sensitive values replaced. Never
include live credentials.

Response and fix times are best-effort; there is no guaranteed response deadline.

## Trust boundaries

- A manifest and its scripts are trusted executable content. They run commands with
  the permissions of the user running RUNE. Validation rejects invalid configuration;
  it does not inspect script behavior or restrict filesystem and network access.
- Commands use argv arrays without an implicit shell. An explicitly invoked interpreter
  still executes the script or command it receives. Only run workflows you trust.
- Input values, process output, and filesystem failures can contain sensitive data.
  The engine owns validation and masking; frontends render its projections. The GUI
  renderer is sandboxed and reaches the engine through an isolated preload bridge.
- Text patterns are authored code. They use ECMAScript regular expressions without
  an evaluation timeout; avoid nested quantifiers such as `(a+)+`.
- GUI cache integrity checks detect incomplete or damaged sealed cache generations.
  Legacy unsealed caches remain supported without an integrity guarantee. These checks
  do not authenticate a publisher or make an untrusted download safe. Current archives
  are unsigned; release authentication and signing must be settled before distribution.

## Credentials and output

Declare credentials as `secret` inputs. Supply them with `RUNE_INPUT_<ID>` or a values
file whose access you control, and pass them to commands through explicit environment
entries. Arguments may be visible in process listings. Values read directly through
`${env.NAME}` are not registered as secrets.

Masking matches registered text, including supported multiline and path spellings.
It is not a guarantee that arbitrary transformed secrets are hidden: base64, hashes,
or transformations performed by a script may not match. Secrets with empty content or
content lines shorter than four characters after trimming cannot be reliably masked;
the run warns about these values.

Machine identity fields intentionally stay exact. Manifest paths, identifiers, locale,
product identity, and other fields enumerated in the
[masking contract](docs/architecture.md#logging-and-secret-masking) can therefore contain
text equal to a declared secret. This includes result files and `--result -` output.
Avoid placing credentials in workflow paths or identity fields, and review results
and logs before sharing them. Application code using the engine must preserve its
projection and result-delivery contracts rather than serialize internal objects.

## Security maintenance

Review dependency and source-analysis findings before merging or distributing a
candidate. High and critical findings must be fixed or accompanied by a specific,
reviewable non-exploitability assessment; assess other findings for the affected
execution paths. A passing scan is evidence for that commit and advisory database,
not a permanent absence of vulnerabilities. Follow the
[release verification checks](docs/releasing.md#build-and-verification) for the exact
candidate and its artifacts.

The [security checks](scripts/security/README.md) document the current scanners,
their scope, and how to review and update the pinned rules.

Report masking bypasses outside the documented exceptions, violations of frontend
isolation, or command/argument changes caused by input handling as security defects.
An intentionally authored command's behavior and the documented lack of transactional
rollback are workflow responsibilities, not isolation guarantees RUNE provides.
