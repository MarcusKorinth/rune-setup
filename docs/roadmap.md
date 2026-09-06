# Roadmap

Current state: **Milestones 0–2 / v0.1 core are complete and Milestone 3 is in progress**.
The engine, CLI, `Session` facade, interactive prompting/editing, mode-parity contract suite,
and Electron wizard shell are implemented. [architecture.md](architecture.md) is the binding
architectural contract; shell distribution and CLI-to-shell launching remain planned.

This roadmap orders the work so that the non-interactive driver — the mode-parity
anchor — exists first, and every later frontend is verified against it.

Milestones map to indicative product versions (SemVer, independent of the manifest
`schemaVersion`, which stays `1` throughout): M0–M2 → **0.1.0**, M3 → **0.2.0**,
M4 → **0.3.0**. **The MVP is Milestones 0–3 (product 0.2.0)**; Milestone 4 is a
committed core milestone beyond the MVP.

## Milestone 0 — repository bootstrap

- [x] license (MIT)
- [x] contributing guide, `.gitignore`
- [x] architecture contract (`docs/architecture.md`)
- [x] npm workspaces monorepo (`packages/engine`, `packages/cli`, `packages/gui-shell`,
  cross-package `tests/`), `tsconfig.base.json` (TypeScript 5.x strict:
  `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`), eslint
  (+ `@typescript-eslint`, static-safety rules), prettier, vitest,
  dependency-cruiser import boundaries
- [x] CI skeleton: typecheck, eslint, vitest on Windows and Linux with Node 22 LTS
  (no Electron in core jobs)

## Milestone 1 — engine core and non-interactive execution (→ 0.1.0, complete)

The complete pipeline behind `rune validate`, `rune schema` and
`rune run --non-interactive` — the `@rune/engine` library plus the `rune` CLI binary:

- manifest loader (`yaml` core schema, a source-order-stable duplicate-key walk with
  `uniqueKeys: false`, SourceMap from node ranges) and zod v1 schema (`.strict()` objects,
  discriminated unions) with located, understandable error messages
- `rune schema [--output] [--result]` — manifest and result-file JSON Schema generated
  from the zod schemas via built-in `z.toJSONSchema()` (editor autocompletion, no drift)
- the seven input types behind the input-type registry; `pattern`/`patternHint` on
  `text`; select/multiselect options as plain strings or `{value, label}` pairs;
  multiselect comma-split with JSON-array escape hatch
- five-layer value resolution with provenance (layers 1–4 delivered here:
  `defaults < values files < env < --set`; layer 5 interactive answers use
  `Session.setValue`; the GUI client is delivered by the Milestone 3 shell)
- conditional inputs (`when:` on inputs, same typed grammar as steps, acyclicity rule,
  disabled ⇒ empty value, ignored supplied values with warning + provenance)
- `${...}` interpolation and the typed `when:` condition language; `--platform`
  preview placeholders
- i18n resolution layer: `locales/<lang>.yaml` overlays, built-in English chrome
  catalogue (`rune.*`), `--locale` > `RUNE_LOCALE` > system, per-key fallback;
  engine-owned `getStrings()`
- planner (frozen `ExecutionPlan`), sequential async executor, step lifecycle states
- spawn runner (`child_process.spawn`, argv-only, `shell: false`, streamed
  line-split output, timeout, process-tree kill: POSIX process group / Windows
  `taskkill /T /F`)
- secret wrapping (`SecretString`), `SecretRegistry`, masking at every sink
- exit-code table (`exitCodeFor`), atomic versioned result file (step counters,
  `nothingExecuted`, masked `outputTail` for failed steps), log file
- `commander`-based CLI (`exitOverride()`, RUNE-owned exit codes and stderr format)
- `rune validate` environment-variable audit report
- `--dry-run` rendering the real plan object

Exit criterion: a CI pipeline can run a fixture manifest end to end on Windows and
Linux with correct exit codes, result file and masked logs.

## Milestone 2 — interactive CLI and frozen frontend contract (→ 0.1.0, complete)

The interactive CLI, frozen `Session` facade, and cross-client contract suite are delivered.

- prompts for still-missing, enabled inputs (Node `readline`, muted-echo helper for
  secrets — no prompt library), re-prompt on validation/pattern error; option labels
  displayed, values accepted
- plan summary with **edit loop** (`Proceed / Change value <n> / Cancel`), progress
  rendering off the event stream; localized chrome via `getStrings()`
- cancellation via `Ctrl+C` (CancelToken; second `Ctrl+C` force-exits)
- **`Session` facade frozen as the frontend contract**: the facade methods
  (`open/pendingInputs/allInputs/warnings/setValue/plan/describe/execute/cancel/getStrings/getThemeConfig`)
  plus `EngineObserver` events and the observer delivery contract — the surface every
  frontend, including the Electron main process, drives 1:1
