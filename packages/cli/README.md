# RUNE CLI

The CLI validates and runs YAML setup workflows. Public npm delivery is being prepared;
the current package name `@rune/cli` is occupied by an unrelated public package.

## Development usage

Build from the repository root with `npm ci --ignore-scripts` and `npm run build`. Until release
installation is available, invoke `node packages/cli/dist/main.js` as shown below.
An installed CLI uses the command name `rune`.

```bash
node packages/cli/dist/main.js validate examples/basic/installer.yaml
node packages/cli/dist/main.js run examples/basic/installer.yaml --dry-run
node packages/cli/dist/main.js run examples/basic/installer.yaml
node packages/cli/dist/main.js run examples/basic/installer.yaml --non-interactive --set profile=production --result examples/basic/output/result.json
```

The [basic example](https://github.com/MarcusKorinth/rune-setup/blob/957862b27e6c79fa88f1a6bd03dd95c4bf68ac0e/examples/basic/README.md) explains its inputs and output.
Interactive runs show the plan and allow input changes before execution. Without a
TTY, the CLI does not prompt; missing required inputs cause an input error.

## Supply inputs

Values are resolved from manifest defaults, then values files, `RUNE_INPUT_<ID>`
environment variables, repeated `--set key=value` flags, and interactive answers.
Later sources override earlier ones. Input IDs are uppercased in environment names.
For example, `RUNE_INPUT_PROFILE=production` supplies the example's `profile` input.

A values file is a flat YAML mapping:

```yaml
profile: production
includeNotes: false
```

Pass it with `--values path/to/values.yaml`; later values files override earlier ones.
Use declared `secret` inputs for sensitive values, preferably supplied through the
environment or values files. Arguments can be visible in process listings. Pass secrets
to commands through explicit environment entries instead of argv. Direct `${env.NAME}`
references are not registered as secrets. Read the [security boundaries](https://github.com/MarcusKorinth/rune-setup/blob/main/SECURITY.md)
for masking limits, including exact machine fields that remain visible in results.

## Inspect results and schemas

Use `--result path/to/result.json` for a structured result, or `--result -` to send
only result JSON to stdout. Human progress and diagnostics go to stderr. `--log-file`
overrides the manifest's log destination; for a real run, result and log paths must differ.
A dry-run may write its result to the configured log path because it opens no log.

```bash
node packages/cli/dist/main.js schema --output manifest.schema.json
node packages/cli/dist/main.js schema --result --output result.schema.json
```

| Exit code | Meaning |
|---|---|
| 0 | Successful run, validation, schema output, or dry-run |
| 1 | Execution or result delivery failed |
| 2 | Invalid invocation or unsupported platform |
| 3 | Invalid manifest |
| 4 | Missing or invalid input |
| 5 | Resolution or condition error |
| 6 | Cancelled |
| 70 | Internal or host failure |

For GUI development, follow the [wizard instructions](https://github.com/MarcusKorinth/rune-setup/blob/957862b27e6c79fa88f1a6bd03dd95c4bf68ac0e/README.md#try-the-wizard).
With `--gui`, the optional `--result` accepts a file path; `--result -` is unavailable.
Local shell archives can be built from the repository. `rune package` combines an extracted
shell with a workflow for distribution; see [workflow packaging](https://github.com/MarcusKorinth/rune-setup/blob/main/docs/packaging.md).
The first public downloads remain outstanding. See the [release checklist](https://github.com/MarcusKorinth/rune-setup/blob/main/docs/releasing.md).

## Process output and background services

RUNE waits for a step's process to exit and for both output streams to close. A background
service that inherits those streams keeps the step pending even after its launcher exits.
Redirect the service's stdout and stderr, or configure `timeoutSeconds` on the command
when the workflow needs a time limit. Cancellation remains available while waiting.

Slow log files or terminals apply backpressure to the process pipes. Complete accepted
lines are delivered before the run finishes; a configured timeout includes time spent
waiting for output. Individual lines longer than 64 KiB are replaced by a fixed omission
message so a process cannot force unbounded buffering with one unterminated line.
