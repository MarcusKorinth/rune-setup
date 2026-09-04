# Architecture

This document is the canonical architectural contract for **RUNE** ("Runtime for User Guided and Non Interactive Execution") — a declarative installer and setup-workflow engine written in TypeScript.

It is written current-state: decisions, boundaries, and invariants. Engine, CLI, and GUI shell: **TypeScript 5.x in strict mode** (`"strict": true`, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`) on **Node 22 LTS**; one **npm workspaces** monorepo (`packages/engine`, `packages/cli`, `packages/gui-shell`, cross-package `tests/`); vitest, eslint (+ `@typescript-eslint`), prettier. The GUI shell (§9.4) is an Electron application whose main process hosts the engine in-process — one language, one runtime. MIT license.

## 1) Purpose and boundary

RUNE executes a single YAML manifest describing inputs and executable steps through three frontends — GUI wizard, interactive CLI, and non-interactive CI/CD driver — with **identical execution semantics** in all three (mode parity).

Core principle: **the engine is the single source of truth; frontends render, they never decide**.

### In scope (MVP)

- YAML manifest with versioned schema (`schemaVersion: 1`), validation with source-located, understandable error messages; `rune schema` emits the manifest and result-file JSON Schemas for editor integration
- Input types: `text`, `secret`, `boolean`, `select`, `multiselect`, `file`, `directory`; conditional inputs (`when:` on inputs); `pattern`/`patternHint` on `text`; select/multiselect options as plain strings or `{value, label}` pairs
- Steps executing argv commands (PowerShell, bash/shell, executables, arbitrary CLI programs) with args, env, cwd, timeout, and exit-code success criteria
- `${...}` interpolation, safe `when:` conditions, platform-specific run blocks (`windows` / `linux`)
- Localization (i18n): every user-visible manifest text and RUNE's own UI strings are overridable per locale through `locales/<lang>.yaml` overlay files; the engine resolves text for all frontends (§6.3)
- Fail-fast (default) or continue-on-error execution; log file; structured `result.json` (with step counters and a masked output tail for failed steps); deterministic cross-platform exit codes
- `rune validate` (incl. an environment-variable audit report) and `rune run --dry-run` reusing the one execution pipeline
- Secret masking in all logs, previews, and results; no shell interpretation; no code eval
- GUI wizard as an Electron shell with a bundled rendering engine (pixel-identical everywhere, no system webview, no admin rights), whose main process hosts the engine in-process and whose renderer drives it exclusively through the IPC bridge (§9.2); manifest `gui:` theming block (milestone 3, §9.4)

### Core roadmap milestone (not MVP, not out of scope)

- **`rune package`** (milestone 4): a self-contained, portable, per-user-runnable end-user artifact containing the GUI shell with the engine as plain JavaScript inside the app bundle, the manifest, `scripts/`, `payload/`, `assets/`, and `locales/` — nothing to install first, no admin rights, identical look on every supported machine. The contract is fixed in §9.5; the internals are designed when the milestone starts (§16).

### Out of scope (MVP — seams are left, nothing is built)

Rollback/undo, uninstall, repair, update, downloads/checksums, restart management, elevation, retries, parallel steps, inter-step dependencies, step outputs feeding later steps, custom wizard pages, license pages, plugin system, script/payload embedding beyond what `rune package` copies, MSI/EXE installers, config-editor GUI.

The v1 schema **rejects** these keys — including `execution.elevation` — with an explicit *"reserved; accepted in a later schemaVersion"* error rather than silently ignoring them. Consequence: the spec's own §5 example manifest (`elevation: auto`) fails v1 validation; the published example is amended in the same release. Loud rejection is deliberate: silently tolerated keys today would change meaning when the feature lands.

### Non-goals

RUNE is not a replacement for WiX, NSIS, Inno Setup, or the Qt Installer Framework. No MSI/EXE installer generation, no system integration, no transactional rollback, no OS package formats, no code signing, no app-store publishing. `rune package` produces a portable folder/archive, never a system-installed package.

### Versioning

`schemaVersion` (manifest, currently `1`), `resultSchemaVersion` (result file, currently `2`), and the **product version** (SemVer, starting at 0.1.0) are independent. Roadmap milestones map to indicative product versions: M0+M1+M2 → 0.1.0 (engine library, `validate`/`schema`, non-interactive, interactive CLI, `Session` facade frozen as the frontend contract, i18n resolution), M3 → 0.2.0 (Electron GUI shell + theming), M4 → 0.3.0 (`rune package` self-contained end-user artifact). **The MVP is milestones 0–3 (product 0.2.0)** — the spec's success criteria include the graphical wizard; milestone 4 is a committed core milestone beyond the MVP. The manifest stays `schemaVersion: 1` throughout.

## 2) Core principles (short contracts)

1. **Declarative.** One YAML file describes inputs, conditions, and steps. RUNE interprets it; installer authors write no code.
2. **Mode parity.** GUI, interactive CLI, and CI/CD share one Planner and one Executor. Frontends can only (a) supply input values and (b) render engine events and engine-resolved strings. Behavior not expressible through those two channels does not ship. The GUI shell hosts the engine in its Electron main process; its renderer reaches the engine only through the IPC bridge — a 1:1 projection of the same `Session` facade every other frontend uses.
3. **Safe by default.** argv arrays only, never `shell: true`; YAML parsed with the core schema only (no custom tags, no code execution); interpolation is single-pass string substitution, never evaluation; conditions use a closed hand-written grammar, never `eval` or `new Function`; secrets are wrapped and masked end-to-end.
4. **Automation-first.** Every interactive input is settable via `--set`, `RUNE_INPUT_*` env vars, or `--values` files. RUNE never blocks a pipeline: no TTY means non-interactive behavior. Exit codes and the result file are stable machine contracts.
5. **Extensible via defined seams.** Input types and the runner sit behind small registries/interfaces. New capabilities land as new `schemaVersion`s, never as silent reinterpretation of v1 manifests.

## 3) System overview

```
installer.yaml ──▶ manifest/loader ──▶ manifest/v1 schema + rules ──▶ Manifest (frozen)
locales/<lang>.yaml ──▶ i18n/locale ──▶ overlay ──▶ strings ──▶ StringTable (engine-owned)
                                                                        │
--values / RUNE_INPUT_* / --set / answers ──▶ engine/inputs ──▶ ResolvedInputs (+provenance,
                                                                 input when: evaluated)
                                                                        │
                                        engine/plan ──▶ ExecutionPlan (static: conditions
                                                        evaluated, argv interpolated, once)
                                                                        │
                engine/executor ──▶ runners/spawnRunner ──▶ child_process.spawn(cmd, args, { shell: false })
                                                                        │
                              engine/events ──▶ packages/cli (interactive / non-interactive renderer)
                                          ├──▶ packages/gui-shell/src/main (Electron main, hosts @rune/engine in-process)
                                          │         ──IPC bridge (preload, contextBridge)──▶ src/renderer (pure renderer)
                                          └──▶ log file + results/writer
```

Engine, CLI, and GUI shell live in one repository and one language: `@rune/engine` (the library, `packages/engine`), `rune` (the CLI, `packages/cli`), and the Electron GUI shell (`packages/gui-shell`). Dependency directions (enforced by an import-boundary test, §14):

- `@rune/engine` — `manifest`, `inputs`, `i18n`, `engine`, `runners`, `results`, `logs`, `errors` — never imports `cli` or `gui-shell`. It is a plain library: no CLI parsing, no Electron, no process-global side effects.
- `cli` imports the engine only through its public API (`Session`, the event types (the `RunEvent` union and its per-kind members), `errors`, the value types the facade returns — `ExecutionPlan`, `RunResult`, `InputState`, `ValueSource`, `StringTable`, `ThemeConfig` — plus `formatSessionTerminalLine` for authenticated terminal projection, `validateManifest()` and `formatLocation` for `validate` — the report's `.warnings` are the value-free manifest warnings and its `.environment` is the audit report — `manifestJsonSchema()`/`resultJsonSchema()` for `rune schema`, and `serializeResult`/`writeResult` (§10)) and drives it exclusively through the `Session` facade plus one observer interface (`EngineObserver`).
- `gui-shell/src/main` (Electron main process) imports `@rune/engine` the same way the CLI does and hosts it in-process; `gui-shell/src/preload` exposes the IPC bridge (§9.2) — a 1:1 projection of that same facade and event stream — through `contextBridge`; `gui-shell/src/renderer` never imports the engine (only the bridge's type declarations) and never reads the manifest, `locales/`, or values files itself. There is no GUI-only engine surface and no engine sidecar process: the engine package never depends on the shell, and core, CLI, and CI never see Electron.
- Everything downstream of the `ExecutionPlan` is frontend-agnostic; dry-run is "build the plan, render it, stop" — by construction, what dry-run shows is what run would execute.

## 4) Manifest contract

### 4.1 Canonical CLI verbs

The spec conflicts between §6 (`rune install`) and §13 (`rune run`). Decision: **`run` is canonical; there is no `install` alias.** RUNE's own subtitle promises setup workflows, not only installation; `run` is truthful for dev-env bootstrap and CI jobs. One spelling in docs, scripts, and CI. The manifest path is positional.

```
rune validate installer.yaml [--locale TAG]
rune run installer.yaml [--gui] [--non-interactive] [--dry-run]
                        [--set key=value]... [--values file.yaml]...
                        [--result path|-] [--log-file path] [--locale TAG]
                        [--platform windows|linux]     # dry-run only
rune schema [--output FILE] [--result]   # manifest JSON Schema (v1); --result: result-file schema
rune gui install                         # author-time: fetch the prebuilt GUI shell into the per-user cache
rune package installer.yaml              # milestone 4: self-contained end-user artifact (§9.5)
rune --version
```

The current CLI implements `validate`, `schema`, and the non-interactive and dry-run forms
of `run`. Until Milestone 2 adds prompting and the edit loop, every current `rune run`
invocation uses the non-interactive path regardless of TTY state or whether
`--non-interactive` is supplied. `--gui`, `gui install`, and `package` remain planned at
their roadmap milestones.

Mode selection: default is interactive CLI on a TTY; `--gui` is explicit opt-in (if the GUI shell is not present in the per-user cache, exit 2 with the hint to run `rune gui install`); `--non-interactive` never prompts. If a prompt would be needed and stdin is **not** a TTY, RUNE auto-degrades to non-interactive (§10). GUI is never auto-selected — an auto-popping window in an SSH session is a surprise, not a feature. `--platform` is accepted only with `rune run --dry-run`; real execution refuses it. `--gui` combines with neither `--non-interactive` nor `--dry-run` — both combinations are usage errors (exit 2); dry-run always renders through the CLI renderer. `--gui` also refuses `--result -` (usage error, exit 2) — by policy: a GUI run carries no stdout contract (a windowed Electron process may emit its own diagnostics and stdout attachment differs per OS, and the stderr pass-through of §10 is best-effort diagnostics, not a machine contract); use `--result path`, which the engine writes exactly as in every other mode (§9.4).

For a real run, a non-stdout `--result` destination must differ from the effective log-file
destination after both have been anchored to absolute paths. An exact collision is a usage error
(exit 2), rejected after planning exposes the effective `--log-file` / `execution.logFile` path
but before execution or either sink is opened. Comparison is case-insensitive on Windows and
case-sensitive on Linux. Dry-run may write its result to the configured log path because it never
opens the log, and `--result -` remains valid.

`rune schema` prints the JSON Schema of manifest `schemaVersion: 1` to stdout (or `--output FILE`), **generated from the zod schemas** (zod's built-in `z.toJSONSchema()`, in its `input` view so that fields with defaults stay optional for the author) at call time so it can never drift from what `validate` enforces; `--result` emits the result-file schema (`resultSchemaVersion: 2`) instead. `--output FILE` creates the directory the file lives in; a destination that cannot be written is a usage error (exit 2) naming the path and the errno code, never the raw OS message. Intended consumers are YAML language servers (autocompletion, inline errors); the same generated schema is what §14's schema tests pin.

`--locale TAG` selects the display locale for every text RUNE renders (§6.3) and takes precedence over `RUNE_LOCALE` and the system locale. It is accepted by `validate` and by `run` in all three modes; `rune run --gui` forwards it to the shell's session.

### 4.2 Top-level schema (v1)

| Key | Type | Notes |
|---|---|---|
| `schemaVersion` | integer, required | Read from the raw mapping **before** model validation; dispatched through a version registry (`{1: manifest.v1.parse}`). Missing or unsupported → exit 3 with an upgrade hint. |
| `product` | mapping, required | `name` and `version` are required, `description` is optional (and localizable, §6.3) |
| `inputs` | mapping of id → InputSpec | discriminated on `type`; ids match `[A-Za-z_][A-Za-z0-9_]*`, must not collide with built-ins; declaration order is evaluation and prompting order |
| `steps` | list of Step, required | `id` (unique, `[a-z][a-z0-9-]*`), `title` (localizable), optional `when`, `run`. The key must be present; an empty list is legal and simply produces `nothingExecuted: true` (§7) |
| `execution` | mapping | `failFast: boolean = true`, `logFile: non-empty string` — nothing else in v1 |
| `gui` | mapping, optional | presentation-only: `accentColor: string` (CSS color), `logo: string` (window/taskbar icon + header logo), `banner: string`, `theme: string` (CSS file), `windowTitle: string` (localizable). Paths are relative to `${manifestDir}`, not interpolable; `rune validate` and `rune run --gui` check that the referenced files exist — `run` without `--gui` never touches them, so a missing logo can never fail a CI run. Read by the GUI shell through `getThemeConfig` (§9.1, §9.2); **ignored by interactive CLI and non-interactive** — no parity impact (§9.4) |

**InputSpec fields.** Common to all seven types:

| Field | Type | Notes |
|---|---|---|
| `type` | string, required | discriminator: `text \| secret \| boolean \| select \| multiselect \| file \| directory` |
| `title` | string | human-readable label used by prompts and GUI pages; defaults to the input id; localizable |
| `description` | string | optional help text; frontends render it, the engine ignores it (except for localization); localizable |
| `required` | boolean = `true` | `true` ⇒ a value must be present after the layer merge (§5) or the run fails (exit 4); `false` ⇒ an unset input resolves to its type's empty value (below) |
| `default` | type-dependent | layer-1 value (§5): string for `text`/`file`/`directory` (may reference built-ins and `${env.*}` only — no input references; rendered once in the resolution stage, §6.1), boolean for `boolean`, string for `select`, string[] for `multiselect`; forbidden on `secret` (§4.3) |
| `when` | string | optional condition in the `when:` grammar of §6.2 — the **same** grammar steps use. A false condition makes the input **disabled** (§5): not required, never prompted, resolves to its type's empty value, greyed out in the GUI. May reference built-ins and only inputs declared **earlier** in the manifest (acyclicity, §6.2); a forward or self reference is a validate-time error |

Type-specific:

| Field | Applies to | Type | Notes |
|---|---|---|---|
| `options` | `select`, `multiselect` | list, required, non-empty | each item is either a plain string (`value` == `label`) or a mapping `{value: string, label: string}`; values unique. **`value` is the membership authority**: `default`, every supplied value, `--set`, env, values files, and scripts use `value`; GUI and CLI prompts *display* `label`. Labels are localizable (`inputs.<id>.options.<value>.label`, §6.3) |
| `pattern` | `text` | string | optional regex, ECMAScript `RegExp` syntax (compiled by Node's `RegExp`, `u` flag), **full-match** against the resolved value (RUNE anchors the pattern itself; authors write the bare pattern); not allowed on `secret` (a mismatch message would leak structure of a secret) |
| `patternHint` | `text` | string | optional message shown when `pattern` does not match; localizable |

**Text `pattern` guardrails.** The validated value is length-capped at 4 KiB (the same cap as conditions); a longer value fails before any regex runs. Patterns are authored by the manifest author — RUNE's **trusted-manifest model**: a manifest is code the author ships, not untrusted input — so there is no regex timeout; authors are warned in the user docs against nested quantifiers (`(a+)+`) as a ReDoS surface they own. Pattern validation is performed by the engine's input-type registry like every other check; frontends only display the result (§9, invariant 7). The dialect is ECMAScript (`RegExp`, `u` flag) and nothing else: constructs from other engines — e.g. Python's `(?P<name>…)` or `\Z` — are rejected at validate time (RUNE-104), so authors and the golden manifest tests pin one dialect.

**Empty values** (what an unrequired, unset — or disabled — input resolves to): `text`, `secret`, `file`, `directory` → the empty string `""`; `boolean` → `false`; `select` → `""`; `multiselect` → `[]`. Empty values are ordinary values of the declared type, so `when:` type checking (§6.2) is unaffected: an unset select still compares as a string (`${environment} == 'production'` is simply `false`), and `in` against an empty multiselect is `false`. Options-membership validation applies to `default` and to every explicitly supplied value; the engine-produced empty `""` / `[]` of an unrequired-unset or disabled select/multiselect is exempt from it — an *author-supplied* empty string is still checked against `options` and fails unless listed. There is no way to distinguish "unset" from "set to the empty value" downstream of resolution; authors who need that distinction add a sentinel option.

`run:` is either a single `CommandSpec` (all platforms) or a mapping keyed `windows` / `linux` (`macos` reserved). `CommandSpec`: `command: string` (required), `args: string[] = []`, `cwd: string` (default `${manifestDir}`), `env: Record<string, string> = {}` (merged over inherited environment), `timeoutSeconds: integer | null = null` (integer range `1..2,147,483`), `successExitCodes: integer[] = [0]`.

A platform mapping with no block for the current platform plans the step as **`SKIPPED` (reason: `no run block for platform`)** — the intended idiom for OS-specific steps, never an error. An empty mapping is a validation error.

**Locale overlays.** A manifest may be accompanied by `locales/<lang>.yaml` files in the `locales/` directory next to it (the spec's §10 project tree). They are not part of the manifest schema; each is a flat mapping of key path → string that overrides localizable manifest text and RUNE's own UI strings for one locale. Mechanism, key paths, and fallback rules are in §6.3.

### 4.3 Validation

The model layer uses **zod** schemas: `.strict()` objects (unknown keys rejected — the reject-unknown-keys posture for free) and discriminated unions (`InputSpec` on `type` via `z.discriminatedUnion`; `run:` as `CommandSpec | PlatformRunBlock`; `options` items as `string | OptionSpec`). Error presentation is owned by RUNE, not zod: `loader.ts` builds a `SourceMap` from the `yaml` document's node ranges (JSON path → `file:line:col`), and a presenter maps every zod issue path onto it and renders e.g. `installer.yaml:41:7: steps[2].run.windows.args must be a list of strings`, with did-you-mean suggestions (a small edit-distance helper) for unknown keys. Manifest keys are camelCase and so are the TypeScript fields — no alias layer. The same zod schemas are the source of `rune schema` (§4.1). Shape and semantics stay apart: the schemas describe shape only, and every cross-field rule lives in `rules.ts`, which keeps the generated JSON Schema a faithful description of what `validate` accepts.

Loader hardening: `yaml` (eemeli) with the **core schema only** — plain YAML, no custom tags, no code execution, and known tags left unresolved so an explicitly tagged YAML 1.1 value (`!!binary`, `!!timestamp`) is an error rather than a Buffer or a Date. Nothing may disappear from a document without a word: duplicate mapping keys, keys that are not plain non-empty scalars (the parser folds a collection key and an empty key into one stringified entry) and `__proto__` are all located errors. The parser's own `uniqueKeys` option is deliberately **off** — its per-key rescan is quadratic, so a flat one-megabyte mapping would cost tens of seconds and the size cap would bound nothing; the duplicates are found instead in the single walk that already records every document path. UTF-8 required; file-size cap. Locale overlays and values files go through the same loader.

Semantic rules (after model validation, all errors collected, not first-fail): unique step ids; select/multiselect `default` ⊆ option values; `secret` inputs may not declare `default`; every `${name}` reference resolves to a declared input or built-in (static check at `validate` time); every `when:` — on steps **and on inputs** — parses **and type-checks** against declared input types; an input's `when:` references only built-ins and inputs declared earlier (acyclicity; declaration order = evaluation order); `pattern` compiles as an ECMAScript `RegExp` — always with the `u` flag, here and wherever a supplied value is later matched against it, because the flags decide which patterns exist at all and a pattern accepted by `validate` but rejected at the prompt would break mode parity — and is absent on `secret`; a `patternHint` without a `pattern` is rejected (it could never be shown); `RUNE_INPUT_*` env-name collisions between two input ids are a validation error; every locale-overlay key addresses an existing localizable path of this manifest or a known `rune.` chrome key (an unknown key is a located error in the overlay file — invariant 12 applies to overlays too; `rune validate` loads and checks **every** `locales/*.yaml` file next to the manifest regardless of `--locale`, whereas `run` loads only the selected locale's overlay and its language-only fallback — a `--locale` with no matching overlay is not an error, every string simply falls back); a Windows drive-relative `execution.logFile` (`C:run.log`) is rejected (§10); a warning is emitted when a `secret` input is interpolated into `args` (argv is visible in OS process listings — `env:` is the recommended carrier).

**Environment-variable audit report.** `${env.NAME}` is freely readable — no allowlist. Because `${env.*}` references are static, `rune validate` can enumerate them exactly: its output ends with a section listing every environment variable the manifest reads, with the referencing locations (`installer.yaml:57:16  ${env.JAVA_HOME}`). Reviewers get the full list without grepping; the report is informational and never changes the exit code.

## 5) Value resolution

Five layers, lowest to highest; later layers override earlier ones per key. Computed in **one code path** (`engine/inputs.ts`) for all three frontends, with per-value provenance (`ValueSource`) recorded:

1. **Manifest defaults** — `inputs.<id>.default` (may reference built-ins and `${env.*}` only; no input-to-input references in v1; rendered once here, in the resolution stage, before prompting — §6.1)
2. **Values files** — `--values FILE`, repeatable; later files override earlier (base + overlay layering)
3. **Environment** — `RUNE_INPUT_<ID>` (id uppercased, non-alphanumerics → `_`)
4. **`--set key=value`** — repeatable; last occurrence wins
5. **Interactive answers** — CLI prompts and summary edit loop, or GUI pages

The resulting canonical resolution state is engine-internal and immutable at runtime: its arrays
and states are frozen, and its id lookup is a frozen `ReadonlyMap` view without mutation
operations. The lookup and `inputs` array represent the same frozen state objects in declaration
order. The separate public input projection is defined in §9.1.

Rationale — an explicitness gradient: each layer is more specific to *this invocation* than the one below. Env below `--set` matters operationally: a stray `RUNE_INPUT_*` in a CI image can never silently defeat an explicit flag in the pipeline script.

Values files (layer 2) are YAML documents parsed with the same hardened loader as manifests (§4.3): each file is a single **flat mapping of input id → value** — no nesting, no sections, no per-file metadata. Values may be written natively in the input's declared type — `boolean` as a YAML bool, `multiselect` as a YAML list of strings, everything else as a YAML string — or as strings, which take the same registry coercion path as layers 3–4. Any other shape (a mapping as a value, a list for a non-multiselect input, a non-string list item, a bare integer where a string is expected) is an input error naming the key, a safe shape or type category, and the file and position (exit 4, RUNE-202). The diagnostic never echoes the raw value: before the key is associated with its declared input type, that value may be a secret.

Coercion (layers 3–4 deliver strings) is owned by the input-type registry: booleans accept `true/false/1/0/yes/no` case-insensitive; select values are matched against option **values**, never labels; multiselect **comma-splits by default** and validates each item against option values — and if the string starts with `[`, it is instead parsed as a **JSON array of strings** (`--set tools='["a,b","c"]'`), the escape hatch for values containing commas; malformed JSON is an input error (exit 4, RUNE-202) and **never** falls back to comma-splitting; `text` values are full-matched against `pattern` when declared; file/directory stay strings (existence checks are the manifest author's concern via a step — frontends may *hint*, never enforce). Coercion or pattern failure names the key and source layer (exit 4). A non-secret value may be quoted only after registry masking; a secret value remains opaque. Unknown keys in `--set` or values files are **hard input errors**, never warnings — a typo that silently no-ops in automation is worse than a loud failure.

**Disabled inputs.** Input `when:` conditions are evaluated during resolution, in declaration order, against the values resolved so far (an input's condition can only see inputs declared before it, §6.2). An input whose condition is false is **disabled**: it is not required, it is never prompted, and it resolves to its type's empty value (§4.2). These semantics are identical in all three modes — the frontends differ only in rendering: the GUI shows the field greyed out (visible, not editable) and re-evaluates live when a controlling input changes (`InputStateChanged`, §9.1); the interactive CLI skips the prompt; non-interactive treats it as not required and raises no error if it is missing. If a value for an input that is disabled **once the input set is final** was supplied through any layer 2–5 (`--values`, env, `--set`, or an interactive answer given before a controlling input was changed), RUNE prints a **warning** on stderr, **ignores** the value, and records the input in the result file with the effective empty value, the `source` layer that supplied the ignored value, and `ignored: "input disabled"` (§10). The decision is taken at the end of resolution, not at first merge — an interactive edit that re-enables an input makes its seeded value effective again, with no spurious warning. This is deliberately not a hard error — CI matrices share values files across variants that enable different inputs — and deliberately not silent.

**What counts as an answer.** A `required` input is satisfied by a value, not by the absence of one dressed as a value: for `text`, `secret`, `select`, `file` and `directory` an empty string, and for `multiselect` an empty selection, leave the input *missing*. This is the shape of the CI mistake that matters — `RUNE_INPUT_TOKEN=` in a pipeline where the variable was never set expands to the empty string, and a required secret must not be satisfied by it. A `boolean` is never absent: `false` is an answer.

Interactive frontends prompt **only for still-missing, enabled inputs**, in declaration order, then show one summary before execution. Both interactive frontends allow layer-5 overrides of **any enabled input**, not only missing ones: the GUI pre-fills all fields from the seeded layers 1–4 and keeps them editable; the interactive CLI's summary is an **edit loop** — `Proceed / Change value <n> / Cancel` — so a seeded value can be replaced before anything runs (§9.3). An edit is an ordinary layer-5 answer with full provenance; changing a controlling input re-evaluates input `when:` for the inputs after it, and inputs that thereby become enabled and are still missing are prompted before the summary is shown again. A `pattern`-violating `text` value from layers 1–4 is reported where any other coercion failure is: non-interactive → exit 4 before any step runs; interactive CLI → treated as unanswered and prompted until valid; GUI → pre-filled, marked invalid, `Next` disabled. Execution starts only when the input set is complete and valid — which is what lets planning be a single phase in every mode.

## 6) Interpolation, condition, and text-resolution semantics

### 6.1 Interpolation (`${...}`)

Grammar: `${` NAME (`.` NAME)* `}` with NAME = `[A-Za-z_][A-Za-z0-9_]*`; dotted paths only for reserved namespaces. Escaping: `$${` renders a literal `${`; a lone `$` is literal; unterminated `${` is a validate-time error.

Resolvable names (flat scope; collisions rejected at validate):

- every declared input by id: `${installDirectory}` — a disabled input (§5) interpolates as its type's empty value
- built-ins: `${home}`, `${temp}`, `${platform}` (`windows`/`linux`), `${manifestDir}` (absolute directory of the manifest — the anchor for relative `command`, `cwd`, script paths, and `gui:` assets; the caller's cwd is deliberately **not** a built-in, for portability and for `rune package`, §9.5), `${product.name}`, `${product.version}`
- `${env.NAME}` — process environment, read-only, freely readable (no allowlist; `rune validate` prints the exact list of environment variables a manifest reads, §4.3); an undefined variable is an error (RUNE-301, exit 5) — raised in the resolution stage when referenced from an input `default`, at plan time everywhere else
- Reserved and rejected in v1: `${steps.*}` (future step outputs), `${rune.*}` (future engine variables)

Platform definitions: Node's `win32` maps to `windows` and `linux` maps to `linux`; every other host platform is rejected before planning with `PlatformError` (RUNE-002, exit 2) rather than being treated as Linux. `${home}` is `os.homedir()` (`USERPROFILE` on Windows, `HOME` on Linux); `${temp}` is `os.tmpdir()` (`%TEMP%` on Windows, usually `/tmp` on Linux). `${env.NAME}` lookup uses the host platform's `process.env` semantics — case-insensitive on Windows, case-sensitive on Linux; portable manifests must reference environment names in their exact POSIX casing.

**Foreign-platform preview (`--platform`).** When `rune run --dry-run` previews a platform other than the host, host-dependent built-ins render as visibly marked **placeholder tokens** — `<home@linux>`, `<temp@windows>` — rather than the host's real values, which would be lies about the target. The dry-run output states that the plan is a cross-platform preview, and the result file marks it (`"crossPlatformPreview": true` in the run block, §10). Placeholders never reach execution: real runs refuse `--platform` (§4.1).

Interpolable fields, exhaustively: `command`, each `args` item, `cwd`, `env` values, input `default`s, and variable references inside `when:`. Nothing else — in particular no `title`, `description`, `patternHint`, option labels, or `gui:` paths. String-context rendering stringifies (boolean → `true`/`false`; multiselect → comma-joined); inside `when:` a reference keeps its declared type.

**Resolution timing (load-bearing invariant):** interpolation of `command`/`args`/`cwd`/`env` and step `when:` evaluation happen **exactly once**, in the Planner, after all inputs are final and before any step runs — never at YAML load, never lazily during execution. Two things are evaluated earlier, in the resolution stage, because they decide what is prompted and prefilled — and both are final the moment the input set is frozen for planning: input `when:` (the one condition kind evaluated there) and input `default` interpolation (built-ins and `${env.*}` only, no input references; rendered once, before prompting, so the rendered default is what the GUI/CLI prefill and what layers 2–5 override; an undefined `${env.NAME}` in a default is RUNE-301, exit 5, at resolution). Resolution is single-pass: resolved values are never re-scanned for `${`, which closes injection-via-input-values. Consequence: the plan is fully static, dry-run shows byte-for-byte the argv `run` will spawn, and all three frontends plan identically.

### 6.2 Condition language (`when:`)

A closed, hand-written expression language: ~200-line tokenizer + recursive-descent parser in `engine/conditions.ts` producing a small AST. **No `eval`, no `new Function`, no template engine.** Expression length capped (4 KiB) and parse depth capped. One grammar, one evaluator, two sites: `steps[].when` and `inputs.<id>.when`.

```
expr    := or ;
or      := and { ("||" | "or") and } ;
and     := not { ("&&" | "and") not } ;
not     := ("!" | "not") not | cmp ;
cmp     := term [ ("==" | "!=") term | ["not"] "in" term ] ;
term    := "(" expr ")" | literal | varref ;
literal := "true" | "false" | integer | quoted-string ;
varref  := "${" NAME { "." NAME } "}" ;
```

Integer literals are decimal values in the inclusive safe range
`-9007199254740991..9007199254740991`; a literal outside that range is a validate-time error.

No functions, arithmetic, regex, attribute access, or indexing. **Typing is strict:** a bare `${x}` is valid only if `x` is a declared `boolean` (`when: "${installDatabase}"`). Strings and selects are never implicitly truthy — `when: "${environment}"` fails with the hint *compare explicitly: `${environment} == 'production'`*. `==`/`!=` require both sides same type; `in` tests string ∈ multiselect. Because input types are declared, **every condition type-checks at `rune validate` time with zero values supplied**. Loose truthiness must never ship in v1 — it could never be tightened later.

Absent `when:` ⇒ always eligible. On a step, a false condition plans the step as `SKIPPED` with reason `condition false: <expr>`. On an input, a false condition disables the input (§5).

**Acyclicity rule for input conditions.** An input's `when:` may reference built-ins and only inputs declared **earlier** in the manifest; declaration order is evaluation order, so there is nothing to sort and no cycle is expressible. A reference to the input itself or to a later input is a validate-time error (RUNE-104) naming both inputs — the fix is to reorder the declarations. Step conditions are unaffected: they may reference any input and are evaluated after all inputs are final.

### 6.3 Localization (text resolution)

Every user-visible manifest text is localizable; the text written in the manifest is the default and the fallback. The **engine owns** locale loading and text resolution — one source of truth, so GUI and CLI display identical text; frontends only render resolved strings.

**Localizable paths, exhaustively:** `product.description`, `inputs.<id>.title`, `inputs.<id>.description`, `inputs.<id>.patternHint`, `inputs.<id>.options.<value>.label`, `steps.<id>.title`, `gui.windowTitle`. The optional fallback-text paths `product.description`, `inputs.<id>.description`, `inputs.<id>.patternHint`, and `gui.windowTitle` exist only when the manifest declares that fallback text; input and step titles and option labels exist for every declared id or option value because they fall back to that id or value when the manifest omits display text. Everything else is not display text and is **never localized**: input ids, option values, step ids, `command`, `args`, `env`, `cwd`, file paths, `product.name`/`product.version` (identity; appear verbatim in results and logs), and every machine contract (RUNE-xxx codes, result-file keys and enum values, log prefixes).

**Mechanism.** Optional overlay files `locales/<lang>.yaml` next to the manifest, loaded with the hardened loader (§4.3). Each overlay is a **flat mapping** of JSON-path-like keys to strings:

```yaml
# locales/de.yaml
inputs.installDirectory.title: Installationsverzeichnis
inputs.environment.options.production.label: Produktivumgebung
steps.install-database.title: Datenbank installieren
rune.button.next: Weiter
```

RUNE's own UI strings ("chrome": wizard buttons such as Next/Back/Cancel/Install, page titles, prompt texts, the summary edit-loop menu, standard progress and result messages) ship as **built-in English defaults** inside RUNE (`packages/engine/src/i18n/`) and are overridable per locale from the same overlay files under the reserved **`rune.` prefix** (`rune.button.next`, `rune.prompt.proceed`, …). The built-in catalogue is the key authority; RUNE ships English built-ins only — every other language for chrome strings comes from the manifest author's overlays. Unknown keys — manifest paths that do not exist or `rune.` keys not in the catalogue — are located validation errors (§4.3).

**Locale selection:** `--locale TAG` > `RUNE_LOCALE` environment variable > system locale. Explicit values and overlay file names must be Unicode locale identifiers supported by Node's `Intl`; underscores are accepted as locale separators. `C` and `POSIX` explicitly select the built-in defaults; a non-empty `--locale` or `RUNE_LOCALE` choice therefore terminates the chain even when it selects those defaults. The system locale additionally has POSIX encoding and modifier suffixes removed before normalization (`de_DE.UTF-8` → `de-DE`); if no `locales/de-DE.yaml` exists, the language-only overlay `locales/de.yaml` is tried. The selected locale is recorded in the plan and result file; the built-in-default selection is represented there by an explicit JSON `null`, never by an omitted field.

`StringTable.locale` is the selected tag (`de-DE`, or `undefined` for the built-in defaults); `StringTable.overlayLocale` is the matched overlay file tag (`de`, or `undefined` when none matched) and may therefore be the language fallback.

Locale overlays and resolved string tables retain private provenance for the exact parsed manifest instance that produced them. Resolution rejects a foreign or structural-copy overlay, and planning rejects a foreign or structural-copy string table. An overlay may serve only the selected tag itself or its language-only fallback (`de-DE` may use `de`, while `de` may not use `de-DE`), so a session cannot accidentally combine manifests or locales.

**Fallback chain, per string:** requested locale overlay → the manifest's own text (for manifest strings) / the English built-in (for chrome strings). Fallback is per key, never per file: a partial overlay is valid and fills the gaps from the defaults.

**What the engine emits.** Localized titles are what appear in events (`StepStarted.title`), prompts, dry-run output, the GUI, and `result.json`; the result file additionally carries the never-localized input and step **ids**, so machine consumers never depend on a locale. `getStrings()` on the `Session` facade (§9.1) returns the fully resolved string table for the session's locale — the one table every frontend renders; there is no per-call locale, so no frontend can mix locales. Its accessors apply the session's current secret registry to their complete composed value. A terminal frontend additionally passes each complete human line and that exact table to the public `formatSessionTerminalLine(strings, line)` helper: the engine masks the raw line, visibly escapes terminal controls, and masks once more so the escape spelling itself cannot create a registered secret.

## 7) Execution model

One pipeline, shared by every verb and frontend, orchestrated by `Session`:

1. **load** — YAML → raw mapping + SourceMap; locale overlays — the selected locale's for `run`, all of `locales/` for `validate` (§6.3)
2. **validate** — model + semantic rules + static reference/condition type checks (steps and inputs) + overlay keys
3. **resolve inputs** — merge layers, evaluate input `when:` in declaration order, coerce and validate (incl. `pattern`), prompt if interactive; all-or-nothing before anything runs
4. **plan** — per step: select platform block → evaluate `when:` → interpolate → `PlannedStep`; yields a frozen `ExecutionPlan`
5. **execute** — Executor walks the plan sequentially
6. **report** — result file (counters, per-step results, output tails) + exit code

`rune validate` = stages 1–2 (fully static), followed by the environment-variable audit report (§4.3). `rune run --dry-run` = stages 1–4, rendering the plan (final argv with secrets masked, cwd, skip reasons, disabled inputs) and executing nothing. There is **no fake runner**: dry-run and run share the same plan object, so they cannot drift.

Planning can reject an execution spelling before an `ExecutionPlan` exists: an invalid native
Windows command root or drive-relative command (RUNE-401), an invalid native Windows `cwd`
(RUNE-404), or a batch command that requires an implicit shell (RUNE-405). A configured run
still reports this outcome, but it must not invent a step transition or publish a partial plan.

`ExecutionPlan` (deep-frozen, `readonly` types, versioned): `planSchemaVersion` (currently `1`), `manifestPath`, `manifestSha256`, `platform`, `locale` (selected tag, or `null` for the built-in defaults), `preview`, `resolvedInputs` (secrets wrapped; disabled inputs carry their empty value and state), `executionOptions`, `steps: readonly PlannedStep[]` in declaration order. `PlannedStep` carries the real `ResolvedCommand` (secret-wrapped argv, cwd, env delta, timeout, success codes); secret-derived values remain opaque `SecretString`s in the plan and are masked at sink boundaries — never a second "masked plan".

### Step lifecycle

States: `PENDING`, `SKIPPED`, `RUNNING`, `SUCCEEDED`, `FAILED`, `CANCELLED`, `NOT_RUN`. Legal transitions (all others illegal):

- `PENDING → RUNNING`
- `PENDING → NOT_RUN` (earlier failure under `failFast: true`, or abort before start)
- `RUNNING → SUCCEEDED` (exit code ∈ `successExitCodes`)
- `RUNNING → FAILED` (bad exit code, **timeout**, spawn failure — timeout is a step failure, not a distinct run outcome)
- `RUNNING → CANCELLED` (abort kills the process)

`SKIPPED` is assigned at plan time and is terminal-from-birth. Transitions are monotonic; every step reaches exactly one terminal state exactly once; at most one step is `RUNNING` (v1 is strictly sequential), and `RUNNING` is never published in a final result. With `failFast: false`, a `FAILED` step is recorded, the walk continues, and the run still ends failed (exit 1).

**Output tail.** While a step is `RUNNING`, the Executor keeps a bounded ring buffer of its last 50 combined stdout/stderr lines (each tagged with its stream, already masked — lines enter the buffer from the same masked stream the events carry). The fixed overlong-line placeholder from §8 counts as one line in this ring. If the step ends `FAILED` (including timeout), the buffer becomes the step's `outputTail` in the result file (§10); for `SUCCEEDED`, `SKIPPED`, `CANCELLED`, and `NOT_RUN` steps the buffer is discarded and no tail is written. Full output stays in the log file except that an overlong logical line is replaced wholesale by the §8 placeholder; the tail exists for CI triage from the result alone.

**Counters.** The run result carries `stepsTotal`, `stepsExecuted`, `stepsSucceeded`, `stepsFailed`, `stepsCancelled`, `stepsSkipped`, `stepsNotRun`, and `nothingExecuted` (true iff `stepsExecuted == 0`). `stepsExecuted` counts every step that entered `RUNNING`, so `stepsExecuted = stepsSucceeded + stepsFailed + stepsCancelled` and `stepsTotal = stepsExecuted + stepsSkipped + stepsNotRun` hold for every outcome (`stepsCancelled` is 0 or 1 in v1 — at most one step is `RUNNING`); the published result JSON Schema pins the structural form, while the runtime result validator/writer and §14's tests pin these arithmetic and step-array correlations. A run in which every step was skipped is a **success** (exit 0, `status: "succeeded"`) — skipping is the authored outcome of conditions and platform blocks — but it is marked: `nothingExecuted: true` and a warning on stderr, so a pipeline that considers "nothing happened" suspicious can branch on the result without RUNE guessing intent. The warning is emitted only for real runs (`dryRun: false`): in a `planned` result (§10) the counters describe the plan — `stepsSkipped` from plan-time `SKIPPED`, `stepsExecuted = 0` — so `nothingExecuted` is always `true` there and is not warned about.

A plan-time ExecutionError has no plan whose steps could be counted. Its failed result therefore
has `steps: []`, every step counter set to `0`, and `nothingExecuted: true`; it may have
`dryRun: false` or `dryRun: true`. No synthetic failed step or separate plan-failed step state
exists.

### Error taxonomy

Error class hierarchy in `packages/engine/src/errors.ts` (all extend `RuneError extends Error`); every error carries a `RUNE-xxx` code, message, and optional source `Location`:

```
RuneError
├── UsageError           RUNE-001 CLI misuse (incl. --gui without the GUI shell installed)
├── PlatformError        RUNE-002 unsupported host platform
├── ManifestError        RUNE-101 syntax, 102 schemaVersion, 103 schema, 104 semantic
│                        (incl. input-when acyclicity, overlay keys, pattern compile)
├── InputError           RUNE-201 missing, 202 invalid value (coercion, pattern mismatch,
│                        malformed JSON array), 203 unknown input
├── ResolutionError      RUNE-301 undefined variable, 302 interpolation syntax
├── ConditionError       RUNE-311 syntax, 312 type error
├── ExecutionError       RUNE-401 step exit code or unclassified execution failure,
│                        402 timeout, 403 command not found,
│                        404 invalid cwd, 405 shell-required refused, 406 operational
│                        log-file I/O (prepare/open/write/close), 407 operational
│                        result-file I/O (prepare/open/write/close/finalize)
├── CancelledError       RUNE-601 user/system abort
└── InternalError        RUNE-500 (always a RUNE bug; asks for an issue report)
```

### Cancellation

`CancelToken` is a small class around a boolean flag plus an `AbortSignal`-style listener list (`cancel()`, `isCancelled`, `onCancel(listener)`); the engine is `async`/`await` on the Node event loop, so cancellation is cooperative and needs no threads. One flow for all frontends (GUI Cancel button → `rune.cancel` over the IPC bridge → token, CLI first `Ctrl+C`, headless SIGTERM). The Executor checks the token between steps; a live child process gets the confirmed process-group/tree termination path of §8. After that operation the runner waits at most 5 s for the direct child's `close` event, so a missing event cannot leave execution pending; expiry preserves the original cancellation/timeout/stream-failure cause when tree termination was confirmed, but can never upgrade an unconfirmed termination. A confirmed interruption makes the step `CANCELLED`, remaining steps `NOT_RUN`, run status `cancelled`, exit 6. A runner that reports a non-success exit after cancellation was requested makes the step `CANCELLED` as well, with the same null exit code as a runner-reported cancellation. `SpawnRunner` never reports one: its kill path owns a requested cancellation and settles the step as `cancelled` or `terminationFailed`, so the rule only covers a runner that ignores the token. An exit the runner reported before the request stays `FAILED` — on Windows a console `Ctrl+C` also reaches the console-attached child (§8), and when the child's `close` is processed before RUNE's SIGINT handler fires, the step is `FAILED` with the child's `STATUS_CONTROL_C_EXIT` code and the run is `failed`, exit 1. If any earlier step is already `FAILED`, that failure takes precedence: the run stays `failed` with exit 1. A second `Ctrl+C` force-exits. Step **timeout reuses the same kill path** with terminal state `FAILED` (RUNE-402). An unconfirmed termination on either platform is instead the fatal `terminationFailed` contract from §8. If the GUI shell's window is closed during a run, the shell's main process calls `Session.cancel()` and awaits `RunFinished` before exiting — the same path, never a bare abort of the engine.

## 8) Runner layer

Exactly **one runner** in MVP: `runners/spawnRunner.ts` behind a minimal engine-internal
`Runner` interface (`run(SpawnRequest): Promise<SpawnOutcome>`). The interface and its
injection point are implementation/test seams inside the engine, not part of the package-root
API or `SessionOptions`. No public trusted-runner or secret-reveal capability ships in MVP;
that contract is decided only when the first real alternative runner is designed. No
per-interpreter runner classes (powershell/shell/cmd modules) — every MVP step is one argv
spawn, and interpreter-selection magic would reintroduce implicit command interpretation
against the spec's own security rule.

Process contract:

- `child_process.spawn(command, args, { shell: false, ... })` — argv arrays, never a shell; **async on the Node event loop** (the process exit and the stream ends are awaited; no worker threads, no blocking calls), so the engine never blocks whoever hosts it — the CLI or the Electron main process
- argv = interpolated `[command, ...args]`; relative `cwd` and commands containing a target path separator resolve against `${manifestDir}`, never the caller's cwd, while bare command names remain unchanged for ordinary `PATH` lookup. Target-absolute path values stay byte-identical; target-relative path values translate only separators recognized by the target grammar (`/` and `\` on Windows, `/` on Linux) to host separators before anchoring
- Windows drive-relative command spellings (`C:tool.exe`, `C:dir\tool.exe`) are rejected at
  plan time: their meaning depends on process-global per-drive state and therefore cannot be
  anchored to `${manifestDir}` deterministically
- On native Windows runs, command and `cwd` spellings that start with a Windows root are
  accepted only as normal fully qualified drive paths (`C:\...`) or UNC paths with a non-empty
  server and share (`\\server\share\...`). Root-relative paths, malformed multi-separator or
  incomplete UNC roots, and device namespaces are rejected at plan time. Foreign-platform
  previews preserve these target spellings unchanged and cannot execute them.
- env = one shallow-frozen parent-environment snapshot captured by the Executor immediately before `RunStarted`, after removing the `RUNE_INPUT_<ID>` control variable of every declared input (case-insensitively on Windows), then the interpolated `env:` overlay, then reserved `RUNE_RUN_ID` / `RUNE_STEP_ID`; all other parent variables remain inherited, and an explicit command `env:` entry may set a removed name again. The same internal snapshot is used for every step and termination helper in the run and is never added to the `ExecutionPlan`, events, results, or root public API
- stdout/stderr are consumed as streams and line-split with a **64 KiB (65,536 UTF-8 byte) payload limit per logical line**, independently per stream. At the first byte over the limit, the runner clears that line's retained content, emits exactly one fixed value-free line (`[output line omitted: exceeds 64 KiB]`), discards through the next real `\n`, and then resumes normally; EOF while discarding emits nothing further. Lines at or below the limit retain their existing semantics, including CRLF stripping, empty lines, and an unterminated final line. The runner never emits raw fragments at artificial boundaries, so each callback is either one complete bounded logical line or that placeholder and the Executor can pass the whole callback through the secret masker **before anything else sees it**. Persistent per-stream state is bounded; output is never buffered whole.
- process termination (cancellation, timeout, and output-stream failure, §7): POSIX children use `detached: true`. The guarantee covers the spawned process group as a unit, not descendants that deliberately leave that group. The runner sends `process.kill(-pid, 'SIGTERM')`; only `ESRCH` means the group is already absent, while `EPERM`, `EACCES`, and every other signal error are unconfirmed failures. After a sent SIGTERM it polls `process.kill(-pid, 0)` for up to 5 s; only `ESRCH` confirms group absence during this grace phase. It does not use a Linux `/proc` snapshot to finish the grace phase while a signal handler could still fork another group member. If the group remains, the runner sends SIGKILL; an absent group at SIGKILL is confirmed, a signal failure is not, and a sent SIGKILL gets a further bounded 5 s for confirmation. Each wait has a watchdog installed before its first probe, so a stuck probe cannot evade the deadline. Only after SIGKILL has been sent may Linux `/proc` probing distinguish live members from zombies; it ignores process-disappearance races (`ENOENT`/`ESRCH`), while restricted or otherwise unclear scans conservatively treat the group as live. Windows spawns `<SystemRoot>\System32\taskkill.exe /PID <pid> /T /F` from the run's parent-environment snapshot, looking up `SystemRoot` case-insensitively and requiring a non-empty normal fully qualified drive or UNC path (not a current-drive-relative root or device namespace), with argv and `shell: false` — never through `PATH`, `WINDIR`, discovery, or a default. Helper exit 0 confirms the Windows tree termination, and a direct child that has already ended before or while the helper runs counts as absent, like `ESRCH` on POSIX — Windows children stay attached to RUNE's console, so a console `Ctrl+C` reaches a console-attached child at the same moment it fires the CancelToken, and the child ends before the helper runs (a `close` processed before the SIGINT handler is the §7 case); descendants that outlive an ended child are outside the guarantee — a narrower guarantee than the POSIX group kill, since the helper cannot enumerate the tree of a process that is gone. On either platform, an unconfirmed operation makes one immediate best-effort direct-child SIGKILL when the child still has a PID and has not ended, then yields `terminationFailed`; waiting for child `close` is bounded to 5 s and cannot change that result. When that bounded wait expires, the runner releases its ends of the child's stdio and its handle on the child, so an orphaned descendant that inherited them cannot keep the host process alive. `terminationFailed` is fatal: the current step is `FAILED` with RUNE-401 and a null exit code, every later pending step is `NOT_RUN` regardless of `failFast`, and the run is failed. A confirmed operation preserves the original cause even if the bounded child-close wait expires.
- success ⇔ exit code ∈ `successExitCodes` (default `[0]`)
- startup failure classification is value-free: a missing, non-directory, or NUL-containing
  `cwd` is `invalidCwd` (RUNE-404); `ENOENT` retains the cwd check that distinguishes a
  missing command from an invalid cwd; other platform startup failures remain unclassified
  execution failures (RUNE-401)
- Windows honesty rule: `.bat`/`.cmd` files require a shell; RUNE **refuses** them (RUNE-405). The check runs at plan time on the final interpolated `command` — so `--dry-run` surfaces it before anything executes — with a spawn-time backstop in the runner; the message tells authors to write `command: cmd, args: ["/c", ...]` explicitly — the no-implicit-shell invariant is kept honest, not quietly bypassed
- secrets are revealed (unwrapped) only at spawn, inside the runner

## 9) Frontend contract

The engine–frontend boundary is one facade plus one observer interface; the GUI shell's renderer reaches that same facade through the IPC bridge of its own Electron main process, which hosts the engine. All three frontends drive it identically; this is the mode-parity mechanism.

### 9.1 Session facade and events

```ts
// packages/engine/src/engine/session.ts
export class Session {
  static open(manifestPath: string, options?: {
    mode?: 'gui' | 'interactive' | 'non-interactive'; // defaults to non-interactive
    values?: readonly string[];            // --values files, in order (layer 2)
    overrides?: Readonly<Record<string, string>>; // --set (layer 4); RUNE_INPUT_* comes from the environment (layer 3)
    locale?: string;                       // --locale (§6.3)
    platform?: Platform;                   // foreign-platform preview — --dry-run only
    logFile?: string;                      // --log-file; overrides execution.logFile (§10)
    environment?: Readonly<Record<string, string | undefined>>; // defaults to process.env
    systemLocale?: string;                 // host locale; defaults to Intl (injectable for hosts/tests)
  }): Promise<Session>;
  readonly manifest: Manifest;
  readonly mode: 'gui' | 'interactive' | 'non-interactive';
  readonly platform: Platform;                    // selected target platform
  readonly preview: boolean;                      // true for a foreign-platform session
  pendingInputs(): readonly InputState[];         // unresolved AND enabled, declaration order
  allInputs(): readonly InputState[];             // plain, sink-safe input views (defined below)
  warnings(): readonly string[];                  // §4.3/§5/§10 warnings a frontend says out loud
  setValue(id: string, raw: unknown): readonly InputStateChanged[];
                                                  // an answer is always layer 5; registry-validated
                                                  // (type, options, pattern); a rejected value throws
                                                  // and changes nothing; re-evaluates input when:
  plan(): ExecutionPlan;                         // throws listing ALL missing inputs
  describe(): RunResult;                         // the dry run: status `planned`, nothing executed
  execute(observer?: EngineObserver, cancel?: CancelToken): Promise<RunResult>;
                                                 // async; resolves when the run is over
  cancel(): void;                                // fires the CancelToken of the running execute()
  getStrings(): StringTable;                     // resolved manifest + chrome text, session locale (§6.3)
  getThemeConfig(): ThemeConfig;                 // fresh frozen gui snapshot; paths absolute; empty if absent
}

// packages/engine/src/i18n/strings.ts
export function formatSessionTerminalLine(strings: StringTable, line: string): string;
```

`formatSessionTerminalLine` is a terminal-rendering helper, not another facade operation and not a
generic masking capability. It accepts only the exact frozen sink table returned by
`Session.getStrings()`; a raw resolved table, structural copy, or proxy fails closed. Its private
binding retains a live masking closure, so a table obtained before a successful `setValue()` uses
the replacement secret registry on its next call. The helper exposes neither that closure nor the
registry and is not projected over the Electron bridge.

`getThemeConfig()` returns a fresh, shallow-frozen plain-data snapshot on every call, including a
fresh frozen `{}` when `gui` is absent. Its localized `windowTitle` is masked at this GUI sink
against the session's current secret registry, so a successful edit affects subsequent snapshots
without mutating earlier ones; the field remains absent when undeclared. `accentColor` and the
absolute `logo`, `banner`, and `theme` paths are presentation or machine configuration and remain
byte-exact even when their text collides with a secret.

`allInputs()` and `pendingInputs()` are themselves renderer-safe snapshots, not views of the
canonical resolution state. `InputState` is a plain-data union discriminated by `secret`:
`secret: true` carries `value: null` for a resolved value and `value: undefined` for an
unanswered or rejected value; `secret: false` carries only a masked
`string | boolean | readonly string[] | undefined`. Its `spec` is the minimal
`InputViewSpec`: `type` and `required`, plus the exact frozen option values for `select` and
`multiselect`. It never carries manifest titles, descriptions, defaults, patterns, pattern
hints, conditions, or option labels; frontends obtain all display text from `getStrings()`.
Input ids, type discriminators, option values, provenance, and enabled/ignored state are machine
identities and remain byte-exact even when their text collides with a secret. Rejection
candidates, messages, and locations are masked copies. Every successful resolution publishes one
deep-frozen `allInputs` array and one `pendingInputs` array that share their frozen state objects;
repeated calls retain both array identities until the next successful edit. A rejected edit
publishes nothing, while earlier snapshots remain immutable after a successful edit.

The engine is **asynchronous**: `Session.open()` and `execute()` return Promises and run on the Node event loop. Their lifecycle performs no synchronous filesystem, process, or stream I/O; those operations are awaited so the CLI process or Electron main process stays responsive. Bounded in-memory YAML decoding/parsing, zod validation, and input/plan resolution remain CPU work on the event loop — RUNE neither promises nor introduces worker threads for them. The separate synchronous authoring APIs `parseManifest()` and `validateManifest()` keep their existing contract.

Events are frozen plain objects (`readonly` types, `Object.freeze`d). **Run events**, delivered through `EngineObserver` during `execute()`: `RunStarted(plan)`, `StepStarted(stepId, index, total, title)`, `StepOutput(stepId, stream, line)` (one complete bounded logical line or the fixed §8 placeholder, pre-masked), `StepFinished(stepId, state, exitCode, durationMs)`, `RunFinished(result)` — durations are milliseconds everywhere (events, IPC payloads, result file `durationMs`). `StepFinished` is terminal-only: `SUCCEEDED` carries a numeric exit code, `FAILED` carries a numeric code or `undefined`, and `SKIPPED`, `CANCELLED`, and `NOT_RUN` carry `undefined`. Elapsed durations use a monotonic clock and are non-negative; ISO timestamps use the wall clock and can reflect clock adjustments. Plan-time `SKIPPED` steps emit exactly one `StepFinished(state=SKIPPED)` and no `StepStarted`/`StepOutput`; `total` counts all planned steps including skipped ones — progress renderers and the mode-parity suite rely on both rules. `title` is the localized title (§6.3); `stepId` is never localized.

**Session event:** `InputStateChanged(inputId, enabled)` is produced by `setValue()` and **returned to the caller** — over the IPC bridge it is the resolved value of `rune.setValue`, and there is deliberately no separate push event (one delivery, nothing to double-apply) — whenever an input's `when:` flips because a controlling value changed. It belongs to the resolution phase, not to execution: it is never delivered through the run-event observer and does not count against the `RunStarted`/`RunFinished` bracket.

**Observer delivery contract:** run events are delivered synchronously, in order, from the engine's event-loop turn (observer callbacks are plain synchronous functions; the engine never awaits them). Immediately before the first `RunStarted` callback, the Executor captures and freezes one shallow copy of the parent environment; every spawn and termination helper in that run receives that same internal snapshot, so an observer's mutation of the live host environment cannot affect execution. Observers must return quickly and must not throw; an observer exception is caught and swallowed — a broken renderer can never corrupt a run. `RunStarted` is first and `RunFinished` is last, exactly once each; no event is delivered after the `execute()` promise settles. The frontend's terminal event is withheld until every engine-owned sink has finalized. If finalization fails after steps ran, the sole `RunFinished` carries the failure result with the Executor's actual step states and counters; the facade then rejects with the corresponding `RuneError`. Observers can never influence execution.

### 9.2 Electron IPC bridge (main ↔ renderer)

The IPC bridge is how the GUI shell's renderer drives the engine. The engine runs **inside the shell's Electron main process** (`gui-shell/src/main` imports `@rune/engine` and owns one `Session`); the renderer is a pure renderer in a sandboxed `BrowserWindow` (`contextIsolation: true`, `nodeIntegration: false`, `sandbox: true`) and sees the engine only through a preload script that exposes `window.rune` via `contextBridge.exposeInMainWorld`. The bridge is a **1:1 projection of the `Session` facade and event stream**: every bridge method maps to one facade call, every run event to one push message, and nothing exists on the bridge that the in-process facade lacks. Adding engine behavior reachable only through the bridge would break mode parity by construction and is forbidden (invariant 11). There is no wire format, no stdio channel, no sidecar process, and no engine binary.

- **Transport:** Electron IPC — request/response via `ipcRenderer.invoke` ↔ `ipcMain.handle` (one channel per facade method), run events pushed main → renderer via `webContents.send` and subscribed through `rune.onEvent(listener)` in the preload. Preload and renderer are built and shipped together in the same artifact, so the bridge is an internal contract pinned by a unit test (§14), not a versioned wire format.
- **Opening:** the renderer calls `rune.open()`; main opens the `Session` from the **invocation it was launched with** (manifest path, `--values`, `--set`, `--locale`, `--result`, `--log-file` — the CLI's layers 2–4 and flags, resolved by the engine exactly as for the CLI). The renderer never supplies a manifest path or any layer-1–4 value; `rune.open()` resolves to `{ runeVersion, inputTypes }` — the input-type names the manifest uses, checked against the renderer's field-renderer registry (§9.3).
- **Methods:** `rune.open`, `rune.pendingInputs`, `rune.allInputs`, `rune.warnings`, `rune.setValue`, `rune.plan`, `rune.describe`, `rune.execute`, `rune.cancel`, `rune.getStrings`, `rune.getThemeConfig` — every one returns a Promise. `rune.execute` is long-running: run events are pushed while it is in flight and its promise resolves with the `RunResult`; `rune.cancel` is the only call serviced concurrently with it.
- **Events (main → renderer):** `runStarted`, `stepStarted`, `stepOutput`, `stepFinished`, `runFinished` — the run events only; the live enable/disable signal for §5's disabled inputs (`InputStateChanged`) is the resolved value of `rune.setValue`, not a pushed event. `allInputs()` and `pendingInputs()` already return their plain sink-safe snapshots from the facade. Other payloads remain **bridge projections**: main runs events and other return values through the bridge serializer (JSON-safe plain data; `SecretString` → `***`, `mask()` applied) before `webContents.send` / the invoke return — Electron's structured clone then carries only plain masked data, never an engine object (structured clone ignores `toJSON()`, so a raw `SecretString` must never reach it). Ordering and bracketing rules of §9.1 hold across the bridge.
- **Secrets:** values of `secret` inputs cross the bridge towards the renderer only masked — `secret: true` with `value: null` in `allInputs` and in the `RunResult` (the same representation the result file uses, §10), `"***"` in human-readable plan previews and events — never as plaintext. The one direction in which a secret crosses in clear is `rune.setValue` as the user types it; it is wrapped at the engine boundary like any other layer-5 answer, and main never logs incoming bridge calls.
- **Errors:** a `RuneError` thrown by the facade rejects the bridge promise with a serialized error carrying the `RUNE-xxx` code, message, location, and the exit code the CLI would have used. Two classes: rejections of `rune.setValue` and `rune.plan` are **recoverable** — the renderer shows them inline (red field with `patternHint`, `Next` disabled while inputs are incomplete or invalid, §9.3) and the session continues; only errors from `rune.open`, `rune.execute`, and failures outside any bridge call (e.g. window close during a run) are **fatal** — main, not the renderer, maps those through `exitCodeFor` and exits with that code (§9.4).

### 9.3 Per-frontend behavior

- **Non-interactive driver** (`cli`): no prompts ever; missing required *enabled* inputs → exit 4 listing every missing input with its accepted sources; disabled inputs are not required and a value supplied for one is warned about and ignored (§5); `pattern` mismatches and malformed `--set` JSON arrays are input errors (exit 4) before any step runs; plan → execute → result file. This is the parity anchor.
- **Interactive CLI**: Node `readline` prompts (stdlib — no prompt library) with a muted-echo helper for `secret` inputs, for `pendingInputs()` only — enabled, still-missing inputs in declaration order; select/multiselect prompts display option **labels** and accept option **values**; a `pattern` mismatch re-prompts showing `patternHint`; disabled inputs are skipped. Then the summary: the plan rendered with the same renderer dry-run uses, followed by the **edit loop** `Proceed / Change value <n> / Cancel` — any enabled input, seeded or answered, can be changed (an ordinary layer-5 `setValue`); a change that enables further missing inputs prompts for them before re-rendering the summary. `Proceed` awaits `execute()` on the same event loop; first `Ctrl+C` → CancelToken; second force-exits. Chrome strings come from `getStrings()` (§6.3).
- **GUI** (Electron shell, §9.4): pages generated from the engine's view of the manifest — Welcome, auto-chunked input pages, Summary (renders the bridge projection of the same `ExecutionPlan`, secrets masked — §9.2), Progress, Result. The renderer renders `rune.allInputs()` with fields pre-filled from layers 1–4; disabled inputs are **greyed out** (visible, not editable) and flip live on the `InputStateChanged` list resolved by `rune.setValue`; select/multiselect fields display labels and submit values; a `text` field whose `rune.setValue` rejects on `pattern` is marked red with `patternHint` and `Next` stays disabled until valid — no abort, no renderer-side regex. Engine validation via `setValue` is the only authority; widgets are UX sugar. Cancel → `rune.cancel` → `Session.cancel()` → CancelToken.

Every frontend asserts at session open that it can render every input type the manifest uses (the renderer from the `inputTypes` resolved by `rune.open()`), and fails fast with a named error — no silent fallback.

### 9.4 GUI shell (Electron)

**Why Electron.** The end user of a RUNE-built installer must be able to run it out of the box on any supported machine — nothing to install first, no admin rights (portable, per-user), pixel-identical everywhere (a *bundled* rendering engine, never a system webview), and with a genuinely modern, polished, animated default look. A bundled Chromium is the one widely deployed rendering engine that meets all four; the installer *author* may install tooling (Node 22 LTS, `npm install -g @rune/cli`) — the end user never does. Because engine, CLI, and shell are one language, the shell needs no second runtime, no second bundler, and no sidecar process.

**Shape.** The wizard UI is an Electron application ("GUI shell") written in TypeScript + HTML/CSS in `packages/gui-shell/`, three parts with three roles: **main** (`src/main/`) imports `@rune/engine` and **hosts the engine in-process** — it owns the `Session`, registers the IPC handlers, creates the window, and exits with the engine's exit code; because the engine is async, it never blocks the main process. **preload** (`src/preload/`) exposes the IPC bridge (§9.2) through `contextBridge`. **renderer** (`src/renderer/`) is a **pure renderer**: no execution, planning, interpolation, condition, or validation logic; it never reads the manifest, `locales/`, or values files and never imports the engine — it renders pages from what the bridge returns. From milestone 3 on the shell also accepts `--non-interactive`: main then runs the engine without opening a window — the headless path the packaged artifact reuses (§9.5).

**Process model of `rune run --gui`.** The CLI locates the shell in the per-user cache (exit 2 with the `rune gui install` hint if absent), launches it with the invocation (manifest path, `--set`, `--values`, `--result path`, `--log-file`, `--locale`), and waits. The shell's main process opens the `Session` from that invocation, runs the engine itself, and drives the wizard; the engine writes the result file and the log exactly as the CLI would in any other mode. `--result -` is rejected by the CLI before the shell is launched (usage error, exit 2, §4.1): there is no stdout contract under a GUI. The shell exits with the engine's exit code; `rune run --gui` forwards it **only if the shell terminated normally with a code from §10's table** — signal death or any other code (a Chromium-level crash code, for instance) is mapped to 70 — so `--gui` has the same exit-code contract as every other mode. A first `Ctrl+C`/SIGTERM received by the CLI is forwarded to the shell as a cancel request (POSIX: SIGTERM to the shell pid, which main treats as `Session.cancel()`; Windows: `taskkill /PID <shell>` without `/F`, i.e. a close request → the close-window path of §7); the CLI keeps waiting and forwards the resulting exit code (6); a second `Ctrl+C` force-exits the CLI while the shell finishes its own cancel. An engine failure inside the shell is an ordinary `RuneError`: the shell shows it as a named error and exits with that error's exit code, result file written as always. A hard crash of the shell process itself (no `RunFinished`, no result) is exit 70 without a result file, surfaced by `rune run --gui` as an internal error.

**Theming model (three layers):**

1. **RUNE default theme** — polished, modern, animated: page transitions, animated progress, success/failure micro-animations, light and dark variants; built on CSS custom properties (`--rune-accent`, `--rune-radius`, `--rune-font`, …). This is what every installer looks like when the author does nothing.
2. **Manifest `gui:` block** (schema v1, §4.2) — `gui.accentColor`, `gui.logo` (window/taskbar icon and header logo), `gui.banner`, `gui.theme` (path to a CSS file), optional `gui.windowTitle`. The engine returns each `getThemeConfig` call as a fresh frozen snapshot: the localized `windowTitle` is sink-masked against current secrets, while `accentColor` and the absolutized asset/CSS paths remain exact. The renderer applies it as variable overrides; presentation-only, ignored by CLI and non-interactive — no parity impact.
3. **Author CSS** — the `gui.theme` file is loaded **after** the default theme and may override variables or any rule. Advanced tier, documented as *your CSS, your support*: RUNE guarantees the custom-property names, not the internal DOM.

**Author-time delivery.** Authors and CI need Node 22 LTS only — `npm install -g @rune/cli` or `npx @rune/cli …`; nothing else is installed for engine/CLI use. `rune gui install` downloads the prebuilt shell for the current OS from the project's GitHub Releases into the per-user cache — no admin rights, no system install. The CLI npm package (`@rune/cli`) contains no Electron; the shell is a separate prebuilt artifact, and core/CI never see Electron. `rune run --gui` launches the cached shell or exits 2 with that hint. Shell updates are explicit re-runs of `rune gui install` (auto-update is deferred, §16).

*Version coupling.* The shell bundles its own copy of `@rune/engine`; `@rune/cli` ships another. To keep mode parity real rather than nominal, **`rune gui install` fetches the shell release whose engine version equals the installed CLI's**; the per-user cache is keyed by that version; `rune run --gui` refuses a cached shell whose engine version differs from its own (exit 2, hint: re-run `rune gui install`). The result file's `runeVersion` under `--gui` is the shell engine's version — by construction equal to the CLI's.

*Archive format.* Shell artifacts are `.tar.gz` on Linux and `.zip` on Windows; `rune gui install` fetches with Node's built-in `fetch` and unpacks by spawning the OS `tar` as argv (`tar -xf`; bsdtar ships with Windows 10+/11 and handles both formats) — no archive library, in line with §12's runtime dependency list.

### 9.5 End-user artifact (`rune package`, milestone 4)

`rune package installer.yaml` produces a **self-contained, portable, per-user-runnable** folder or archive — Windows: portable `.exe` + folder or a single zip; Linux: AppImage or tar.gz (the choice per platform is deferred, §16) — containing the Electron shell with the **engine as plain JavaScript inside the app bundle** (one language, one bundler: **electron-builder** — no second bundler, no engine binary), the manifest, `scripts/`, `payload/`, `assets/`, and `locales/`. No installation, no admin rights, identical look. The end user double-clicks and sees the same wizard the author saw with `rune run --gui`; the same packaged app supports the headless `--non-interactive` mode — Electron started with CLI arguments runs the engine in main without opening a window, exit codes and result file as in every other mode — so pipelines can use the artifact too.

The portability basis is **`${manifestDir}` anchoring** (§6.1, invariant 13): inside the artifact the manifest sits in a folder with its relative resources exactly as in the author's project tree, so nothing in the manifest changes between `rune run` on the author's machine and the packaged run on the end user's. Exact `rune package` internals (layout, electron-builder configuration, archive formats) are designed when the milestone starts; the contract above — the *what*, not the *how* — is fixed now.

## 10) Automation contract

### Exit codes

Fixed, identical on Windows and Linux — no `128+signal` arithmetic, so one pipeline script branches the same way everywhere. Each error class maps to exactly one code — the map is owned by `errors.ts` (`exitCodeFor`) alone; `cli/main.ts` is the only `process.exit` call site in the CLI (the GUI shell's main process uses the same `exitCodeFor` and `rune run --gui` forwards its code, §9.4); every code is reachable by a test.

| Code | Meaning |
|---|---|
| 0 | Success (all steps succeeded or skipped — including `nothingExecuted: true`; also successful `validate` / `--dry-run` / `schema`) |
| 1 | One or more steps failed or timed out (regardless of `failFast`); or result-file delivery failed with RUNE-407 — no result file exists, the exit code and the stderr diagnostic are the only signals |
| 2 | Usage or unsupported-host error (unknown flag, malformed `--set`, an empty `--log-file` value, a real run whose non-stdout result and effective log file are the same path, a `schema --output` destination that cannot be written (§4.1), host platform other than Node's `win32` or `linux`, `--gui` without the GUI shell installed or with a cached shell of a different engine version (§9.4), `--gui` with `--non-interactive`/`--dry-run`/`--result -`); `commander` runs with `exitOverride()` so RUNE, not the parser, emits CLI errors |
| 3 | Manifest invalid (RUNE-1xx, incl. locale-overlay errors); `validate` failure |
| 4 | Input error (missing required input, coercion/pattern failure, malformed JSON array, unknown key in `--set`/values) |
| 5 | Resolution/condition error (RUNE-3xx) |
| 6 | Cancelled |
| 70 | Internal error (always a RUNE bug; also a hard crash of the GUI shell process hosting the engine — no result file, §9.4 — and any shell exit that is not a code from this table) |

Codes 7–19 reserved for future features.

### Never-block contract

Under `--non-interactive` — explicit or TTY-degraded (stdin not a TTY when a prompt would be needed): layers 1–4 resolve; any required **enabled** input still missing → exit 4, stderr lists **each** missing input with its accepted sources (`--set id=... | RUNE_INPUT_<ID> | values-file key 'id'`); a result file with `status: "input_error"` is still written if `--result` was given; **no step executes** — resolution is all-or-nothing. Optional and disabled inputs resolve to their type's empty value (§4.2, §5).

### Stream discipline

stdout is reserved exclusively for requested machine output (`--result -`, the dry-run plan, the `rune validate` report including its audit section, `rune schema`). All progress, prompts, diagnostics, and warnings (secrets interpolated into `args`, ignored disabled-input values, `nothingExecuted`) go to stderr. `rune run ... --result - | jq .` works with zero contamination. With `--dry-run --result -` stdout carries only the result JSON and the human plan is not rendered; `--result <path>` keeps the plan on stdout. A consumer that closes stdout or stderr early (`| head -1`, a viewer quit mid-stream) ends RUNE's output on that stream but never changes the exit code: the CLI owns the stream's `error` event, writes nothing further to the closed pipe, and prints no stack trace.

Each CLI-rendered human line visibly escapes C0, DEL/C1, U+2028, and U+2029 after masking and composition; formatter-owned aggregate line feeds remain physical, while JSON and JSON Schema output remain unchanged. Lines rendered from a session use its authenticated `StringTable` and `formatSessionTerminalLine`: raw mask → control escape → final live mask. The second mask prevents an actual control from becoming a registered literal such as `\u001b` only after presentation. Authoring commands with no runtime secret registry (`validate`, `schema`) and pre-session fallback text use ordinary control escaping; requested JSON output bypasses human rendering entirely.

### Result file (`--result`)

Versioned independently of the manifest schema (`resultSchemaVersion: 2`; `rune schema --result` emits its JSON Schema), written **atomically** (a uniquely named, exclusively created sibling tmp file + `fs.rename`) on every configured-run outcome — success, step failure, manifest error, input error, resolution/condition error, cancellation, internal error. Usage and unsupported-host errors (both exit 2), a failed result-file delivery (RUNE-407, exit 1), and a hard crash of the process hosting the engine (exit 70 — under `--gui` the shell process, §9.4) skip it. The public async `writeResult` function owns atomic filesystem delivery; a failed write removes only its own tmp file best-effort before rejecting and is never retried. The public `serializeResult` function returns exactly the text `writeResult` writes — the schema-validated copy in the schema's member order, two-space indented, newline-terminated — and `--result -` prints that same text, so both sinks fail closed on a result that does not match the version-2 contract and agree byte for byte. Failure to prepare its directory or to open, write, close, or finalize the result file is an operational `ExecutionError` (RUNE-407, exit 1), never an `InternalError`: its message names the destination path and a fixed reason derived from the errno code — never the raw OS message — and it retains the underlying cause internally; because delivery is never retried, the exit code and that stderr diagnostic are the only signals of the failure. The CLI renders that diagnostic exactly like the success line for the same path — through the session's terminal projector, so a destination equal to a registered secret is masked; without a session `StringTable` it names the path only when the manifest never parsed (no secret can exist) and otherwise, after a secret-bearing open failure, prints one fixed line that names nothing. Hosts call `writeResult` after the engine has produced a result, so result-file delivery completes before any terminal human summary is rendered.

Result construction remains engine-owned. `Session.describe()` and `Session.execute()` produce normal results; the public `createFailureResult` factory builds failures around `Session.open()`, planning, or pre-execution setup while preserving every available manifest, session, input, locale, platform, and plan fact. With session or plan context, detailed error fields are accepted only from the exact engine-produced error bound to the current session generation. An external, cross-session, or stale error becomes one fixed generic internal-error projection without consulting the session's secret registry; the host-created dry-run cancellation likewise uses one fixed canonical RUNE-601 projection. Plan-time RUNE-401/404/405 failures have no completed plan and therefore keep the zero-step form. A pre-execution log-file failure (RUNE-406) may project an already completed plan as unchanged `SKIPPED` steps plus `NOT_RUN` executable steps. If log writing or closing fails after execution, `Session` instead preserves the completed run's real step states, output tails, and counters and reclassifies only the run-level outcome. Consequently, this documented run-level `failed` form need not contain a `FAILED` step. Hosts capture the engine-produced terminal result and never duplicate these semantics. Run `status` maps to the exit code per the table below: every status implies exactly one exit code, and every exit code from a configured run implies exactly one status once `dryRun` is known — exit 0 is `succeeded` for a real run and `planned` for `--dry-run`; every other configured-run code is unambiguous on its own. Consumers may branch on either, using `dryRun` to disambiguate exit 0.

| `status` | Exit code | Produced by |
|---|---|---|
| `succeeded` | 0 | real run, all steps succeeded or skipped (`nothingExecuted` tells the two apart) |
| `planned` | 0 | `--dry-run` (`"dryRun": true`), plan built successfully; counters describe the plan (`stepsExecuted` is 0, `nothingExecuted` always `true`, no warning — §7) |
| `failed` | 1 | one or more executed steps failed or timed out; planning rejected an execution spelling with RUNE-401/404/405 before a plan existed; or operational log-file I/O failed with RUNE-406, preserving the real `NOT_RUN`/`SKIPPED` or already-completed step topology. Exit 1 is also the code of a run whose result-file delivery failed with RUNE-407 — no result file exists, the exit code and the stderr diagnostic are the only signals |
| `config_error` | 3 | manifest invalid (RUNE-1xx) |
| `input_error` | 4 | missing/invalid input, unknown `--set`/values key (RUNE-2xx) |
| `resolution_error` | 5 | interpolation or condition error (RUNE-3xx) |
| `cancelled` | 6 | user/system abort (RUNE-601) — during execution (interrupted step `CANCELLED`, rest `NOT_RUN`) or before it (CLI edit-loop `Cancel`, GUI window closed or Cancel before Proceed: every still-`PENDING` step becomes `NOT_RUN` while plan-time `SKIPPED` steps remain `SKIPPED`; zero counters when no plan exists) |
| `internal_error` | 70 | RUNE bug (RUNE-500) |

Contents:

- **run block** — `id`, `status`, `exitCode`, `mode` (`gui` / `interactive` / `non-interactive`), `dryRun`, `crossPlatformPreview` (true iff `--platform` named a foreign platform, §6.1), `platform`, `locale` (required `string | null`; `null` means the built-in defaults), timestamps, `durationMs`, `runeVersion`, and the counters `stepsTotal`, `stepsExecuted`, `stepsSucceeded`, `stepsFailed`, `stepsCancelled`, `stepsSkipped`, `stepsNotRun`, `nothingExecuted` (§7; `stepsTotal = stepsExecuted + stepsSkipped + stepsNotRun`, `stepsExecuted = stepsSucceeded + stepsFailed + stepsCancelled`)
- **top-level error** — required and strict `{code, message, location}` (`location` is `null`
  or `{file, line, column}` with 1-based positive coordinates). It is `null` for `succeeded`,
  `planned`, and ordinary runtime `failed` results. Otherwise its code is correlated with the
  status: RUNE-401/404/405 for the zero-step plan-time `failed` form, or RUNE-406 for
  the operational log-file `failed` form; RUNE-101..104 for
  `config_error`; RUNE-201..203 for `input_error`; RUNE-301/302/311/312 for
  `resolution_error`; RUNE-601 for `cancelled`; and RUNE-500 for `internal_error`. Usage,
  unsupported-platform, and result-file delivery (RUNE-407) errors are never represented in
  a result.
- `product` and manifest identity are required after manifest validation: `succeeded`,
  `planned`, both `failed` forms, `cancelled`, `input_error`, and `resolution_error` carry a
  non-null `product` plus a 64-character lowercase-hex `manifest.sha256` and an integer
  `manifest.schemaVersion`. `config_error` and `internal_error` may occur before validation and
  therefore retain the nullable metadata form. `manifest.path` is always present.
- **per input** — `{id, value, source, secret, enabled, ignored?}`: secret values always `null`; `enabled: false` for disabled inputs, whose `value` is the type's empty value; `ignored: "input disabled"` present only when a value was supplied for a disabled input, with `source` naming the layer that supplied it (provenance makes precedence — and what was discarded — auditable after the fact)
- **per step** — `{id, title, state, exitCode, durationMs, command, skipReason, outputTail?}`: `title` localized, `id` never; command arrays passed through the masker; `outputTail` present **only** for `FAILED` steps — a list of the last 50 `{stream, line}` entries, already masked (§7)

Input ids must be unique within `inputs`, and step ids must be unique within `steps`; the same id may appear once in each list.

Every result with `"dryRun": true` has `stepsExecuted: 0` and may contain only `PENDING` or
`SKIPPED` steps (or no steps); no dry-run result may claim `SUCCEEDED`, `FAILED`, or `CANCELLED`
step state. A successful dry-run uses `status: "planned"`, enabling plan diffing between commits.

### Logging and secret masking

Two sinks off the one event stream (the same stream frontends render — GUI progress, CLI output, and logs tell one story): stderr console (plain-text progress, diagnostics, and warnings) and the log file (`--log-file` / `execution.logFile`; DEBUG-level, timestamped, step output prefixed `[stepId:stdout]`). A relative `logFile` resolves against `${manifestDir}`. A Windows drive-relative spelling (`C:run.log`) is rejected at validate time (RUNE-104), like a drive-relative command (§8): it cannot be anchored to `${manifestDir}` deterministically, and anchoring it as a literal component would address an NTFS alternate data stream. The field is deliberately non-interpolable in v1; when both are given, `--log-file` overrides `execution.logFile`. Failure to prepare its directory or to open, write, or close the configured log file is an operational `ExecutionError` (RUNE-406, exit 1), never an `InternalError`; it retains the underlying cause internally. Under the GUI shell the engine runs in the shell's main process: the console sink writes to the shell process's stderr, which `rune run --gui` passes through to the caller's terminal, and the warnings that are part of the automation contract (secrets interpolated into `args`, ignored disabled-input values, `nothingExecuted`) are additionally surfaced on the shell's Result page — the same run never warns in one mode and stays silent in another; the log file is written by the engine as in every other mode. A structured JSONL event log is a clean post-MVP addition off the existing event stream and is deliberately **not** in MVP — no second machine contract ships unversioned.

Secret handling is belt-and-braces:

1. **Opaque `SecretString` wrapper end-to-end** (in-process safety): values of `secret` inputs are wrapped at resolution; the public wrapper exposes only masking/stringification behavior, and the plan, `toString()`, `toJSON()`, and `util.inspect` render `***`. Plaintext resolvers remain module-private; an internal reveal capability is used only inside the runner at spawn.
2. **`SecretRegistry` + `mask()`** (sink safety): every secret value is registered at resolution time — before any step can launch — and `mask(text)` performs registration-order-independent substring replacement from a cached immutable matcher snapshot at every sink boundary: the logging filter, child stdout/stderr ingestion (a script that echoes a password still produces masked logs — and the output-tail ring buffer is fed from the already-masked stream), the result writer, the dry-run renderer, and the IPC-bridge serializer in the shell's main process. Overlapping matches are merged while immediately adjacent matches stay separate. Bounded remasking handles matches created by `***` replacement; if those passes do not converge, the whole input is masked.

   Each maskable dynamic string published in a structured facade, plan, event, or result field is
   projected independently: the engine masks its raw value, then checks the content of that one
   JSON string after JSON escaping against the same registry and fails closed to `***` if escaping
   creates a match. This covers non-secret input values and rejected candidates; resolved display
   strings and `windowTitle`; plan input values, titles, skip reasons, and public command values;
   `StepStarted.title` and real or synthetic `StepOutput.line`; and the corresponding result input,
   step, command, and output-tail fields. An execution value hidden for this reason remains an
   authentic `SecretString`, so argv, cwd, and environment values reach the runner byte-exact.
   Projection is field-level, never a scan of complete JSON: input/step ids, option values,
   environment keys, locale/platform/mode/status/source/state/code/stream enums, product identity,
   validated manifest/asset/theme/log paths, hashes, run ids, timestamps, versions, fixed keys,
   syntax, and `null` remain exact by contract. Error and location strings use the diagnostic
   projection contract rather than this structured-field helper.

A registry snapshot is limited to **262,144 UTF-16 code units** (`2^18`) across its unique maskable parts, counting the complete value, the maskable content lines of a multiline secret, and the whitespace-trimmed spelling of every part that carries surrounding whitespace; registering the same part again consumes no additional budget. This is the smallest power-of-two limit above the 10,000-secret scale exercised by the masking suite (about 170,000 code units), while bounding the immutable matcher's trie to at most 262,145 nodes instead of allowing a values file to demand millions. Registration preflights every part before mutating the snapshot, and the transient active-plus-staged union used to redact resolution errors is subject to the same limit before it is copied or a matcher is built. Exceeding either limit fails closed as a generic RUNE-202 input error before execution; it publishes no partial registry and reports neither secret text nor candidate length.

Documented limitations: the registry registers every maskable content line of a declared secret, including each CR/LF/CRLF-separated line. A part with surrounding spaces or tabs is registered in both its raw and its trimmed spelling, so a child that trims the value before printing it is masked as well. A secret without non-empty content, or with any content line shorter than 4 characters after trimming surrounding whitespace, cannot be masked completely reliably; `run` warns at resolution time — `validate` never sees values. A RUNE-generated secret path transformation that cannot be registered completely instead fails closed with a generic RUNE-202 error during planning, before any step launches. Other transformed secrets (for example, base64) can also defeat substring masking — best-effort by nature, stated openly rather than discovered as a CVE. Values pulled in via `${env.NAME}` are not registered either — only declared `secret` inputs are; sensitive values must therefore be modeled as `secret` inputs (fed by `RUNE_INPUT_*` in CI), never referenced through `${env.*}`.

## 11) Package layout

One npm-workspaces monorepo; root `package.json` (workspaces), `tsconfig.base.json` (strict), eslint and prettier config, dependency-cruiser config. No other monorepo tooling.

This is the target layout across the roadmap milestones; entries not present in the current repository are planned.

```
packages/
├── engine/                        # @rune/engine — the library; no CLI parsing, no Electron
│   ├── package.json
│   └── src/
│       ├── index.ts               # curated public API: Session, events, errors, value types, version,
│       │                          #   schemas, validation, createFailureResult, writeResult
│       ├── errors.ts              # RuneError hierarchy, RUNE-xxx codes, exitCodeFor() — the single owner of the error -> exit-code map
│       ├── diagnostics.ts         # safe diagnostic escaping and JSON-style quoting
│       ├── suggest.ts             # "did you mean …?" for every name RUNE refuses
│       ├── manifest/
│       │   ├── index.ts           # parseManifest()/validateManifest() facade, schemaVersion registry dispatch
│       │   ├── loader.ts          # `yaml` core schema, key checks, SourceMap build (also overlays/values)
│       │   ├── source.ts          # Location(file,line,col), SourceMap(jsonPath -> Location)
│       │   └── v1/
│       │       ├── schema.ts      # zod schemas: Manifest, InputSpec union, OptionSpec, Step,
│       │       │                  #   CommandSpec, GuiConfig; source of `rune schema` (z.toJSONSchema)
│       │       ├── rules.ts       # cross-field semantic checks, static ref/type checks, input-when acyclicity
│       │       └── present.ts     # zod issue path -> file:line:col error presenter
│       ├── inputs/
│       │   ├── base.ts            # InputTypeHandler: name, secret, empty/isAbsent, fromString/fromNative, render/compare
│       │   ├── registry.ts        # name -> InputTypeHandler map; duplicate registration is an error
│       │   ├── builtin.ts         # the seven MVP types (text incl. pattern; select/multiselect by value)
│       │   └── snapshot.ts        # safe immutable snapshots of native string arrays
│       ├── i18n/
│       │   ├── catalog.ts         # built-in English chrome strings (`rune.*` keys) — the key authority
│       │   ├── locale.ts           # locale selection, normalization, and overlay discovery/matching
│       │   ├── overlay.ts          # hardened YAML loading and localizable-key validation
│       │   └── strings.ts          # per-key fallback resolution into the engine-owned StringTable
│       ├── engine/
│       │   ├── session.ts         # Session facade — the ONLY frontend entry point (async); InputStateChanged
│       │   ├── context.ts         # built-in names/reference resolution and runtime platform/preview values
│       │   ├── inputs.ts          # 5-layer merge, provenance, coercion via inputs/registry, input when:
│       │   ├── interpolate.ts     # ${...} scanner/renderer; single-pass, no eval
│       │   ├── conditions.ts      # when: lexer, parser, AST, typed evaluator (steps and inputs)
│       │   ├── secrets.ts         # SecretString wrapper + SecretRegistry + mask()
│       │   ├── plan.ts            # Planner -> frozen ExecutionPlan / PlannedStep / ResolvedCommand
│       │   ├── state.ts           # StepState + legal-transition table
│       │   ├── events.ts          # frozen run-event types + EngineObserver interface
│       │   ├── cancel.ts          # CancelToken (flag + listener list)
│       │   └── executor.ts        # sequential async step loop, failFast, timeout, kill path, output-tail ring buffer
│       ├── runners/
│       │   ├── base.ts            # Runner interface
│       │   └── spawnRunner.ts     # child_process.spawn (shell:false), stream splitting, POSIX group/Windows tree kill
│       ├── results/
│       │   ├── model.ts           # RunResult/ResultStep (resultSchemaVersion 2): counters, outputTail, provenance
│       │   ├── schema.ts          # JSON Schema and runtime correlations for resultSchemaVersion 2
│       │   └── writer.ts          # atomic write, always-on-outcome
│       └── logs/
│           └── logFile.ts         # append-only event-log sink; receives already-masked output
├── cli/                           # `rune` — bin "rune"; depends on @rune/engine only through its public API
│   ├── package.json
│   └── src/
│       ├── args.ts                # shared flag parsing and validation
│       ├── cli.ts                 # commander wiring, CLI execution and error-to-exit-code mapping
│       ├── io.ts                  # I/O and process-control seams
│       ├── main.ts                # executable entry point and the single process.exit site
│       ├── runCmd.ts              # non-interactive execution and dry-run orchestration
│       ├── schemaCmd.ts           # `rune schema [--output] [--result]` from the zod schemas
│       ├── signals.ts             # cooperative first signal, forced cancellation on the second
│       ├── streams.ts             # guarded stdout/stderr writers: one `error` owner per stream, no writes to a closed pipe
│       ├── validateCmd.ts         # validation and environment-variable audit report
│       ├── guiCmd.ts              # planned `gui install` + --gui launch/exit-code forwarding
│       ├── prompt.ts              # planned readline prompts and summary edit loop
│       └── render.ts              # shared plan/progress/result rendering (also dry-run)
└── gui-shell/                     # Electron GUI shell — separate prebuilt artifact; never inside the CLI npm package
    ├── package.json               # electron, electron-builder (shell lane only)
    ├── src/main/                  # Electron main: hosts @rune/engine in-process, Session lifecycle, IPC handlers,
    │                              #   window, headless (--non-interactive) entry, exit code
    ├── src/preload/               # contextBridge API `window.rune` — 1:1 projection of the Session facade + events
    ├── src/renderer/              # pages (Welcome, inputs, Summary, Progress, Result), field renderers per input type;
    │                              #   imports only the bridge's type declarations
    ├── src/theme/                 # default theme: CSS custom properties, light/dark, animations
    └── tests/                     # Playwright-for-Electron smoke suite (§14)
tests/                             # cross-package suites: mode-parity contract suite, exit-code reachability, masking
```

Each package additionally has a `test/` directory of vitest unit tests (collected by the root `vitest.config.ts`); `packages/gui-shell/tests/` is reserved for the Playwright smoke suite so that vitest never collects Playwright specs. Cross-package suites live in the root `tests/`.

## 12) Dependency policy

**Runtime (engine + CLI) — kept tiny:** `yaml` (eemeli: plain-YAML parsing with the core schema, no code execution, node ranges for the SourceMap), `zod` (schema validation, and `rune schema` generation through its built-in `z.toJSONSchema()` — no separate converter package), and `commander` (CLI parsing with `exitOverride()` and custom error output, so RUNE owns exit codes and stderr formatting, which are published contract). Rationale for zod: discriminated unions fit the input/run schema exactly, `.strict()` gives the reject-unknown-keys posture for free, one typed schema is one source of truth — a hand-rolled validator would be hundreds of drift-prone lines — and its JSON Schema export makes `rune schema` a non-feature to maintain. All three are small, stable, pure JavaScript with **zero native code**, so they bundle trivially with electron-builder (§9.5) and install anywhere Node 22 LTS runs. Nothing else at runtime: prompts are Node `readline` with a muted-echo helper, process execution is `child_process.spawn`, locale overlays are plain YAML, and `rune gui install` downloads with Node's built-in `fetch` and unpacks the shell archive (`.tar.gz` on Linux, `.zip` on Windows) by spawning the OS `tar` as argv — bsdtar ships with Windows 10+/11 — so no archive library is needed (§9.4). **The CLI npm package contains no Electron; the shell is a separate prebuilt artifact** (§9.4).

**GUI shell:** `electron` and `electron-builder` are dev dependencies of `packages/gui-shell` only — required for working on the shell, never for engine or CLI development, never in CI core jobs. Shipped as prebuilt per-OS artifacts on GitHub Releases (`rune gui install`) and as `rune package` outputs. Electron is pinned to a release line that embeds Node 22 — the engine's declared runtime — and is bumped only together with the Node LTS target; the smoke suite asserts `process.versions.node` major 22 inside the shell.

**Packaging (milestone 4):** electron-builder bundles shell + engine (plain JavaScript) for `rune package`; a packaging-time tool, never a runtime dependency.

**Dev:** `typescript` 5.x, `eslint` + `@typescript-eslint`, `prettier`, `vitest` (unit + integration), `dependency-cruiser` for the import-boundary test, `@playwright/test` for the Electron smoke suite (shell lane only).

## 13) Extension points

**Now (MVP):** plain name→object registries — `inputs/registry.ts` for the seven `InputTypeHandler`s, which own empty/absence behavior, text/native coercion and validation, rendering, and condition comparison (including `pattern` and option membership — the engine-side authority), with mirrored presentation registries per frontend (`cli/prompt` prompters; the shell's field renderers keyed by input-type name in `gui-shell/src/renderer/`). Duplicate registration is an error. Adding an input type = register an `InputTypeHandler`, a prompter, and a renderer field component; frontends fail fast on types they cannot render. The zod schema validates *shape*; the registry owns type behavior, so a later plugin system is additive, not a core refactor. The MVP runner has only the engine-internal implementation/test seam described in §8; `Session.open` always selects the built-in spawn runner in production.

**Theming seam:** the CSS custom-property contract of the default theme plus `gui.theme` (§9.4). New looks are CSS, not code; RUNE guarantees the property names.

**i18n seam:** the `locales/<lang>.yaml` overlay mechanism and the reserved `rune.` key namespace (§6.3). A new language for a manifest is a new overlay file, zero code; a new chrome string in RUNE is a new catalogue key with an English default, which overlays may immediately override.

**Packaging seam:** `rune package` (§9.5) depends on exactly two contracts already in force — `${manifestDir}` anchoring and electron-builder bundling of the shell with the engine as plain JavaScript (the packaged engine is the same `@rune/engine` the CLI uses, hosted by the same main process).

**Later (documented reservation only — zero code now):** a plugin discovery mechanism for `input types`, `runners`, and `frontends` (npm packages declared by a naming convention or a `package.json` field) is reserved by this document. No discovery code ships in MVP; the spec lists plugins as explicitly non-MVP.

**How spec §8 features slot in without being built:**

- *Elevation, retries, rollback, step dependencies*: new `Step`/`execution` keys under a `schemaVersion` bump; v1 rejects them today with a "reserved" error, so adoption can never silently reinterpret v1 manifests. New versions land as `manifest/vN/` modules with pure object → object migration functions; the engine always consumes the newest internal model.
- *Step outputs* (`${steps.*}`) and engine variables (`${rune.*}`): namespaces syntactically reserved and rejected in v1. This feature will re-open the static-plan invariant (§6.1) and require a re-planning or two-phase design — the plan object and result schema are versioned now precisely so consumers survive that change.
- *New runners* (e.g. elevated, remote): the first real alternative reopens the internal
  interface and defines an explicit trusted-runner and secret-materialization contract before
  any runner injection becomes public. The MVP deliberately freezes no such backend API.
- *Other frontends*: in-process frontends are further clients of the `Session` facade (§9.1) — exactly what the CLI and the shell's main process are today. Out-of-process frontends (third-party UIs in other languages) would be served by a future stdio JSON-RPC server that projects the same facade and event stream 1:1 — zero code now; the facade being frozen as the frontend contract is the seam.
- *JSONL event log, macOS, custom pages*: new sink off the existing event stream (with a version field); a new platform key; a new page kind in the shell driven by new schema keys — all deferred wholesale.

## 14) Testing strategy

All suites run under **vitest** unless stated otherwise; core CI runs them on Windows and Linux with Node 22 LTS and no Electron.

- **Unit**: interpolation grammar (escaping, single-pass, placeholder tokens under `--platform`), condition parser/typechecker (golden good/bad expression tables, shared by step and input conditions), coercion per input type (incl. `pattern`, option values vs labels, comma-split vs JSON-array multiselect with malformed-JSON failure), precedence-chain merge with provenance, input-`when` evaluation (disabled ⇒ empty value, ignored-value provenance), state-transition legality, output-tail ring buffer bounds, counters (`stepsTotal = stepsExecuted + stepsSkipped + stepsNotRun`, `stepsExecuted = stepsSucceeded + stepsFailed + stepsCancelled` — incl. a cancelled run) / `nothingExecuted` (warned only for real runs, never for `planned` results).
- **Manifest golden files**: invalid manifests → exact expected `file:line:col` messages, exercising the zod-issue→SourceMap presenter (the acknowledged fiddliest component — budgeted, not assumed); includes input-`when` acyclicity violations, `pattern` on `secret`/non-compiling patterns, `gui:` asset paths, and unknown overlay keys located in the overlay file.
- **Schema tests**: the output of `rune schema` validates every fixture manifest that `validate` accepts and rejects every one it rejects (no drift by construction, checked anyway); `rune schema --result` validates every result file the suites produce.
- **i18n tests**: locale selection precedence (`--locale` > `RUNE_LOCALE` > system, with region→language fallback), per-key fallback chain for manifest and `rune.` strings, identical resolved strings through CLI rendering and `getStrings()` via the in-process parity client, golden assertion that ids/values/commands/args/env are byte-identical across locales in plans and result files.
- **Mode-parity contract suite** (release gate): fixture manifests — including conditional inputs, pattern inputs, labeled options, and locale overlays — run through the non-interactive driver, a scripted interactive CLI (`readline` fed from a stream: prompts **and** the summary edit loop), and a **scripted in-process client of the `Session` facade** making exactly the calls the Electron main process makes (the GUI leg); asserts byte-identical `ExecutionPlan` JSON, event sequences plus the `InputStateChanged` lists returned by `setValue` where values change, and result files (modulo timestamps, run ids, the `mode` field, and per-input `source` provenance, which necessarily differ between legs). Because the GUI leg drives the facade, not pixels, it runs in core CI on Windows and Linux with no Electron — cheaper and more deterministic than driving a window, and it tests precisely the surface the shell depends on. An **IPC-bridge unit test** in the shell package pins that the preload API is a 1:1 projection of that facade (same method set, same event set, secrets masked towards the renderer) and that every payload is a bridge projection — a raw `SecretString` never reaches `webContents.send` or an invoke return (§9.2). It runs under vitest in core CI with `electron` stubbed (`contextBridge`/`ipcMain`/`ipcRenderer` mocked — no Electron binary), so the projection and the masking towards the renderer are enforced on every PR.
- **Static-safety lint test**: ESLint `no-restricted-syntax` / `no-restricted-properties` rules (AST-level, stronger than grep) banning `eval`, `new Function`, `child_process.exec`/`execSync`/`execFile` with a shell, and any `spawn` with `shell: true`; the lint run is part of the test gate. The shell-based `child_process` APIs are banned in **every** module form — named, namespace and default `import`, dynamic `import()`, and `require()` — because a single unguarded form (`import cp from 'node:child_process'`) would hand out `cp.exec` unchecked.
- **Import-boundary test**: dependency-cruiser enforces §3's dependency directions — `@rune/engine` (`manifest`/`inputs`/`i18n`/`engine`/`runners`/`results`/`logs`/`errors`) never imports `cli` or `gui-shell`; `cli` imports the engine only through its public API; `gui-shell/src/renderer` never imports the engine (only the preload bridge's type declarations). Every workspace package name is mapped to its sources in the root `tsconfig.paths.json` (the single source of truth shared by the cruise, `tsconfig.test.json` and the vitest aliases), and a suite asserts that mapping is complete: an unmapped name would resolve into that package's `dist/` output, be dropped as excluded, and silently make the rules above vacuous.
- **Version-constant test**: the version constants exported by the packages (`RUNE_VERSION`, `RUNE_CLI_VERSION`) are asserted equal to their own `package.json` version, so a release bump cannot leave the CLI banner, `rune --version` or result-file provenance reporting a stale number.
- **Exit-code reachability**: every code in §10's table produced by at least one test (incl. RUNE-002 / exit 2 for an unsupported host platform, exit 2 for `--gui` without the shell, for a cached shell whose engine version differs from the CLI's (§9.4), and for `--gui --result -`, and exit 0 with `nothingExecuted: true`); the result-file status↔exit-code mapping of §10 (including the `dryRun` disambiguation of exit 0) checked case by case against the generated result JSON Schema.
- **Masking suite**: secrets absent from console, log file, result file (incl. `outputTail`), dry-run output, main→renderer IPC payloads (via the bridge unit test), and child-stdout echo scenarios; terminal output also covers registered literals created only by visible control escaping in dry-run titles and live step output.
- **Runner integration on real Windows and Linux CI**: argv quoting, `.bat`/`.cmd` refusal, the exact 64 KiB UTF-8 logical-line limit (single placeholder, discard through newline, recovery, CRLF/EOF and independent-stream behavior), a real default-runner-to-Executor masking regression with a secret crossing the omission boundary, and timeout/cancel process-tree kill — `taskkill /T /F` on Windows, SIGTERM then SIGKILL on the process group on Linux (the flakiest platform surface — tested, not hoped).
- **Electron smoke suite** (dedicated shell lane, Node 22 LTS + Playwright for Electron; skippable on regular PR CI, required for a release of the shell): field renderer per input type, greyed-out disabled fields flipping on the `InputStateChanged` list resolved by `rune.setValue`, red pattern state with `patternHint` and disabled `Next`, label display vs value submission, the three theming layers (default, `gui:` overrides, author CSS), light/dark, cancel-during-output-flood, close-window-during-run, a `RuneError` inside the shell shown as a named error with its exit code, a hard shell crash → exit 70 without result file, headless `--non-interactive` run of the same artifact, exit-code forwarding through `rune run --gui`.

## 15) Invariants (must never break)

1. One Planner, one Executor: GUI, interactive CLI, and CI share them; no frontend-specific execution or planning path exists. Anything not expressible as "supply values" + "render events and engine-resolved strings" does not ship.
2. Commands are argv arrays end to end; `shell: true`, `exec`/`execSync`, `eval`, and `new Function` never appear in the codebase (ESLint AST-rule-enforced); `.bat`/`.cmd` are refused, not silently shelled.
3. Interpolation of `command`/`args`/`cwd`/`env` and step-condition evaluation happen exactly once, at plan time; input conditions and input `default` interpolation (built-ins and `${env.*}` only, no input references) happen once in the resolution stage, before prompting, and are final when the input set is frozen for planning; resolved values are never re-scanned for `${...}`; the plan is fully static.
4. Dry-run renders the identical plan object that execution consumes — no fake runner, no second interpolation pass.
5. Only declared `boolean` inputs may stand bare in `when:`; conditions are strictly typed and fully checkable at `validate` time; an input's `when:` references only earlier-declared inputs.
6. Secrets are wrapped at resolution, registered for masking before any step can launch, masked in every sink (console, log file, result file incl. output tails, plan previews, child output, main→renderer IPC payloads — the only clear-text crossing is the renderer→main `rune.setValue` call, which is never logged), and revealed only at spawn inside the runner.
7. Every value affecting execution passes through the one resolution chain with recorded provenance; all authoritative input validation — type coercion, option membership by `value`, `pattern` full-match, JSON-array parsing — lives in the engine's input-type registry; frontend checks (CLI re-prompts, GUI red fields) are presentation sugar that may only re-ask, never accept.
8. RUNE never blocks a pipeline: no TTY ⇒ non-interactive behavior; missing inputs ⇒ exit 4 with the complete list and accepted sources; resolution is all-or-nothing before any side effect.
9. Exit codes are fixed, cross-platform identical, free of `128+signal` arithmetic; for every configured run, the result file's `status` determines the exit code, and the exit code plus `dryRun` determine the `status`, exactly per §10's mapping table; the result file is written atomically on every configured-run outcome, while usage and unsupported-host errors write none and a failed result-file delivery (RUNE-407, exit 1) leaves none — there the exit code and the stderr diagnostic are the only signals.
10. stdout carries only requested machine output; everything else goes to stderr.
11. The GUI renderer contains no engine logic and reaches the engine only through the IPC bridge, a 1:1 projection of the `Session` facade and events; the engine package (`@rune/engine`: `manifest`/`inputs`/`i18n`/`engine`/`runners`/`results`/`logs`/`errors`) never depends on `cli` or `gui-shell`.
12. Unknown manifest keys are rejected with located errors (reserved keys with a "later schemaVersion" message); unknown locale-overlay keys are located errors; unknown `--set`/values keys are hard input errors — nothing silently no-ops.
13. Relative `command`/`cwd`/script/asset paths resolve against the manifest's directory, never the caller's cwd — in the author's tree and inside a packaged artifact alike.
14. Step state transitions follow the legal-transition table, monotonic, exactly one terminal state per step, at most one step `RUNNING`.
15. `RunStarted`/`RunFinished` bracket every execution exactly once; run events are synchronous and in-order; observer exceptions are swallowed; no run event is delivered after the `execute()` promise settles.
16. A disabled input (false `when:`) has identical semantics in all three modes — not required, never prompted, resolves to its type's empty value, supplied values ignored with a warning and recorded provenance; frontends differ only in how they show it (greyed field, skipped prompt, nothing).
17. The engine owns locale selection and text resolution; every frontend renders the strings the engine resolved; ids, option values, commands, args, env, cwd, paths, and every machine contract are never localized.

## 16) Deferred decisions

Everything previously listed here has been decided and folded into the sections above. Genuinely open, to be decided when the respective milestone starts:

1. **`rune package` internals** (milestone 4) — electron-builder configuration and artifact layout; the contract of §9.5 is fixed, the mechanics are not.
2. **Per-platform artifact formats** — Windows: portable `.exe` + folder vs. single zip; Linux: AppImage vs. tar.gz.
3. **GUI shell auto-update** — whether `rune run --gui` ever checks GitHub Releases for a newer shell, or updates stay explicit `rune gui install` re-runs.
