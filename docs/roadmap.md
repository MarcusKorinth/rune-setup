# Distribution and release work

The source checkout already includes automated core, installed-package, and GUI archive
checks on Windows and Linux. The distribution work below is unimplemented or unpublished;
candidate checks must be repeated for each release. See the
[release acceptance checks](releasing.md) for the commands and required evidence.

## Distribution

- Choose an owner-controlled npm namespace and update package names, imports, metadata,
  and documentation. Verify installation of the engine and CLI in an empty consumer project.
- Publish verified Windows and Linux GUI archives for the chosen architectures. Local
  x64 builds include the runtime and application resources and have artifact checks.
- Verify the portable workflow packages for the release candidate, including manifest,
  scripts, payload, assets, and locales, without Node or repository sources.
- Connect verified CI artifacts to release publication once repository and npm ownership
  are settled.

## Checks for each candidate

- Verify the Node 24 LTS and Electron 44 runtime on the full platform matrix.
- Exercise the documented example through terminal, automated, and graphical runs.
- Review dependency advisories and test the installed packages, including failure and
  cancellation, result delivery, and declared-secret handling.

## Documentation for distribution

- Keep installation instructions executable against the released deliverables.
- Document manifest inputs, script requirements, values files, results, and practical
  troubleshooting using the example workflow.
- Keep architecture contracts and public compatibility guarantees consistent with the
  implementation. Record unresolved limitations before release.

## Later capabilities

Rollback, repair, uninstall, elevation, retries, dependencies between steps, and step
outputs need separate designs. They are not accepted by the current manifest schema.
macOS support and additional input or runner integrations are also undecided.
