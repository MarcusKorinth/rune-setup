# Changelog

## Unreleased

### Available in development builds

- YAML workflow loading, validation, input resolution, planning, and command execution.
- Interactive and non-interactive CLI modes, plus an Electron wizard using the same engine.
- Conditional inputs and steps, locale overlays, GUI themes, dry-run previews, logs,
  structured results, and cancellation.

### Changed

- Preserve error codes, messages, source locations, and exit codes across the GUI bridge.
- Move development and execution to Node 24 LTS and a supported Electron release;
  update the test and lint tools within compatible supported versions.
- Apply backpressure across process pipes, log files, terminal output, and GUI events;
  wait for accepted output before settling a run.
- Bound GUI version probes and prevent implicit Electron downloads during startup.
- Coordinate Linux GUI startup so early cancellation preserves its result and exit code.
- Route native application-quit requests through cancellation and await result delivery.
- Publish GUI-cache updates as complete generations with an atomic selection, preserving
  the usable shell through interrupted or concurrent installations.
- Add a runnable setup example and verify installed engine/CLI tarballs in CI.
- Rebuild npm package output from a clean state so deleted-source artifacts cannot ship.
- Build host GUI shell archives with locked runtime dependencies and verify freshly
  extracted applications, including execution without Node on the command search path.
- Start packaged Linux non-interactive runs and version probes without a display server.
- Package workflows with the GUI runtime, preserving scripts, payload, local design
  resources, and translations; start the bundled workflow without a manifest argument.
- Replace incorrect public npm installation instructions with development usage and
  concrete distribution requirements.

Public npm package delivery and GUI archive publication remain unfinished. See
[remaining work](docs/roadmap.md) and [release checks](docs/releasing.md).
