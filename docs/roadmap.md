# Remaining work

This list describes unfinished user workflows and their
[release acceptance checks](releasing.md).

## Distribution

- Choose an owner-controlled npm namespace and update package names, imports, metadata,
  and documentation. Verify installation of the engine and CLI in an empty consumer project.
- Publish verified Windows and Linux GUI archives for the chosen architectures. Local
  x64 builds include the runtime and application resources and have artifact checks.
- Implement portable workflow packaging: include the manifest, scripts, payload, assets,
  and locale overlays, then run the artifact on a machine without Node or repository sources.
- Connect verified CI artifacts to release publication once repository and npm ownership
  are settled.

## Reliability and usability

- Verify the Node 24 LTS and Electron 44 runtime on the full platform matrix.
- Exercise the documented example through terminal, automated, and graphical runs.
- Review dependency advisories and test the installed packages, including failure and
  cancellation, result delivery, and declared-secret handling.

## Documentation

- Keep installation instructions executable against the released deliverables.
- Document manifest inputs, script requirements, values files, results, and practical
  troubleshooting using the example workflow.
- Keep architecture contracts and public compatibility guarantees consistent with the
  implementation. Record unresolved limitations before release.

## Later capabilities

Rollback, repair, uninstall, elevation, retries, dependencies between steps, and step
outputs need separate designs. They are not accepted by the current manifest schema.
macOS support and additional input or runner integrations are also undecided.
