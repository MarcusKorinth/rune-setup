# Local workspace example

This workflow creates a small configuration in a directory you choose. It runs on Windows
and Linux with Node.js 24 LTS on `PATH`. It needs no administrator rights, network
connection, or additional software installation.

Run these commands from the repository root. In a source checkout, first run `npm ci` and
`npm run build`, then replace `rune` below with `node packages/cli/dist/main.js`.

```text
rune validate examples/basic/installer.yaml
rune run examples/basic/installer.yaml --dry-run
rune run examples/basic/installer.yaml --non-interactive --result examples/basic/output/result.json
```

Validation checks the manifest without running its steps. Dry-run displays the actual planned
commands. The third command runs both steps with their defaults and creates:

| File | Contents |
| --- | --- |
| `examples/basic/output/configuration.json` | The selected profile, initially `development` |
| `examples/basic/output/NOTES.txt` | The supplied note |
| `examples/basic/output/setup.log` | Execution progress and the scripts' output |
| `examples/basic/output/result.json` | The run status, exit code, inputs, and step results |

The script writes only the selected profile and note. There are no credentials or secret
inputs in this example, and the script never dumps the process environment. Re-running replaces
the generated configuration and notes files and appends to the log. Disabling notes skips that
step; it does not delete an existing notes file.

To use the interactive CLI, omit `--non-interactive`. The summary lets you change the output
directory, profile, and notes choice before execution. `note` is enabled only when
`includeNotes` is true; the same condition determines whether the notes step runs.

```text
rune run examples/basic/installer.yaml --non-interactive --set profile=production --set includeNotes=false --result examples/basic/output/result.json
```

Change the destination with `--set "outputDirectory=/your/writable/path"` on Linux or
`--set "outputDirectory=C:\your\writable\path"` on Windows. Use an absolute path for an
unambiguous destination. The example's log remains next to its manifest under `output/`;
override it with `--log-file PATH`. The `--result` path is relative to the caller's working
directory. Configuration and notes paths are passed as individual command arguments; profile
and note values are passed through explicit environment entries. No shell interprets them.

When a GUI shell is available, `rune run examples/basic/installer.yaml --gui` opens the same
workflow as a wizard. See the repository README for the source-checkout GUI instructions.
