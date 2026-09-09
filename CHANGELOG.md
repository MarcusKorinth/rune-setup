# Changelog

## Unreleased

## 0.1.0

### Added

- YAML workflow loading, validation, input resolution, planning, and command execution.
- Interactive and non-interactive CLI modes, plus an Electron wizard using the same engine.
- Conditional inputs and steps, locale overlays, GUI themes, dry-run previews, logs,
  structured results, and cancellation.
- Windows x64 ZIP and Linux x64 tar.gz GUI runtimes with RUNE icons and product metadata.
- Portable workflow packaging with bundled scripts, payload, logos, CSS and translations.
  The packaged executable opens its workflow without a manifest argument or Node installation.

### Execution and delivery

- Process output uses backpressure and declared-secret masking across logs, terminal
  output and GUI events. Runs wait for accepted output and result delivery.
- Packaged Windows stdout is byte-exact; Linux probes and non-interactive runs do not
  require a display server.
- GUI downloads are built and checked on Windows and Linux before publication, with
  archive checksums, dependency metadata and the source commit recorded alongside them.

### Distribution scope

- Archives are unsigned and must be extracted before use. Linux requires Electron's
  system libraries and Chromium sandbox support.
- Workflow commands retain their own tool and permission requirements. RUNE does not
  provide elevation, rollback, uninstall, MSI/NSIS packages, or macOS support.
- Public npm packages are not part of this release; authors build the CLI from source.
