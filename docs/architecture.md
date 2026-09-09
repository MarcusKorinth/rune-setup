# Architecture

This document is the canonical architectural contract for **RUNE** ("Runtime for User Guided and Non Interactive Execution") — a declarative installer and setup-workflow engine written in TypeScript.

It defines decisions, boundaries, and invariants. Engine, CLI, and GUI shell: **TypeScript 5.x in strict mode** (`"strict": true`, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`) on **Node 24 LTS**; one **npm workspaces** monorepo (`packages/engine`, `packages/cli`, `packages/gui-shell`, cross-package `tests/`); vitest, eslint (+ `@typescript-eslint`), prettier. The GUI shell (§9.4) is an Electron application whose main process hosts the engine in-process — one language, one runtime. MIT license.

Packaged OS entrypoints contain no workflow behavior. The Linux POSIX launcher selects
Electron's headless backend. The Windows native launcher transports arguments, streams,
exit status and close requests to Electron, removing only its documented initial CRLF
before any application output. Application code and the engine remain TypeScript in
the Electron main process; the launcher requires no separately installed runtime.

Use this reference by topic:

- **Author a workflow:** [manifest fields](#4-manifest-contract), [value precedence](#5-value-resolution),
  and [interpolation, conditions, and localization](#6-interpolation-condition-and-text-resolution-semantics).
- **Understand a run:** [step lifecycle and cancellation](#7-execution-model),
  [process execution and termination](#8-runner-layer), and [results and exit codes](#10-automation-contract).
- **Build a frontend:** [Session API](#91-session-facade-and-events),
  [Electron bridge](#92-electron-ipc-bridge-main--renderer), and [shell lifecycle](#94-gui-shell-electron).
- **Review security boundaries:** [logging and masking](#logging-and-secret-masking),
  especially [path spellings](#path-spellings) and [masking limitations](#masking-limitations).

For release acceptance, use [releasing.md](releasing.md). For a shorter introduction,
start with the [README](../README.md).

## 1) Purpose and boundary

RUNE executes YAML setup workflows through an interactive CLI, a non-interactive CLI,
and an Electron wizard. Workflow authors supply the commands, scripts, and payload.
The engine owns input resolution, validation, planning, execution, and results.

This document specifies behavior and boundaries. It is not evidence that a release
is complete. Distribution and verification requirements are listed in
[releasing.md](releasing.md).

The implementation includes the seven input types, conditional inputs and steps,
safe interpolation, localization, argv execution, logs and results, and the three
frontends. GUI archives use the version-tag release workflow; public npm installation
still requires a package namespace and publication. Portable workflow packaging is
described in §9.5.

The current manifest schema excludes rollback, uninstall, repair, elevation, retries,
parallel steps, dependencies between steps, step outputs, custom pages, and plugins.
Reserved keys are rejected with a later-schema-version diagnostic. RUNE does not
produce MSI/NSIS/system packages or promise transactional rollback or code signing.

Manifest schema version (1), result schema version (2), and product SemVer are
independent. A version number alone does not establish release readiness; that is
determined by the delivered artifacts and acceptance checks.

## 2) Core principles

1. One engine decides execution behavior in every frontend. Frontends supply values
   and render engine projections; the GUI renderer communicates through IPC.
2. Commands are argv arrays. Implicit shells, code evaluation, and repeated
   interpolation are forbidden.
3. Inputs follow one precedence chain. Conditions are typed and checked before any
   step executes; unknown manifest and value keys are rejected.
4. Non-interactive operation never prompts. Process and stream lifetime behavior is
   specified separately in §8; non-interactive does not imply a universal deadline.
5. Declared secrets are masked at sink boundaries, with the exact machine-field
   exceptions and transformation limitations documented in §10.
6. Schema changes must not silently reinterpret existing manifests.

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
- `cli` imports the engine only through its public API (`Session`, the event types (the `RunEvent` union and its per-kind members), `errors`, the value types the facade returns — `ExecutionPlan`, `RunResult`, `InputState`, `ValueSource`, `StringTable`, `ThemeConfig` — plus `formatSessionTerminalLine` for authenticated terminal projection, `validateManifest()` and `formatLocation` for `validate` — the report's `.warnings` are the value-free manifest warnings and its `.environment` is the audit report — `manifestJsonSchema()`/`resultJsonSchema()` for `rune schema`, `serializeResult`/`writeResult` (§10), `createFailureResult` for failure results, and `sameSinkPath`/`RESULT_LOG_COLLISION_MESSAGE` for shared result/log collision refusal) and drives it exclusively through the `Session` facade plus one observer interface (`EngineObserver`).
- `gui-shell/src/main` (Electron main process) imports `@rune/engine` the same way the CLI does and hosts it in-process; `gui-shell/src/preload` exposes the IPC bridge (§9.2) — a 1:1 projection of that same facade and event stream — through `contextBridge`; `gui-shell/src/renderer` never imports the engine (only the bridge's type declarations) and never reads the manifest, `locales/`, or values files itself. There is no GUI-only engine surface and no engine sidecar process: the engine package never depends on the shell, and core, CLI, and CI never see Electron.
- Everything downstream of the `ExecutionPlan` is frontend-agnostic; dry-run is "build the plan, render it, stop" — by construction, what dry-run shows is what run would execute.

## 4) Manifest contract

### 4.1 Canonical CLI verbs

**`run` is canonical; there is no `install` alias.** The manifest path is positional.

```
rune validate installer.yaml [--locale TAG]
rune run installer.yaml [--gui] [--non-interactive] [--dry-run]
                        [--set key=value]... [--values file.yaml]...
                        [--result path|-] [--log-file path] [--locale TAG]
                        [--platform windows|linux]     # dry-run only
rune schema [--output FILE] [--result]   # manifest JSON Schema (v1); --result: result-file schema
rune gui install                         # author-time: fetch the prebuilt GUI shell into the per-user cache
rune package installer.yaml --output ARCHIVE [--shell DIRECTORY] [--include PATH]...
rune --version
```

The current CLI implements `validate`, `schema`, and both the interactive and
non-interactive forms of `run`, including dry-run, plus `--gui`, `gui install`, and
host x64 workflow packaging.

Mode selection: default is interactive CLI on a TTY; `--gui` is explicit opt-in (if the GUI shell is not present in the per-user cache, exit 2 with the hint to run `rune gui install`); `--non-interactive` never prompts. If a prompt would be needed and stdin is **not** a TTY, RUNE auto-degrades to non-interactive (§10). GUI is never auto-selected. `--platform` is accepted only with `rune run --dry-run`; real execution refuses it. `--gui` combines with neither `--non-interactive` nor `--dry-run` — both combinations are usage errors (exit 2); dry-run always renders through the CLI renderer. `--gui` also refuses `--result -` (usage error, exit 2) — by policy: a GUI run carries no stdout contract (a windowed Electron process may emit its own diagnostics and stdout attachment differs per OS, and the stderr pass-through of §10 is best-effort diagnostics, not a machine contract); use `--result path`, which the engine writes exactly as in every other mode (§9.4).

For a real run, a non-stdout `--result` destination must differ from the effective log-file
destination after both have been anchored to absolute paths. An exact collision is a usage error
(exit 2). One rule governs when: each half is refused as soon as its anchored path is knowable,
and never later. The `--log-file` spelling is an argument-level fact, so it is refused at
invocation, before the session is opened; the manifest's own `execution.logFile` is anchored by
`Session.open` as soon as the manifest parses, so the host hands `open` the destination it will
deliver to (`resultDestination`, §9.1) and the engine refuses that half right there — before the
locale overlay, the values files, input resolution, or planning can fail. No run that fails after
its manifest parses can deliver its result onto the path the operator named as the log, and both
halves are refused before execution or either sink is opened. A manifest that never parses
configures no log file at all, so that invocation has no effective log destination to collide
with. Comparison is case-insensitive on Windows and
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

The model layer uses **zod** schemas: `.strict()` objects (unknown keys rejected — the reject-unknown-keys posture for free) and discriminated unions (`InputSpec` on `type` via `z.discriminatedUnion`; `run:` as the mutually exclusive `CommandSpec | PlatformRunBlock` via `z.xor`; `options` items as `string | OptionSpec`). The exclusive run union preserves both branches' validation issues for presentation and emits JSON Schema `oneOf`; their strict key sets already prevent overlap. Error presentation is owned by RUNE, not zod: `loader.ts` builds a `SourceMap` from the `yaml` document's node ranges (JSON path → `file:line:col`), and a presenter maps every zod issue path onto it and renders e.g. `installer.yaml:41:7: steps[2].run.windows.args must be a list of strings`, with did-you-mean suggestions (a small edit-distance helper) for unknown keys. Manifest keys are camelCase and so are the TypeScript fields — no alias layer. The same zod schemas are the source of `rune schema` (§4.1). Shape and semantics stay apart: the schemas describe shape only, and every cross-field rule lives in `rules.ts`, which keeps the generated JSON Schema a faithful description of what `validate` accepts.

Loader hardening: `yaml` (eemeli) with the **core schema only** — plain YAML, no custom tags, no code execution, and known tags left unresolved so an explicitly tagged YAML 1.1 value (`!!binary`, `!!timestamp`) is an error rather than a Buffer or a Date. Duplicate mapping keys, keys that are not plain non-empty scalars (the parser folds a collection key and an empty key into one stringified entry) and `__proto__` are all located errors. The parser's own `uniqueKeys` option is deliberately **off** — its per-key rescan is quadratic, so a flat one-megabyte mapping would cost tens of seconds and the size cap would bound nothing; the duplicates are found instead in the single walk that already records every document path. UTF-8 required; file-size cap. Locale overlays and values files go through the same loader.

Semantic rules (after model validation, all errors collected, not first-fail): unique step ids; select/multiselect `default` ⊆ option values; `secret` inputs may not declare `default`; every `${name}` reference resolves to a declared input or built-in (static check at `validate` time); every `when:` — on steps **and on inputs** — parses **and type-checks** against declared input types; an input's `when:` references only built-ins and inputs declared earlier (acyclicity; declaration order = evaluation order); `pattern` compiles as an ECMAScript `RegExp` — always with the `u` flag, here and wherever a supplied value is later matched against it, because the flags decide which patterns exist at all and a pattern accepted by `validate` but rejected at the prompt would break mode parity — and is absent on `secret`; a `patternHint` without a `pattern` is rejected (it could never be shown); `RUNE_INPUT_*` env-name collisions between two input ids are a validation error; every locale-overlay key addresses an existing localizable path of this manifest or a known `rune.` chrome key (an unknown key is a located error in the overlay file — invariant 12 applies to overlays too; `rune validate` loads and checks **every** `locales/*.yaml` file next to the manifest regardless of `--locale`, whereas `run` loads only the selected locale's overlay and its language-only fallback — a `--locale` with no matching overlay is not an error, every string simply falls back); a Windows drive-relative `execution.logFile` (`C:run.log`) is rejected (§10); a warning is emitted when a `secret` input is interpolated into process argv — either `command` or `args` — because argv can be visible in OS process listings (`env:` is the recommended carrier).

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

Each layer is more specific to the invocation than the preceding one. In particular,
`--set` overrides `RUNE_INPUT_*` variables inherited from a CI image.

Values files (layer 2) are YAML documents parsed with the same hardened loader as manifests (§4.3): each file is a single **flat mapping of input id → value** — no nesting, no sections, no per-file metadata. Values may be written natively in the input's declared type — `boolean` as a YAML bool, `multiselect` as a YAML list of strings, everything else as a YAML string — or as strings, which take the same registry coercion path as layers 3–4. Any other shape (a mapping as a value, a list for a non-multiselect input, a non-string list item, a bare integer where a string is expected) is an input error naming the key, a safe shape or type category, and the file and position (exit 4, RUNE-202). The diagnostic never echoes the raw value: before the key is associated with its declared input type, that value may be a secret.

Coercion (layers 3–4 deliver strings) is owned by the input-type registry: booleans accept `true/false/1/0/yes/no` case-insensitive; select values are matched against option **values**, never labels; multiselect **comma-splits by default** and validates each item against option values — and if the string starts with `[`, it is instead parsed as a **JSON array of strings** (`--set tools='["a,b","c"]'`), the escape hatch for values containing commas; malformed JSON is an input error (exit 4, RUNE-202) and **never** falls back to comma-splitting; `text` values are full-matched against `pattern` when declared; file/directory stay strings (existence checks are the manifest author's concern via a step — frontends may *hint*, never enforce). Coercion or pattern failure names the key and source layer (exit 4). A non-secret value may be quoted only after registry masking; a secret value remains opaque. Unknown keys in `--set` or values files are **hard input errors**, never warnings.

**Disabled inputs.** Input `when:` conditions are evaluated during resolution, in declaration order, against the values resolved so far (an input's condition can only see inputs declared before it, §6.2). An input whose condition is false is **disabled**: it is not required, it is never prompted, and it resolves to its type's empty value (§4.2). These semantics are identical in all three modes — the frontends differ only in rendering: the GUI shows the field greyed out (visible, not editable) and re-evaluates live when a controlling input changes (`InputStateChanged`, §9.1); the interactive CLI skips the prompt; non-interactive treats it as not required and raises no error if it is missing.

If a value for an input that is disabled **once the input set is final** was supplied through any layer 2–5 (`--values`, env, `--set`, or an interactive answer given before a controlling input was changed), RUNE records an engine-owned **warning**, **ignores** the value, and records the input in the result file with the effective empty value, the `source` layer that supplied the ignored value, and `ignored: "input disabled"` (§10). Human warning delivery follows the masking rules in §10: when an opened Session fails before a completed plan, the CLI suppresses additional warning lines while retaining the engine warning state. The decision is taken at the end of resolution, not at first merge — an interactive edit that re-enables an input makes its seeded value effective again, with no spurious warning. This is deliberately not a hard error — CI matrices share values files across variants that enable different inputs — and always recorded as a warning.

**Required values.** An empty string leaves a required `text`, `secret`, `select`,
`file`, or `directory` input missing; an empty selection does the same for `multiselect`.
For example, `RUNE_INPUT_TOKEN=` does not satisfy a required secret. A `boolean` is never
absent: `false` is a valid answer.

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

**Foreign-platform preview (`--platform`).** When `rune run --dry-run` previews a platform other than the host, host-dependent built-ins render as visibly marked **placeholder tokens** — `<home@linux>`, `<temp@windows>` — rather than the host's real values, which do not describe the target. The dry-run output states that the plan is a cross-platform preview, and the result file marks it (`"crossPlatformPreview": true` in the run block, §10). Placeholders never reach execution: real runs refuse `--platform` (§4.1).

Interpolable fields, exhaustively: `command`, each `args` item, `cwd`, `env` values, input `default`s, and variable references inside `when:`. Nothing else — in particular no `title`, `description`, `patternHint`, option labels, or `gui:` paths. String-context rendering stringifies (boolean → `true`/`false`; multiselect → comma-joined); inside `when:` a reference keeps its declared type.

**Resolution timing:** interpolation of `command`/`args`/`cwd`/`env` and step `when:` evaluation happen **exactly once**, in the Planner, after all inputs are final and before any step runs — never at YAML load, never lazily during execution. Two things are evaluated earlier, in the resolution stage, because they decide what is prompted and prefilled — and both are final the moment the input set is frozen for planning: input `when:` (the one condition kind evaluated there) and input `default` interpolation (built-ins and `${env.*}` only, no input references; rendered once, before prompting, so the rendered default is what the GUI/CLI prefill and what layers 2–5 override; an undefined `${env.NAME}` in a default is RUNE-301, exit 5, at resolution). Resolution is single-pass: resolved values are never re-scanned for `${`, which closes injection-via-input-values. Consequence: the plan is static and shared by all three frontends; dry-run projects the argv `run` will spawn, with secrets masked (§10).

### 6.2 Condition language (`when:`)

A closed, hand-written expression language: tokenizer and recursive-descent parser in `engine/conditions.ts` producing a small AST. **No `eval`, no `new Function`, no template engine.** Expression length capped (4 KiB) and parse depth capped. One grammar, one evaluator, two sites: `steps[].when` and `inputs.<id>.when`.

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

No functions, arithmetic, regex, attribute access, or indexing. **Typing is strict:** a bare `${x}` is valid only if `x` is a declared `boolean` (`when: "${installDatabase}"`). Strings and selects are never implicitly truthy — `when: "${environment}"` fails with the hint *compare explicitly: `${environment} == 'production'`*. `==`/`!=` require both sides same type; `in` tests string ∈ multiselect. Because input types are declared, **every condition type-checks at `rune validate` time with zero values supplied**.

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

`rune validate` = stages 1–2 (fully static), followed by the environment-variable audit report (§4.3). `rune run --dry-run` = stages 1–4, rendering the plan (final argv with secrets masked, cwd, skip reasons, disabled inputs) and executing nothing. Dry-run and run share the same plan object; dry-run does not invoke a runner.

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

`CancelToken` exposes `cancel()`, `isCancelled`, and `onCancel(listener)` around a boolean
flag and an `AbortSignal`-style listener list. Cancellation is cooperative on the Node
event loop and needs no threads.

**Requests.** The GUI Cancel button calls `rune.cancel` over the bridge; the CLI's first
`Ctrl+C` and headless SIGTERM request the same cancellation. The Executor checks the
token between steps. A live child uses the confirmed process-group/tree termination
path in §8. Closing the GUI window during a run calls `Session.cancel()` and awaits
`RunFinished` before exiting. A second `Ctrl+C` force-exits.

**Completion.** After the termination operation, the runner waits at most 5 s for the
direct child's `close` event. If that wait expires, confirmed termination preserves the
original cancellation, timeout, or stream-failure cause; it cannot make an unconfirmed
termination successful. An unconfirmed operation is the fatal `terminationFailed`
outcome in §8. A timeout uses the same kill path but makes the step `FAILED` (RUNE-402).

**Outcome precedence.** A confirmed cancellation makes the current step `CANCELLED`,
remaining steps `NOT_RUN`, and the run `cancelled` with exit 6. Any earlier `FAILED`
step takes precedence: the run stays `failed` with exit 1.

- A runner-reported non-success exit after a cancellation request also makes the step
  `CANCELLED`, with a null exit code. This covers an internal runner that ignores the
  token; `SpawnRunner` owns its kill path and reports `cancelled` or `terminationFailed`.
- An exit reported before the request stays `FAILED`. On Windows, console `Ctrl+C`
  reaches a console-attached child as well as RUNE. If the child's `close` is processed
  before RUNE's SIGINT handler, the step is `FAILED` with `STATUS_CONTROL_C_EXIT` and the
  run is `failed`, exit 1.

## 8) Runner layer

The engine currently has **one runner**: `runners/spawnRunner.ts` behind a minimal engine-internal
`Runner` interface (`run(SpawnRequest): Promise<SpawnOutcome>`). The interface and its
injection point are implementation/test seams inside the engine, not part of the package-root
API or `SessionOptions`. There is no public trusted-runner or secret-reveal capability;
that contract is decided only when the first real alternative runner is designed. No
per-interpreter runner classes (powershell/shell/cmd modules) — each step is one argv
spawn, and interpreter-selection magic would reintroduce implicit command interpretation
against the spec's own security rule.

Process contract:

- `child_process.spawn(command, args, { shell: false, ... })` uses argv arrays and never
  an implicit shell. Process exit and stream completion are awaited on the Node event
  loop without worker threads or synchronous process/stream I/O. Synchronous CPU work
  in the Session lifecycle is described in §9.1.
- Normal completion waits for stdout and stderr to reach EOF, including pipes inherited
  by descendants after the direct process exits. There is no implicit deadline for this
  wait. `timeoutSeconds` remains active until output has been delivered; cancellation also
  remains available. Authors starting background services must redirect their streams or
  configure a timeout when the workflow needs a bounded completion time.
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
- stdout/stderr are consumed as streams and line-split with a **64 KiB (65,536 UTF-8 byte) payload limit per logical line**, independently per stream. At the first byte over the limit, the runner clears that line's retained content, emits exactly one fixed value-free line (`[output line omitted: exceeds 64 KiB]`), discards through the next real `\n`, and then resumes normally; EOF while discarding emits nothing further. Lines at or below the limit retain their existing semantics, including CRLF stripping, empty lines, and an unterminated final line. The runner never emits raw fragments at artificial boundaries, so each callback is either one complete bounded logical line or that placeholder and the Executor can pass the whole callback through the secret masker **before anything else sees it**. Persistent per-stream state is bounded; output is never buffered whole. If the bounded child-close wait after termination expires, each reader stops accepting fresh pipe data after its current chunk plus one snapshot of its already-buffered readable content. Those accepted bytes still drain serially through complete logical lines and sink Promises; an incomplete line at this artificial cutoff is discarded rather than exposed as a raw fragment. Natural EOF behavior is unchanged.
- success ⇔ exit code ∈ `successExitCodes` (default `[0]`)
- startup failure classification is value-free: a missing, non-directory, or NUL-containing
  `cwd` is `invalidCwd` (RUNE-404); `ENOENT` retains the cwd check that distinguishes a
  missing command from an invalid cwd; other platform startup failures remain unclassified
  execution failures (RUNE-401)
- Windows `.bat`/`.cmd` files require a shell and are refused (RUNE-405). The check runs
  at plan time on the final interpolated `command`, including `--dry-run`, with a spawn-time
  backstop in the runner. The diagnostic tells authors to invoke the interpreter explicitly:
  `command: cmd, args: ["/c", ...]`.
- secrets are revealed (unwrapped) only at spawn, inside the runner

### Process termination

Cancellation, timeout, and output-stream failure use the following platform rules.

**POSIX process groups.** Children use `detached: true`. The guarantee covers the spawned
process group, excluding descendants that deliberately leave it.

1. Send `process.kill(-pid, 'SIGTERM')`. Only `ESRCH` confirms an already absent group;
   `EPERM`, `EACCES`, and all other signal errors are unconfirmed failures.
2. After a sent SIGTERM, poll `process.kill(-pid, 0)` for up to 5 s. Only `ESRCH` confirms
   absence during this grace period. A Linux `/proc` snapshot cannot end the grace period:
   a signal handler could still fork another group member.
3. If the group remains, send SIGKILL. An already absent group is confirmed; a signal
   failure is not. A sent SIGKILL allows a further 5 s for confirmation. Only in this phase
   may Linux `/proc` probes distinguish live members from zombies. Ignore disappearance
   races (`ENOENT`/`ESRCH`); treat restricted or otherwise unclear scans as a live group.

Each wait installs its watchdog before the first probe, so a stuck probe cannot evade
the deadline.

**Windows process trees.** Spawn `<SystemRoot>\System32\taskkill.exe /PID <pid> /T /F`
with argv and `shell: false`. Read `SystemRoot` case-insensitively from the run's frozen
parent-environment snapshot. It must be a non-empty, normal fully qualified drive or UNC
path, excluding current-drive-relative roots and device namespaces. Never locate the
helper through `PATH`, `WINDIR`, discovery, or a default.

Helper exit 0 confirms termination. A direct child that ends before or during the helper
also counts as absent. Windows children remain attached to RUNE's console: `Ctrl+C` can
end a child before the helper runs; §7 defines the outcome when `close` precedes RUNE's
SIGINT handler. Descendants that outlive an ended direct child are outside this guarantee,
because the helper cannot enumerate the tree of a process that is gone. This is narrower
than the POSIX process-group guarantee.

**Unconfirmed termination and handle release.** On either platform, an unconfirmed
operation makes one immediate best-effort direct-child SIGKILL if the child still has a
PID and has not ended, then returns `terminationFailed`. The subsequent child-`close`
wait is bounded to 5 s and cannot change that outcome. On expiry, release the runner's
stdio endpoints and child handle so inherited pipes cannot keep the host alive.

`terminationFailed` is fatal: the current step is `FAILED` with RUNE-401 and a null exit
code; every later pending step is `NOT_RUN` regardless of `failFast`; the run is failed.
A confirmed operation preserves its original cause even if the child-`close` wait expires.

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
    resultDestination?: string;            // where a real run's --result file goes; open refuses
                                           // a collision with the effective log file (§4.1)
    environment?: Readonly<Record<string, string | undefined>>; // defaults to process.env
    systemLocale?: string;                 // host locale; defaults to Intl (injectable for hosts/tests)
  }): Promise<Session>;
  readonly manifest: Manifest;
  readonly mode: 'gui' | 'interactive' | 'non-interactive';
  readonly platform: Platform;                    // selected target platform
  readonly preview: boolean;                      // true for a foreign-platform session
  readonly effectiveLogFile: { readonly path: string; readonly announcement: string } | undefined;
                                                  // anchored --log-file, else execution.logFile,
                                                  // beside the spelling its supplier wrote (§10)
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
binding retains a live masking closure, so a table obtained before planning or a successful
`setValue()` uses the current resolution or completed-plan secret registry on its next call. The
helper exposes neither that closure nor the registry and is not projected over the Electron bridge.
The entries returned by `getStrings()` are static resolved labels and catalogue templates. Runtime
GUI chrome is composed in the Electron main process with the exact session table's `chrome()`
accessor after the underlying machine object has first been projected to JSON-safe data. Main may
then use `formatSessionTerminalLine()` locally for complete human-only presentation fields. Neither
the formatter nor the masker crosses IPC; only the resulting complete display string does.

`effectiveLogFile` is the frozen pair the session logs through: the anchored `path` its sink
opens, beside the `announcement` its supplier wrote — the spelling every sink names (§10). It is
`undefined` when neither `--log-file` nor `execution.logFile` is configured, and it is readable
the moment `open()` returns, which is what lets a host name the log in a plan preview without
re-deriving that precedence. Anchoring stays engine-owned: a manifest-relative
`execution.logFile` resolves against the manifest's directory, so a host that re-derived it would
resolve against its own working directory instead (invariant 13) — which is also why §4.1's
`--result` collision is refused by `open` itself, from the `resultDestination` the host passes,
at the point inside `open` where the anchored path first exists. It is a facade field like
`manifest`, `mode`, `platform`, and
`preview`: §9.2's bridge projects facade *methods* and run events, this adds neither, and
invariant 11 forbids only the reverse — behavior reachable on the bridge that the facade lacks.
The bridge therefore needs no entry for it.

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
identities and remain byte-exact even when their text collides with a secret. Rejection candidates,
messages, and locations are masked copies.

Every successful resolution publishes one deep-frozen
`allInputs` array and one `pendingInputs` array that share their frozen state objects, projected
with the resolution's secret registry. The first successful plan for that resolution atomically
publishes both the completed plan and a fresh pair projected with that plan's authenticated
complete secret registry, including secret spellings derived during path anchoring. Repeated reads
retain both array identities until the next successful edit, which publishes the next
resolution-only pair and invalidates the plan, or until the first successful plan of that next
resolution publishes its plan-masked pair.

A failed plan or rejected edit publishes neither a plan
nor input snapshots. Previously returned snapshots remain frozen and unchanged: a historical
pre-plan snapshot can therefore retain a public value that collides only with a secret spelling
derived later during planning. Its masking records what was knowable when that phase snapshot was
created; frontends re-read the current snapshots after a successful plan.

The engine is **asynchronous**: `Session.open()` and `execute()` return Promises and run on the Node event loop. Their lifecycle performs no synchronous filesystem, process, or stream I/O; those operations are awaited so the CLI process or Electron main process stays responsive. Bounded in-memory YAML decoding/parsing, zod validation, and input/plan resolution remain CPU work on the event loop — RUNE neither promises nor introduces worker threads for them. The separate synchronous authoring APIs `parseManifest()` and `validateManifest()` keep their existing contract.

Events are frozen plain objects (`readonly` types, `Object.freeze`d). **Run events**, delivered through `EngineObserver` during `execute()`: `RunStarted(plan)`, `StepStarted(stepId, index, total, title)`, `StepOutput(stepId, stream, line)` (one complete bounded logical line or the fixed §8 placeholder, pre-masked), `StepFinished(stepId, state, exitCode, durationMs)`, `RunFinished(result)` — durations are milliseconds everywhere (events, IPC payloads, result file `durationMs`). `StepFinished` is terminal-only: `SUCCEEDED` carries a numeric exit code, `FAILED` carries a numeric code or `undefined`, and `SKIPPED`, `CANCELLED`, and `NOT_RUN` carry `undefined`. Elapsed durations use a monotonic clock and are non-negative; ISO timestamps use the wall clock and can reflect clock adjustments. Plan-time `SKIPPED` steps emit exactly one `StepFinished(state=SKIPPED)` and no `StepStarted`/`StepOutput`; `total` counts all planned steps including skipped ones — progress renderers and the mode-parity suite rely on both rules. `title` is the localized title (§6.3); `stepId` is never localized.

**Session event:** `InputStateChanged(inputId, enabled)` is produced by `setValue()` and **returned to the caller** — over the IPC bridge it is the resolved value of `rune.setValue`, and there is deliberately no separate push event (one delivery, nothing to double-apply) — whenever an input's `when:` flips because a controlling value changed. It belongs to the resolution phase, not to execution: it is never delivered through the run-event observer and does not count against the `RunStarted`/`RunFinished` bracket.

**Observer delivery contract:** run events are delivered serially in order. An observer
may return a native Promise; the engine waits for it before delivering the next event.
Other return values are ignored. Thrown errors and rejected Promises are contained per
sink, so a failed frontend cannot change the execution outcome. A slow, healthy sink
applies backpressure: the runner awaits line delivery before reading further from that
pipe, allowing OS pipe buffering to slow the child. Both stdout and stderr retain at most
one chunk under processing plus their bounded readable buffers and the existing 64 KiB
logical-line state. No output is dropped because a sink is slow. The documented replacement
of oversized logical lines remains unchanged.

Immediately before RunStarted, the Executor freezes the parent environment snapshot.
RunStarted is first and RunFinished is last, exactly once each. All accepted output and
observer Promises finish before step/run settlement; no event follows execute settlement.
Session waits for log writes and finalization before its terminal frontend event. A log
finalization failure retains the actual step states in the sole failed RunFinished and
then rejects with the corresponding RuneError. Observer latency contributes to execution
wall time and can therefore trigger a configured timeout. Cancellation still signals the
child while a sink is pending; completing the run waits for accepted output to drain.
A sink which closes or errors releases its pending writes under its existing failure
contract. A healthy sink which never resumes can delay finalization for output accepted before
the termination cutoff; RUNE does not discard those accepted logs to impose an artificial sink
deadline. Fresh descendant output cannot extend the fixed child-close cutoff.

CLI and shell stderr writers await their write callbacks. The GUI transport acknowledges
each event after synchronous renderer handling, with at most one event in flight. A lost
renderer releases the transport waiter and follows the existing renderer-loss lifecycle.
Custom runners must await each onOutput return before sending more output or settling.

### 9.2 Electron IPC bridge (main ↔ renderer)

The IPC bridge is how the GUI shell's renderer drives the engine. The engine runs **inside the shell's Electron main process** (`gui-shell/src/main` imports `@rune/engine` and owns one `Session`); the renderer is a pure renderer in a sandboxed `BrowserWindow` (`contextIsolation: true`, `nodeIntegration: false`, `sandbox: true`) and sees the engine only through a preload script that exposes `window.rune` via `contextBridge.exposeInMainWorld`. The bridge's engine-facing API is a **1:1 projection of the `Session` facade and event stream**: every engine-facing method maps to the corresponding facade operation and every run event to one push message. The sole additional method is the shell-lifecycle-only `rune.done` signal described below; it adds no engine behavior. Adding engine behavior reachable only through the bridge would break mode parity by construction and is forbidden (invariant 11). The bridge uses Electron IPC rather than a public wire protocol; it has no stdio
channel, sidecar process, or engine binary.

#### Bridge transport

Electron IPC — request/response via `ipcRenderer.invoke` ↔ `ipcMain.handle` (one channel per facade method), run events pushed main → renderer via `webContents.send` and subscribed through `rune.onEvent(listener)` in the preload. Preload and renderer are built and shipped together in the same artifact, so the bridge is an internal contract pinned by a unit test (§14), not a versioned wire format.

#### Opening a session

The renderer calls `rune.open()`; main opens the `Session` from the **invocation it was launched with** (manifest path, `--values`, `--set`, `--locale`, `--result`, `--log-file` — the CLI's layers 2–4 and flags, resolved by the engine exactly as for the CLI). The renderer never supplies a manifest path or any layer-1–4 value; `rune.open()` resolves to `{ runeVersion, inputTypes, product }` — the input-type names the manifest uses, checked against the renderer's field-renderer registry (§9.3), plus the exact product machine identity. `open.product` remains byte-exact even when it collides with a secret and is not a human display projection.

#### Bridge methods

`rune.open`, `rune.pendingInputs`, `rune.allInputs`, `rune.warnings`, `rune.setValue`, `rune.plan`, `rune.describe`, `rune.execute`, `rune.cancel`, `rune.getStrings`, `rune.getThemeConfig` — every one returns a Promise and maps to the corresponding facade operation.

`rune.getStrings` wraps the current facade table as `{ locale, entries, displayProduct: { name, version, welcome } }`, where `locale` is the engine-selected tag or `null` for built-in English defaults: main composes the human product name and version and, when no description exists, the complete name/version fallback with that exact authenticated table; an explicit product description, including an empty one, remains the authoritative accessor-projected welcome text. The renderer replaces this whole presentation snapshot after every accepted answer, after every successful plan, and before Back returns from Summary.

After an actual rejected `rune.setValue` call for a current input, main decorates that input's next `allInputs` projection with human-only `editRejection: { candidate?, displayText }`: the candidate is retained only for public string edits on `text`, `file`, or `directory`, while every input type retains the safe error presentation. Main recomputes this metadata with the current authenticated string table on every read. `displayText` is the current remasked safe engine error, so a length, type, or pattern rejection retains its authoritative cause instead of being classified again by the shell; for a genuine pattern mismatch, that engine diagnostic already incorporates the localized `patternHint`, including its explicit-empty semantics and human-sink control escaping. Main terminal-projects any retained candidate separately. It keeps an authentic seed `rejection` separate and removes the edit rejection after a successful correction or when the input becomes disabled. This closure-local presentation state neither mutates engine input state nor validates a value.

`rune.plan` projects the frozen `ExecutionPlan`; `rune.describe` projects the dry-run result. `rune.execute` is long-running: run events are pushed while it is in flight and its promise resolves with the `RunResult`; `rune.cancel` remains callable during execution.

`rune.warnings` preserves each original warning message and adds its complete `displayText`. The shell-lifecycle-only `rune.done` signal lets the Result page release the window after result delivery; it adds no engine behavior.

#### Events and plain-data projection

`runStarted`, `stepStarted`, `stepOutput`, `stepFinished`, `runFinished` — the run events only; the live enable/disable signal for §5's disabled inputs (`InputStateChanged`) is the resolved value of `rune.setValue`, not a pushed event.

`allInputs()` and `pendingInputs()` already return their plain sink-safe snapshots from the facade. A successful `rune.plan` publishes the plan-masked input snapshot before its response resolves, so subsequent input reads use every secret spelling that plan derived; a renderer-held pre-plan response remains the immutable historical phase snapshot described in §9.1, and the renderer replaces it by reading the current inputs.

Other payloads remain **bridge projections**: main runs the complete plan, result, and event values through the bridge serializer first (JSON-safe plain data; `SecretString` → `***`, `mask()` applied), preserving every machine field, and may then add complete human-only presentation metadata composed as §9.1 defines. `webContents.send` / the invoke return therefore gives Electron's structured clone only plain masked data, never an engine object (structured clone ignores `toJSON()`, so a raw `SecretString` must never reach it). The same facade methods, IPC channels, and run-event kinds remain in force; each engine event produces exactly one pushed bridge message, and presentation metadata adds no RPC. Ordering and bracketing rules of §9.1 hold across the bridge.

#### Secret values across the bridge

Values of `secret` inputs cross the bridge towards the renderer only masked — `secret: true` with `value: null` in `allInputs` and in the `RunResult` (the same representation the result file uses, §10), `"***"` in human-readable plan previews and events — never as plaintext. The one direction in which a secret crosses in clear is `rune.setValue` as the user types it; it is wrapped at the engine boundary like any other layer-5 answer, and main never logs incoming bridge calls.

#### Bridge errors

Every invoke returns a JSON-safe tagged success or failure reply. Preload unwraps successful values and rejects failures with a plain `BridgeError` object tagged `kind: "rune-error"`, carrying the `RUNE-xxx` `code`, masked `message`, masked source `location` (or `null`), and the `exitCode` the CLI would have used. Main also supplies the complete masked `displayText`, including the code, exit code, and located diagnostics; the renderer assigns it verbatim without parsing Electron error messages or composing metadata. Machine codes stay exact.

Native `Error` objects never cross either IPC or `contextBridge`: Electron does not preserve their custom properties. Stacks, causes, and arbitrary properties stay in main. Unknown thrown values, transport failures, and malformed replies become a fixed value-free RUNE-500 / exit 70 diagnostic.

**Recoverable errors:** rejections of `rune.setValue` and `rune.plan` — the renderer shows the authoritative engine diagnostic inline (including `patternHint` when the engine reports a pattern mismatch), keeps Next disabled while inputs are incomplete or invalid (§9.3), and lets the session continue.

**Fatal errors:** errors from `rune.open`, `rune.execute`, and failures outside any bridge call (e.g. window close during a run). Main maps those through `exitCodeFor` and exits with that code (§9.4).

### 9.3 Per-frontend behavior

- **Non-interactive driver** (`cli`): no prompts ever; missing required *enabled* inputs → exit 4 listing every missing input with its accepted sources; disabled inputs are not required and a value supplied for one is warned about and ignored (§5); `pattern` mismatches and malformed `--set` JSON arrays are input errors (exit 4) before any step runs; plan → execute → result file. This is the parity anchor.
- **Interactive CLI**: Node `readline` prompts (stdlib — no prompt library) with a muted-echo helper for `secret` inputs, for `pendingInputs()` only — enabled, still-missing inputs in declaration order; select/multiselect prompts display option **labels** and accept option **values**; a `pattern` mismatch re-prompts showing `patternHint`; disabled inputs are skipped. Then the summary: the plan rendered with the same renderer dry-run uses, followed by the **edit loop** `Proceed / Change value <n> / Cancel` — any enabled input, seeded or answered, can be changed (an ordinary layer-5 `setValue`); a change that enables further missing inputs prompts for them before re-rendering the summary. `Proceed` awaits `execute()` on the same event loop; first `Ctrl+C` → CancelToken; second force-exits. Chrome strings come from `getStrings()` (§6.3); if masking projects the localized proceed and cancel tokens to the same text, the summary uses `p` and `c` for its menu, action matching, and invalid-choice diagnostic.
- **GUI** (Electron shell, §9.4): pages generated from the engine's view of the manifest — Welcome, auto-chunked input pages, Summary (renders the bridge projection of the same `ExecutionPlan`, secrets masked — §9.2), Progress, Result. The renderer renders `rune.allInputs()` with fields pre-filled from layers 1–4; disabled inputs are **greyed out** (visible, not editable) and flip live on the `InputStateChanged` list resolved by `rune.setValue`; select/multiselect fields display labels and submit values; an invalid field is marked red with the authoritative engine diagnostic and Next stays disabled until valid — for a pattern mismatch that diagnostic incorporates `patternHint`, with no abort and no renderer-side regex. Engine validation via `setValue` is the only authority; widgets are UX sugar. For runtime chrome, command previews, result summaries, warning lines, and decorated failed-step headings, the pure renderer assigns the complete presentation fields received from main verbatim. It never substitutes runtime values into catalogue templates, joins command argv for display, or decorates a runtime title itself. Cancel → `rune.cancel` → `Session.cancel()` → CancelToken.

Every frontend asserts at session open that it can render every input type the manifest uses (the renderer from the `inputTypes` resolved by `rune.open()`), and fails fast with a named error — no silent fallback.

### 9.4 GUI shell (Electron)

#### Runtime and responsibilities

Electron bundles Chromium and a Node runtime, so the GUI uses a bundled renderer and
does not require an end-user Node installation. The engine, CLI, and shell are written
in TypeScript, and the shell hosts the engine in-process without a sidecar or engine
binary. The existing shell archives provide this runtime; bundling an author's workflow
and resources into a portable end-user artifact uses `rune package` (§9.5). Workflow
commands may still depend on tools or permissions specified by the author.

The application in `packages/gui-shell/` has three responsibilities:

- **Main** (`src/main/`) imports `@rune/engine`, owns the `Session`, registers IPC handlers,
  creates the window, and maps the engine outcome to an exit code. Session I/O is awaited;
  parsing, validation, and other synchronous CPU work still run on the main event loop (§9.1).
- **Preload** (`src/preload/`) exposes the IPC bridge through `contextBridge` (§9.2).
- **Renderer** (`src/renderer/`) renders bridge data using HTML/CSS. It contains no
  execution, planning, interpolation, condition, or validation logic; never reads the
  manifest, locale overlays, or values files; and never imports the engine.

The shell also implements `--non-interactive`: main runs the engine without a window.
The workflow artifact reuses that path (§9.5).

#### GUI launch and terminal outcome

The CLI locates the shell in the per-user cache, launches it with the invocation
(manifest path, `--set`, `--values`, `--result path`, `--log-file`, `--locale`), and waits.
A missing shell produces exit 2 with the `rune gui install` hint. Main opens the Session
from that invocation and drives the wizard; log and result semantics are shared with
the CLI. `--result -` is rejected before launch (exit 2, §4.1), because GUI mode has no
stdout machine-output contract.

**Exit forwarding.** The CLI forwards a normally terminated shell's code only when it
belongs to §10's exit-code table. A signal death or any other code, including a native
Chromium crash code, maps to 70. An engine `RuneError` is shown as a named error, uses
its mapped exit code, and follows the ordinary result-file rules.

**Cancellation.** The first `Ctrl+C` or SIGTERM received by the CLI forwards a cancel
request: POSIX sends SIGTERM to the shell PID, which main handles as `Session.cancel()`;
Windows uses `taskkill /PID <shell>` without `/F` to request window close (§7).
The CLI waits and forwards the resulting code: 6 for cancellation, with the earlier-failure
precedence in §7. A second `Ctrl+C` force-exits the CLI while the shell finishes cancelling.

**Renderer loss.** Replacing the main-frame receiver through reload or cross-document
navigation counts as renderer loss; the initial load, same-document navigation, and
subframe navigation do not. Before main claims result delivery, renderer loss requests cooperative
cancellation of a live run, produces exit 70, and writes no result. Main synchronously
claims one memoized delivery attempt; from that point, the attempt owns the terminal
outcome. Later renderer loss only marks the renderer gone and requests guarded window
close. Main waits for the same delivery and exits with its result or delivery-failure
code (§10).

**Main-process crash.** A hard crash is abnormal shell termination and maps to exit 70.
A crash before the atomic result-file commit leaves no result; a crash after that commit
leaves the file untouched, even though the shell termination still maps to 70.

#### Theming

The distributed executable carries the RUNE icon and product identity. The window
uses the bundled RUNE icon by default; `gui.logo` still overrides the window and
header artwork. Runtime theming does not modify the executable's file icon or
publisher metadata. Shell archives are unsigned; branding is not a code-signing
or operating-system trust guarantee.

1. **RUNE default theme** — page transitions, progress and result states, and light/dark variants; built on CSS custom properties (`--rune-accent`, `--rune-radius`, `--rune-font`, …). This is what every installer looks like when the author does nothing.
2. **Manifest `gui:` block** (schema v1, §4.2) — `gui.accentColor`, `gui.logo` (window/taskbar icon and header logo), `gui.banner`, `gui.theme` (path to a CSS file), optional `gui.windowTitle`. The engine returns each `getThemeConfig` call as a fresh frozen snapshot: the localized `windowTitle` is sink-masked against current secrets, while `accentColor` and the absolutized asset/CSS paths remain exact. The renderer applies it as variable overrides; presentation-only, ignored by CLI and non-interactive — no parity impact.
3. **Author CSS** — the `gui.theme` file is loaded **after** the default theme and may override variables or any rule. RUNE guarantees the custom-property names, not the internal DOM; authors maintain CSS that depends on that DOM.

#### Shell distribution and version coupling

Authors and CI use Node 24 LTS and build the source checkout; `node packages/cli/dist/main.js` is its CLI entry point. The workspace name `@rune/cli` is not a public installation instruction: that npm name currently belongs to a different project. Public npm delivery requires an owner-controlled namespace decision and corresponding package/import updates before publication. The local CLI package contains no Electron; core/CLI development uses `npm ci --ignore-scripts` to skip the separate shell binary download. `rune gui install` downloads the prebuilt shell for the current OS from the project's GitHub Releases into the per-user cache — no admin rights, no system install. `rune run --gui` launches the cached shell or exits 2 with that hint; for shell development only, the `RUNE_GUI_SHELL` environment variable overrides the lookup with a packaged binary or a shell package directory (launched through that package's own electron). The download requires published archive assets for the current engine version. Source checkouts without matching assets use the development override or build their own shell. Shell updates are explicit re-runs of `rune gui install` (auto-update is deferred, §16).

**Version matching.** The shell bundles its own copy of `@rune/engine`; `@rune/cli` ships another. **`rune gui install` fetches the shell release whose engine version equals the installed CLI's**; the per-user cache is keyed by that version; `rune run --gui` refuses a cached shell whose engine version differs from its own (exit 2, hint: re-run `rune gui install`). The result file's `runeVersion` under `--gui` is the shell engine's version — by construction equal to the CLI's.

#### Linux cancellation readiness

Workflow launches use a private duplex pipe on fd 3.
The CLI supplies `RUNE_GUI_STARTUP_TOKEN` as 32 lowercase hexadecimal characters; the
shell removes that environment variable immediately and installs its outer SIGTERM latch
before sending `READY <token>\n`. Before parsing the invocation or opening a Session,
the shell waits for exactly `START <token>\n` or `CANCEL <token>\n`; CANCEL latches the
request before the normal lifecycle begins. Each frame is ASCII, at most 128 bytes. Both
sides allow 10 seconds for their expected frame and clean up the descriptor, listeners,
and timer on every gate outcome. EOF, malformed input, error, or the shell-side deadline
ends the shell with exit 70 and no Session, renderer, or result. Standalone shell launches
without the token retain their existing behavior; Windows keeps its native close request.

The CLI buffers cancellation until READY. Immediately before attempting its one control
write, it irreversibly transfers result ownership to the shell. A write failure after that
point cannot trigger a competing CLI result. After START, a later cancel is forwarded as
SIGTERM; CANCEL already carries the first request and needs no duplicate signal. Before
the transfer, the CLI owns startup failure/cancellation; a missing READY terminates the
startup process tree, and cancellation requested before the deadline retains exit 6.
The second Ctrl+C before transfer closes the pipe so the shell cannot start an orphaned
workflow. No handshake bytes use stdout or stderr, and the token never enters step environments.

#### Cache publication and recovery

Extracted shells are immutable generations beneath the
engine-version cache directory. Before publishing a `generation-v1-<uuid>` directory,
installation flushes every extracted file and writes an exclusively created, flushed
`.rune-complete.json` seal. It records the engine version and a SHA-256 digest covering
the complete directory tree: entry names and types, file sizes and contents, and POSIX
executable permission bits. Symlinks and special files are refused. POSIX directories
are also flushed before publication and after each rename; Windows file flushing uses
writable handles. A complete sealed generation becomes visible before an atomic replacement
of the small `current` pointer. Once visible, it is retained even if pointer publication
fails: a concurrent reader may already have recovered it.

Readers verify the selected generation's seal and complete tree, then pin that directory
for both probe and launch. A valid current selection wins. If the pointer is absent,
unreadable, malformed, or selects damaged files, readers scan only `generation-v1-<uuid>`
directories in descending basename order and use the first fully verified generation of
the same engine version. Staging directories, temporary pointers, incomplete seals and
damaged trees are never recovery candidates. Recovery is read-only, so it cannot overwrite
a concurrent installer's newer selection. Concurrent successful installers may choose the
last published complete generation.

For compatibility, a valid pointer to an older `generation-<uuid>` still selects that
directory; these older unsealed generations are not recovery candidates. An original
direct-binary cache remains readable only when `current` is absent and no verified
generation is available. Neither compatibility path creates an integrity guarantee for
old caches. A damaged selection without a usable recovery generation produces an actionable
cache error, never a path outside that version's cache directory.

An interrupted publication, including power loss, can therefore recover from a surviving
complete generation even if the pointer or newest files did not persist. No recovery is
possible if storage loses or corrupts every complete copy; RUNE reports the reinstall hint
instead of launching a damaged sealed installation. Flushes cannot override storage that
does not honor them. Published generations are retained so located or running shells cannot
lose their files; clearing an unused engine-version cache is an explicit user operation.

#### Native quit requests

For a configured invocation, the shell intercepts Electron's
`before-quit` event, prevents immediate shutdown, and routes it through the same
cancellation latch as SIGTERM. On Linux, Electron's native SIGTERM handler initiates
application quit rather than reliably emitting a Node process signal. The listener
remains active through startup, execution, and result/log delivery. The engine outcome
and delivery rules retain ownership of the exit code; final `app.exit` bypasses this
quit event. Version probes have no configured run and remain outside this lifecycle.
Electron restores the native SIGTERM action after the first signal; a second SIGTERM
can force termination without result delivery, like other hard process termination.

#### Shell probe deadline

The shell version probe must finish within 10 seconds. On expiry,
the CLI terminates the probe process tree (POSIX: SIGKILL to its dedicated group;
Windows: `taskkill /T /F`) and waits at most another 5 seconds for its streams to close.
It then releases its handles and reports a usage error (exit 2), without starting a
workflow shell. Cancellation requested before the deadline remains cancellation
(exit 6); a later cancellation does not replace a claimed timeout. Development overrides require a prepared Electron binary; the CLI never evaluates
Electron's automatic-download entry point. Probe output is
limited to 4096 characters and is never included in the diagnostic. The CLI retains
pre-launch error/result ownership; the probe never opens a Session or writes a result.
The probe flushes its JSON response before exiting. On Windows, it waits for Electron
readiness after that flush so shutdown uses the initialized message loop; it creates
no window and remains subject to the CLI's probe deadline. Linux retains the early
exit path without waiting for display initialization.

#### Archive format and launchers

Shell artifacts are `.tar.gz` on Linux and `.zip` on Windows; `rune gui install` fetches with Node's built-in `fetch` and unpacks by spawning the OS `tar` as argv (`tar -xf`; bsdtar ships with Windows 10+/11 and handles both formats) — no archive library, in line with §12's runtime dependency list.

The Linux archive exposes `rune-gui-shell` as a POSIX launcher and keeps the Electron
executable beside it as `rune-gui-shell-bin`. The launcher preserves argv, cwd, inherited
descriptors, and PID through `exec`. For a real `--non-interactive` option or the exact
standalone `--rune-version-probe` invocation, it adds the native `--ozone-platform=headless`
switch before starting Electron; option values and
the literal manifest operand are never interpreted as mode switches. Electron chooses
its display backend before application JavaScript can change it. The shell consumes
that exact leading runtime switch only for a non-interactive invocation or the standalone
version probe. No display
server or Node executable is needed by this packaged entry, and Chromium sandboxing
remains enabled. The graphical invocation and Windows executable keep their normal
runtime startup.

Ordinary application environment variables pass through the launcher without scan-variable
collisions. As with other `/bin/sh` entry scripts, the operating system shell can initialize
its reserved variables such as `IFS`, `OPTIND`, `PWD`, and `PPID`; workflows must not use those
names as a portable application-input channel.

#### Runtime instrumentation

The shell accepts Electron's explicit
`--remote-debugging-port=<port>` before the literal `--` manifest marker, with a decimal
port from 0 to 65535. Electron owns that switch; it is removed before parsing the RUNE
invocation. This allows inspection of the unchanged distributed application. Without
the switch the shell does not enable remote debugging. The generic shell requires
the marker; a bound workflow (§9.5) also accepts the switch without a marker.
A switch after the marker is subject to normal RUNE argument validation.

### 9.5 End-user artifact (`rune package`)

`rune package MANIFEST --output ARCHIVE` combines an extracted, version-matching GUI
shell with a workflow. The first targets are host x64 Windows (`.zip`) and Linux
(`.tar.gz`), using the OS archive tool. The shell is built with electron-builder;
packaging reuses its runtime rather than rebuilding Electron. Authors may supply
`--shell DIRECTORY` for a downloaded and extracted shell, or use the installed GUI
cache. A development shell directory is not a distributable runtime.

The package contains the unchanged shell and a `resources/workflow/` directory.
It preserves the manifest filename and relative resource paths. By default, only
the manifest and adjacent `scripts/`, `payload/`, `assets/`, and `locales/` directories
are copied. Additional files or directories require repeated `--include PATH`
arguments relative to the manifest directory. GUI assets must be included. Absolute
paths, parent traversal, symbolic links, and special files are refused in packaged
resources. Packaging never copies the whole repository implicitly or overwrites an
existing output archive. Inputs and values files are not collected automatically.

`resources/rune-workflow.json` is a strict object with `schemaVersion: 1` and a
relative `manifest` path beneath `resources/workflow/`. A packaged shell resolves
this default from its own resources directory, independent of cwd. Without an
explicit manifest argument, starting the executable opens that workflow. Explicit
manifest arguments and standalone version probes retain the generic shell behavior.
The probe advertises `workflowPackageVersion: 1`; the packager refuses shells without
this capability, of another engine version, or already bound to a workflow.

The artifact launches the same wizard as `rune run --gui`, including local author
CSS, logos, and locale overlays, without installing RUNE or Node. It also accepts
`--non-interactive` and the existing input, log, locale, and result flags; the engine
still runs in Electron main with the shared exit-code and result contract. Authored
commands retain their own runtime and permission prerequisites. Packaging does not
install external commands, elevate privileges, create a single-file executable,
or change the native executable icon and signature of the supplied shell.

The portability basis is `${manifestDir}` anchoring (§6.1, invariant 13). Authors
keep runtime resources beneath that directory and use relative paths; packaging
does not rewrite script contents or guess dependencies of arbitrary commands.

## 10) Automation contract

### Exit codes

Fixed, identical on Windows and Linux — no `128+signal` arithmetic, so one pipeline script branches the same way everywhere. Each error class maps to exactly one code — the map is owned by `errors.ts` (`exitCodeFor`) alone; `cli/main.ts` is the only `process.exit` call site in the CLI (the GUI shell's main process uses the same `exitCodeFor` and `rune run --gui` forwards its code, §9.4); every code is reachable by a test.

| Code | Meaning |
|---|---|
| 0 | Success (all steps succeeded or skipped — including `nothingExecuted: true`; also successful `validate` / `--dry-run` / `schema`) |
| 1 | One or more steps failed or timed out (regardless of `failFast`); or result-file delivery failed with RUNE-407 — no result file exists, the exit code and the stderr diagnostic are the only signals |
| 2 | Usage or unsupported-host error (unknown flag, malformed `--set`, an empty `--log-file` or `--values` value, a real run whose non-stdout result and effective log file are the same path, a `schema --output` destination that cannot be written (§4.1), host platform other than Node's `win32` or `linux`, `--gui` without the GUI shell installed or with a cached shell of a different engine version (§9.4), `--gui` with `--non-interactive`/`--dry-run`/`--result -`); `commander` runs with `exitOverride()` so RUNE, not the parser, emits CLI errors |
| 3 | Manifest invalid (RUNE-1xx, incl. locale-overlay errors); `validate` failure |
| 4 | Input error (missing required input, coercion/pattern failure, malformed JSON array, unknown key in `--set`/values) |
| 5 | Resolution/condition error (RUNE-3xx) |
| 6 | Cancelled |
| 70 | Internal error (always a RUNE bug; also renderer loss before the GUI shell's main process claims result delivery, or a hard crash of that main process — a crash before the atomic result-file commit leaves no file, while an already committed file stays untouched, §9.4; requested stdout output lost to a stream error other than an early-closing consumer (stream discipline below), which overrides the run's own code and leaves the delivered result file untouched; and any shell exit that is not a code from this table) |

Codes 7–19 reserved for future features.

### Non-interactive input handling

Under `--non-interactive` — explicit or TTY-degraded (stdin not a TTY when a prompt would be needed): layers 1–4 resolve; any required **enabled** input still missing → exit 4, stderr lists **each** missing input with its accepted sources (`--set id=... | RUNE_INPUT_<ID> | values-file key 'id'`); a result file with `status: "input_error"` is still written if `--result` was given; **no step executes** — resolution is all-or-nothing. Optional and disabled inputs resolve to their type's empty value (§4.2, §5).

### Stream discipline

stdout is reserved exclusively for requested machine output (`--result -`, the dry-run plan, the `rune validate` report including its audit section, `rune schema`). All progress, prompts, diagnostics, and warnings (secrets interpolated into `args`, ignored disabled-input values, `nothingExecuted`) go to stderr. `rune run ... --result - | jq .` works with zero contamination. With `--dry-run --result -` stdout carries only the result JSON and the human plan is not rendered; `--result <path>` keeps the plan on stdout. A consumer that closes stdout or stderr early (`| head -1`, a viewer quit mid-stream) ends RUNE's output on that stream but never changes the exit code: the CLI owns the stream's `error` event, writes nothing further to the closed pipe, and prints no stack trace. Only that early-closing consumer (EPIPE, ECONNRESET) is silent: any other write error on stdout (a full disk, an I/O error) has lost requested machine output, so the CLI prints one fixed line on stderr — never the stream error itself — and exits 70; stderr diagnostics are best-effort, and a write error there never changes the exit code.

Windows archives expose `rune-gui-shell.exe`, a native process launcher around the
adjacent `rune-gui-shell-bin.exe` Electron runtime. Electron writes one CRLF before
loading application code; the launcher removes exactly that initial pair and forwards
all remaining bytes with backpressure. The public executable therefore has exact empty
or serialized stdout, checked on the extracted archive. Direct development Electron
invocations and the inner runtime retain the upstream prefix and are not the packaged
entrypoint. See the [upstream startup code](https://github.com/electron/electron/blob/v44.2.0/shell/app/electron_main_delegate.cc#L174-L177).
The invisible launcher forwards Windows close requests and engine exit status. Forced
launcher termination closes its process job; normal completion preserves deliberately
detached workflow services. No workflow behavior runs in the native launcher.
After Electron exits, the launcher drains its queued stdout/stderr bytes and closes
those transports even if a detached service retains an unused inherited handle. This
does not change the engine's separate descendant-pipe EOF policy in §8.

Each CLI-rendered human line visibly escapes C0, DEL/C1, U+2028, and U+2029 after masking and composition; formatter-owned aggregate line feeds remain physical, while JSON and JSON Schema output remain unchanged. Lines rendered from a session use its authenticated `StringTable` and `formatSessionTerminalLine`: raw mask → control escape → final live mask. The second mask prevents an actual control from becoming a registered literal such as `\u001b` only after presentation. Authoring commands with no runtime secret registry (`validate`, `schema`) and pre-session fallback text use ordinary control escaping; requested JSON output bypasses human rendering entirely.

### Result file (`--result`)

#### Delivery and ownership

The result schema is versioned independently of the manifest (`resultSchemaVersion: 2`;
`rune schema --result` emits its JSON Schema). A configured result file is written on
success, step failure, manifest error, input error, resolution/condition error,
cancellation, and internal error.

**No-result outcomes:** usage or unsupported-host errors (exit 2), failed result delivery
(RUNE-407, exit 1), renderer loss before windowed main claims delivery (exit 70), and a
host-process crash before the atomic commit. A crash after commit leaves the file intact;
abnormal GUI shell termination still maps to 70 (§9.4).

**One delivery attempt.** Windowed main synchronously claims one memoized attempt before
invoking it. The claim is irreversible. Close waits through both the pending write and
the promise-settlement-to-outcome-recording interval. Later renderer loss cannot start
a competing failure path or replace the classification. Fulfilment retains the result
and its matching exit code; rejection overrides it with RUNE-407 / exit 1 and no result
file. An already committed file is never rolled back, deleted, or retried.

**Filesystem and serialization.** The public async `writeResult` creates a uniquely
named sibling tmp file exclusively and commits it with `fs.rename`. A failed write
removes only its own tmp file best-effort and is never retried. The public
`serializeResult` returns exactly the text `writeResult` writes: a schema-validated copy
in the schema's member order, indented with two spaces and terminated by a newline.
`--result -` prints the same text. Both sinks reject data that does not match version 2.

**Delivery errors.** Failure to prepare the directory or open, write, close, or finalize
the file is an operational `ExecutionError` (RUNE-407, exit 1), never an `InternalError`.
Its diagnostic names the destination and a fixed errno-derived reason, never the raw
OS message; the underlying cause remains internal. There is no retry, so the exit code
and stderr diagnostic are the only failure signals.

**Path presentation.** A host that anchors or normalizes the destination passes the
operator's original spelling as `announcement`: filesystem delivery uses the anchored
path, while diagnostics use the supplied spelling. With a completed plan, the CLI
terminal-projects both the error and success announcement through the Session masker.
Before a completed plan, only the pre-Session config-error case may name the path because
no secret can exist there. An opened Session instead uses a fixed path-free delivery
failure and suppresses the success announcement, even with a resolution-era `StringTable`.
The failed-planning presentation rules below apply.

Hosts call `writeResult` after the engine produces a result. Delivery completes before
any terminal human summary is rendered.

#### Failure construction and provenance

Result construction remains engine-owned. `Session.describe()` and `Session.execute()` produce normal results; the public `createFailureResult` factory builds failures around `Session.open()`, planning, or pre-execution setup while preserving every safely available manifest, session, input, locale, platform, and plan fact.

With session or plan context, detailed error fields are accepted only from the exact engine-produced error bound to the current session generation. An authentic failed-plan error privately retains the masking snapshot of that exact planning attempt for its own public error and failure result without publishing a plan or Session snapshot. The current Session generation is also marked privately as having an incomplete planning phase: later no-plan failure results in that generation suppress non-secret string and string-array input values unless the exact error carries a complete attempt masker; rejected edits retain the mark, while a successful edit replaces the generation and clears it. If a derived secret transformation could not be registered completely, the exact planning failure result suppresses those values too.

An external, cross-session, or stale error becomes one fixed generic internal-error projection; without an authenticated completed plan or matching planning attempt, its no-plan result likewise suppresses non-secret string and string-array input values. Every suppression preserves booleans, ids, provenance, enabled/ignored state, and the exact machine fields.

The host-created dry-run cancellation uses one fixed canonical RUNE-601 projection. Plan-time RUNE-401/404/405 failures have no completed plan and therefore keep the zero-step form.

A pre-execution log-file failure (RUNE-406) may project an already completed plan as unchanged `SKIPPED` steps plus `NOT_RUN` executable steps. If log writing or closing fails after execution, `Session` instead preserves the completed run's real step states, output tails, and counters and reclassifies only the run-level outcome. Consequently, this documented run-level `failed` form need not contain a `FAILED` step. Hosts capture the engine-produced terminal result and never duplicate these semantics.

#### Human presentation after failed planning

The CLI composes additional human fallback lines after a failed run pipeline only when a completed plan supplies its full authenticated masker, or for the existing pre-Session config-error case whose result has no product identity. When a Session opened but planning did not complete, the CLI retains the engine-projected diagnostic and the safe JSON/file result but suppresses locale outcome lines, warnings, and the result-file success announcement. A result-file delivery failure in that state uses the fixed path-free fallback even though the resolution-era `StringTable` exists. The GUI applies the same boundary to shell-owned fatal presentation: without proof of a completed plan it uses fixed RUNE branding and value-free fallback text; with that proof it retains localized captions and detailed plan-masked diagnostics. This rule prevents a locale string or supplied result path from reproducing a derived spelling known only to the failed planning attempt; completed-plan failures retain their localized outcomes and warnings.

#### Status and exit-code correlation

Run `status` maps to the exit code per the table below: every status implies exactly one exit code, and every exit code from a normally terminating configured run implies exactly one status once `dryRun` is known — except the two overrides §10's table names, a failed result-file delivery (RUNE-407, exit 1, no result file) and requested stdout output lost to a stream error (exit 70, whose result file keeps the status of the run that produced it) — exit 0 is `succeeded` for a real run and `planned` for `--dry-run`; every other configured-run code is unambiguous on its own. Consumers may branch on either, using `dryRun` to disambiguate exit 0.

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

#### Result fields

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

#### Log sinks and operational errors

Two sinks consume the shared event stream: stderr console (plain-text progress, diagnostics, and warnings) and the log file (`--log-file` / `execution.logFile`; DEBUG-level, timestamped, step output prefixed `[stepId:stdout]`). A relative `logFile` resolves against `${manifestDir}`. A Windows drive-relative spelling (`C:run.log`) is rejected at validate time (RUNE-104), like a drive-relative command (§8): it cannot be anchored to `${manifestDir}` deterministically, and anchoring it as a literal component would address an NTFS alternate data stream. The field is deliberately non-interpolable in v1; when both are given, `--log-file` overrides `execution.logFile`. A dry-run plan preview names that path as the operator spelled it (`--log-file`, else `execution.logFile`) rather than in its anchored form, so no path anchoring or normalization can rewrite the bytes a secret registry holds.

Failure to prepare its directory or to open, write, or close the configured log file is an operational `ExecutionError` (RUNE-406, exit 1), never an `InternalError`: its message names that same spelling and a fixed reason derived from the errno code — never the raw OS message — and it retains the underlying cause internally.

Under the GUI shell the engine runs in the shell's main process: the console sink writes to the shell process's stderr, which `rune run --gui` passes through to the caller's terminal, and the warnings that are part of the automation contract (secrets interpolated into `args`, ignored disabled-input values, `nothingExecuted`) are additionally surfaced on the shell's Result page — warning state and provenance remain engine-owned and identical across modes, while human delivery follows the masking rules in §10, including the CLI's no-completed-plan exception; the log file is written by the engine as in every other mode.

Structured JSONL event logs are not implemented. A future event format needs its own versioned contract.

#### Path spellings

**Supplied spelling at masked sinks.** A path in a maskable line or field uses the
supplier's spelling: the manifest argument, `--log-file`, `--result`, `--values`, or
`execution.logFile`. A discovered file, such as a locale overlay, uses its discovered
spelling. Hosts keep anchored, resolved, normalized, or escaped variants internal and
pass the supplied spelling separately to presentation. This applies to `writeResult`
and log-sink `announcement`, preview manifest/log paths, and located diagnostics' `file`.
Masking matches registered bytes; deriving another spelling before masking can defeat it.

**Limits and exceptions:**

- **Different declarations.** If an operator registers an anchored path as a secret
  but spells the flag differently, the supplied flag spelling can remain visible.
  RUNE does not equate arbitrary spellings of one filesystem path.
- **Relative log paths.** RUNE-406 diagnostics and previews show `execution.logFile`
  exactly as declared. Resolve that spelling against the manifest directory, including
  when reading the diagnostic from another working directory. Values-file diagnostics
  follow the same supplied-spelling rule.
- **Manifest identity.** The structured `manifest.path` remains resolved and exact in
  plans and results. It may name the same file differently from a located diagnostic.
  A declared secret equal to the supplied manifest spelling is masked in human lines
  but is not masked in this machine field.
- **Executable paths.** A step's `command` and `cwd` retain the resolved spelling the
  runner will use. The planner checks both the manifest spelling before anchoring and
  the anchored spelling afterwards. A declared secret equal to either renders as `***`
  in previews and results while the runner receives the authentic bytes.
- **Authoring commands.** `validate` and `schema` resolve their arguments before reading
  them, and located diagnostics use that resolved spelling. They open no Session and
  register no runtime secrets, so their output has no runtime secret masking.

#### Value spellings

Diagnostics pass supplied values whole and raw to the masker, before splitting,
trimming, escaping, or quoting can change the registered bytes. A multiselect membership
failure therefore names the supplied text once and lists the declared option values,
rather than reporting parsed comma-separated fragments. A native array may be named
entry by entry because its caller supplied those entries separately. Quote or escape
values only at presentation, after masking.

#### Secret wrappers and sink projection

Secret handling has two layers:

1. **Opaque `SecretString` wrapper end-to-end** (in-process safety): values of `secret` inputs are wrapped at resolution; the public wrapper exposes only masking/stringification behavior, and the plan, `toString()`, `toJSON()`, and `util.inspect` render `***`. Plaintext resolvers remain module-private; an internal reveal capability is used only inside the runner at spawn.
2. **`SecretRegistry` + `mask()`** (sink safety): every supplied secret value is registered at resolution time, and planning registers its RUNE-derived path spellings — all before any step can launch. `mask(text)` performs registration-order-independent substring replacement from a cached immutable matcher snapshot at every sink boundary: the logging filter, child stdout/stderr ingestion (a script that echoes a password still produces masked logs — and the output-tail ring buffer is fed from the already-masked stream), the result writer, the dry-run renderer, and the IPC-bridge serializer in the shell's main process. Overlapping matches are merged while immediately adjacent matches stay separate. Bounded remasking handles matches created by `***` replacement; if those passes do not converge, the whole input is masked. Resolution-era input snapshots necessarily precede discovery of derived spellings; the first successful plan atomically replaces the current facade snapshot with one projected through its complete registry. Already returned pre-plan snapshots remain immutable historical values and can retain a public spelling that only the later plan identified as secret-derived; no current post-plan snapshot or execution sink reuses that weaker projection.

   Each maskable dynamic string published in a structured facade, plan, event, or result field is
   projected independently: the engine masks its raw value, then checks the content of that one
   JSON string after JSON escaping against the same registry and fails closed to `***` if escaping
   creates a match. This covers non-secret input values and rejected candidates; resolved display
   strings and `windowTitle`; plan input values, titles, skip reasons, and public command values;
   `StepStarted.title` and real or synthetic `StepOutput.line`; and the corresponding result input,
   step, command, and output-tail fields. An execution value hidden for this reason remains an
   authentic `SecretString`, so argv, cwd, and environment values reach the runner byte-exact.
   Projection is field-level, never a scan of complete JSON: input/step ids, option values,
   environment keys, the platform/mode/status/source/state/code/stream enums, the selected
   locale, product identity, validated manifest/asset/theme/log paths, hashes, run ids,
   timestamps, versions, fixed keys, syntax, and `null` remain exact by contract. The selected
   locale is RUNE's canonicalization of the tag an operator supplied through `--locale` or
   `RUNE_LOCALE` (`DE_de` → `de-DE`), kept exact because §6.3 makes it the machine identity of the
   locale that resolved every string. A declared secret whose value is a valid locale tag therefore reaches
   the `locale` field of a plan and a result unmasked — a spelling RUNE derived, when the supplied
   one needed folding — while the invalid tag that the same value would be in any other run is
   masked in its diagnostic. Invariant 6 names that field among its clear-text crossings. Error
   and location strings use the diagnostic projection contract rather than this structured-field
   helper.

#### Registry bounds

A registry snapshot is limited to **262,144 UTF-16 code units** (`2^18`) across its unique maskable parts, counting the complete value, the maskable content lines of a multiline secret, and the whitespace-trimmed spelling of every part that carries surrounding whitespace; registering the same part again consumes no additional budget. This is the smallest power-of-two limit above the 10,000-secret scale exercised by the masking suite (about 170,000 code units), while bounding the immutable matcher's trie to at most 262,145 nodes instead of allowing a values file to demand millions. Registration preflights every part before mutating the snapshot, and the transient active-plus-staged union used to redact resolution errors is subject to the same limit before it is copied or a matcher is built. Exceeding either limit fails closed as a generic RUNE-202 input error before execution; it publishes no partial registry and reports neither secret text nor candidate length.

#### Masking limitations

**Declared values and short parts.** The registry includes each maskable CR/LF/CRLF-separated
content line of a secret. Parts with surrounding spaces or tabs are registered both
raw and trimmed, so a child that trims such a value is also masked. A secret with no
non-empty content, or any content line shorter than 4 characters after trimming, cannot
be masked completely reliably. `run` warns during resolution; `validate` never sees
values. If a RUNE-generated secret path transformation cannot be registered completely,
planning instead fails closed with a generic RUNE-202 before any step launches.

**Exact machine fields.** Substring masking covers a secret embedded in a longer path
only at fields that pass through a masker. The machine fields listed above remain exact.
In particular, resolved `manifest.path` can expose a secret that equals, normalizes to,
or is contained in the manifest path, such as a tenant id or checkout directory name.
Human lines mask that value, but the result file and identical `--result -` output can
contain it in this field.

**Other transformations and environment reads.** Transformations that RUNE does not
register, such as base64, can defeat substring masking. `${env.NAME}` values are not
registered either: only declared `secret` inputs are. Model sensitive values as `secret`
inputs, supplied through `RUNE_INPUT_*` in CI, rather than `${env.*}` references.

## 11) Package layout

The repository uses npm workspaces without another monorepo layer:

- `packages/engine`: manifest loading, inputs, localization, planning, execution,
  runner, logs, results, errors, and the public Session API.
- `packages/cli`: argument parsing, prompts, terminal rendering, process-stream
  ownership, and GUI installation/launch.
- `packages/gui-shell`: Electron main process, isolated preload bridge, renderer,
  and theme resources.
- `packages/*/test`: unit and package integration tests under Vitest.
- `packages/gui-shell/tests`: real Electron tests under Playwright.
- `tests`: cross-package contracts and tests of the documented example.
- `examples`: runnable author workflows.
- `scripts`: repository build and distribution checks.

The root TypeScript configuration enables strict checking, unchecked-index checks,
and exact optional properties. Dependency-cruiser checks the boundaries in §3.
Generated build output is excluded from source control and package contents are
checked after packing.

## 12) Dependency policy

Engine and CLI runtime dependencies are `yaml`, `zod`, and `commander`. Prompts,
process execution, downloads, and filesystem operations use Node APIs. Runtime
dependencies need an explicit purpose; they must preserve argv-only execution,
strict validation, and the engine/frontend boundary.

The supported development and execution target is Node 24 LTS. Electron is a shell
development dependency and must remain on an upstream-supported release line
embedding the same Node major (currently Electron 44). Review Node, Electron, and
tool support before each release; an unsupported Chromium shell is a release issue.
The real shell smoke suite checks the embedded Node major.

Core installation uses `npm ci --ignore-scripts` and never prepares an Electron
binary. Shell development and CI additionally run
`npm run prepare:electron --workspace @rune/gui-shell` before launching Electron.
Electron is absent from the installed engine/CLI dependency tree.

Development tools are TypeScript, ESLint with typescript-eslint, Prettier, Vitest,
dependency-cruiser, and Playwright. Upgrade them within their supported compatibility
ranges and run the complete gates. Packaging tools belong to build-time dependencies,
not the engine runtime.

## 13) Extension points

Input handlers are registered by type. They own coercion, empty/missing-value rules,
validation, and comparison. Frontends have presentation registries for the same
types and reject types they cannot render. Duplicate registrations are errors.

The runner interface is an engine-internal implementation/test seam. A public runner
extension would first need a trusted-runner and secret-materialization contract.
No plugin discovery or external runner injection is currently supported.

Themes use documented CSS custom properties and optional author CSS. Localization
uses manifest-adjacent overlay files and the engine's chrome-key catalogue.
Third-party frontends may use the public Session API; no out-of-process RPC server
is implemented.

Future elevation, retries, dependencies, and step outputs require explicit schema
changes. Step outputs would also require revisiting the static-plan contract.
Relative-resource anchoring and the shared engine preserve the execution semantics
of packaged workflows (§9.5).

## 14) Testing strategy

Core CI runs on Windows and Linux with the supported Node LTS target. Its gates are
typecheck, lint, formatting, dependency boundaries, Vitest, and installed-package
verification. The separate shell lane prepares Electron and runs Playwright on both
platforms. [releasing.md](releasing.md) defines the artifact acceptance checks.

Required coverage:

- Manifest and schema tests pin located errors, unknown/reserved keys, static
  reference/condition checks, localization keys, and schema/runtime agreement.
- Input, interpolation, and planner tests cover precedence, conditional enabling,
  one-pass resolution, immutable projections, preview refusal, and masking.
- Runner tests use real processes for quoting, output splitting, timeouts,
  cancellation, and platform-specific process-tree termination.
- Result and sink tests cover every documented status/exit combination, counters,
  output tails, atomic delivery failures, and stream errors.
- The mode-parity suite compares plans, events, and results from non-interactive,
  scripted interactive, and in-process Session clients. Only documented timestamps,
  run ids, frontend mode, and source provenance may differ.
- Bridge tests cover every projected method/event, structured errors, plain data,
  masking, and the shell-only completion signal. Real Electron tests exercise the
  context bridge as well as rendering, editing, themes, cancellation, result delivery,
  crashes, and the CLI launcher.
- Package checks install the packed engine and CLI together in an isolated consumer,
  then verify versions, schemas, actual execution, results, logs, and absence of Electron.
- Static lint rules forbid code evaluation and implicit-shell APIs in every supported
  module form. Import-boundary checks resolve workspace names to source and reject
  engine/frontend dependency inversions.

A test of a source checkout is not a substitute for testing the shipped package or
GUI archive. Release evidence must identify the exact candidate and platforms tested.

## 15) Invariants

1. All frontends share one Planner and Executor (§3, §7, §9).
2. Process execution is argv-only; implicit shells and code evaluation are forbidden (§8).
3. Resolution and interpolation follow the single-pass timing in §5–6.
4. Dry-run presents the plan used for execution; a foreign-platform preview cannot run.
5. Conditions are statically typed; input conditions reference only earlier inputs.
6. Secret projections follow §10, including its exhaustive machine-field exceptions,
   historical snapshot semantics, and supplied/derived spelling limitations.
7. Input validation is engine-owned; every effective value has provenance (§5).
8. No-TTY execution never prompts; missing enabled inputs fail before steps run.
9. Exit codes, result delivery ownership, and abnormal-termination exceptions follow §10.
10. stdout contains only requested machine output; human diagnostics use stderr.
11. The GUI renderer uses only the preload bridge and contains no engine behavior.
12. Unknown manifest, overlay, and supplied-input keys fail loudly.
13. Relative workflow resources anchor to the manifest directory, never the caller's cwd.
14. Step transitions are monotonic, exactly one terminal state, at most one running step.
15. Run events are serial and awaited, bracketed exactly once by RunStarted and
    RunFinished; no event follows settlement of execute (§9.1).
16. Disabled inputs have identical value, requirement, warning, and provenance semantics
    across modes; only their presentation differs (§5, §10).
17. Locale selection and text resolution are engine-owned; machine identities are not localized.

## 16) Open design decisions

- Additional portable formats and architectures beyond the host x64 archives (§9.5).
- Public package namespace and release ownership.
- GUI shell auto-update policy: whether `rune run --gui` ever checks for newer shells or updates remain explicit `rune gui install` re-runs (§9.4).

These require explicit decisions and corresponding tests. Their presence in an old
roadmap or prior deferral does not establish that they are acceptable for a release.