- **in-process parity client**: a scripted client of the `Session` facade making
  exactly the calls the GUI shell's main process makes (the GUI leg of the parity
  suite)
- **mode-parity contract suite** (non-interactive, scripted interactive CLI fed from a
  stream, in-process parity client) runs in core CI on Windows and Linux from here on —
  no Electron needed

## Milestone 3 — GUI wizard: Electron shell (→ 0.2.0)

- [x] Electron GUI shell (`packages/gui-shell/`, TypeScript + HTML/CSS): **main** hosts
  `@rune/engine` in-process (owns the `Session`, IPC handlers, window, exit code);
  **preload** exposes the **IPC bridge** via `contextBridge` — a 1:1 projection of the
  `Session` facade and events, secrets masked towards the renderer; **renderer** is a
  pure sandboxed renderer (`contextIsolation: true`, `nodeIntegration: false`, `sandbox: true`): pages Welcome,
  generated input pages, Summary, Progress, Result; greyed-out disabled inputs flipping
  live, red pattern state, cancel flow, named `RuneError` display, shell-crash → exit
  70
- [x] **default theme**: modern, polished, animated, light/dark, built on CSS custom
  properties
- [x] **theming layers**: manifest `gui:` block (`accentColor`, `logo`, `banner`, `theme`,
  `windowTitle`) and author CSS loaded after the default theme
- [ ] `rune gui install` — prebuilt shell per OS from GitHub Releases into the per-user
  cache (no admin; the CLI npm package contains no Electron); `rune run --gui`
  launches it and forwards its exit code, or exits 2 with the hint when unavailable
- [x] IPC-bridge unit test pinning the preload API as a 1:1 projection of the facade
- [x] dedicated shell CI lane: Playwright-for-Electron smoke suite (rendering, theming,
  cancel, crash handling, headless run)
- [x] **mode-parity suite as release gate**: identical plans, event sequences and results
  across all three frontends (GUI leg = in-process parity client)

## Milestone 4 — `rune package`: self-contained end-user artifact (→ 0.3.0, core roadmap, beyond MVP)

- `rune package installer.yaml` produces a portable, per-user-runnable folder/archive
  (Windows: portable `.exe` + folder or zip; Linux: AppImage or tar.gz) via
  **electron-builder**, containing the Electron shell with the engine as plain
  JavaScript inside the app bundle (one language, one bundler, no engine binary), the
  manifest, `scripts/`, `payload/`, `assets/`, `locales/`
- nothing to install, no admin rights, identical look; headless `--non-interactive`
  mode available from the same artifact (Electron started with CLI arguments runs the
  engine in main without a window)
- portability basis: `${manifestDir}` anchoring — the manifest is unchanged between
  `rune run` and the packaged run
- internals (layout, electron-builder configuration, per-platform format choice) are
  designed when this milestone starts (architecture §16)

## MVP success criteria (from the project spec)

A developer can:

1. create a YAML manifest
2. define inputs (incl. conditional and pattern-validated ones) and installation steps
   in it
3. launch PowerShell, shell scripts and executables
4. run the workflow through a polished graphical wizard
5. run the identical workflow fully non-interactively
6. set every input via the command line or a values file
7. get understandable logs and exit codes
8. use the run unchanged in a CI/CD pipeline
9. localize all user-visible text with overlay files, without touching the manifest

## Post-MVP candidates

Not committed, roughly in order of expected demand. Schema-visible features land as a
new `schemaVersion` — v1 rejects their keys loudly today (see architecture §13):

- schema v2 candidates: elevation, retries, step dependencies, step outputs
  (`${steps.*}`), license page, custom wizard pages
- single-executable CLI via Node SEA for runners without Node
- stdio JSON-RPC server projecting the `Session` facade for third-party
  (out-of-process) frontends
- structured JSONL event log as an additional sink
- GUI shell auto-update (architecture §16)
- rollback/undo steps, uninstall, repair, update
- downloads with checksum/signature verification
- parallel steps, restart management
- plugin system for input types, runners and frontends (npm packages discovered by
  naming convention or `package.json` field)
- additional built-in chrome languages beyond English
- macOS support

## Non-goals

RUNE is not a replacement for WiX, NSIS, Inno Setup or the Qt Installer Framework:
no MSI/EXE installer generation, no system integration, no transactional rollback, no
OS package formats, no code signing, no app-store publishing, no graphical manifest
editor. `rune package` produces a portable folder/archive, never a system-installed
package.
