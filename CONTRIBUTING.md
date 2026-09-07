# Contributing to RUNE

Thanks for contributing.

## Start here

1. read [README.md](README.md) for usage and scope
2. read [the architecture](docs/architecture.md) for semantics and invariants
3. keep changes minimal, explicit, and reviewable

By participating in this project you agree to abide by the
[Code of Conduct](CODE_OF_CONDUCT.md).

## Developer Certificate of Origin

All code contributions must be made with Developer Certificate of
Origin (DCO) sign-off. Add a `Signed-off-by` trailer to every commit:

```text
Signed-off-by: Your Name <your.email@example.com>
```

The usual Git command is:

```bash
git commit -s
```

By signing off, you assert that you have the right to submit the
contribution under the project license. Pull requests with unsigned
commits are not accepted.

## Project-specific expectations

- the GUI wizard, interactive CLI, and non-interactive runs share identical engine semantics
- keep execution, interpolation, and condition logic in the engine
- preserve the [secret projection contract](docs/architecture.md#logging-and-secret-masking),
  including its explicit machine-field exceptions; never bypass a masking sink
- commands are executed as argv arrays, never through an implicit shell
- add or update tests when behavior changes
- update documentation when behavior, APIs, guarantees, or invariants change

## Development workflow

### Branching strategy

- `main` should remain integration-ready and green
- no direct commits to `main`
- keep each pull request focused on one concern
- avoid mixing refactors and behavior changes unless the coupling is real and
  unavoidable

### Branch naming

Use the following pattern:

```text
<type>/<short-description>
```

Examples:

```text
feat/directory-input-validation
fix/exit-code-mapping
refactor/step-planner
docs/readme-operating-modes
test/non-interactive-run
chore/repo-bootstrap
```

### Working process

1. create a branch from `main`
2. implement the change and its relevant tests and documentation
3. run the [required checks](#testing)
4. create signed commits following the policy below
5. open a pull request

## Commit message policy

This project uses Conventional Commits.

### Format

```text
<type>(<scope>): <summary>

[optional body]

[optional footer]
```

### Header rules

- use imperative mood, for example `add`, not `added`
- do not end the header with a period
- maximum 72 characters
- keep it concise and descriptive
- scope is recommended but optional

Examples:

```text
feat(engine): add step timeout handling
fix(runner): prevent secret values in process logs
refactor(config): split schema loading and validation
docs(readme): clarify operating modes
```

### Allowed types

```text
feat      new functionality
fix       bug fix
refactor  internal restructuring without behavior change
docs      documentation changes
test      tests
build     build system or dependencies
ci        CI/CD changes
perf      performance improvements
chore     maintenance tasks
revert    revert previous commit
```

### Commit body guidelines

The commit body should explain context, not repeat the diff.

It should answer:

- why was this change necessary?
- what was changed conceptually?

Recommended structure:

```text
Why:
- describe the problem or motivation

What:
- describe the key changes
- mention important design decisions
```

### When a body is required

A commit body is required for:

- `feat`
- `fix`
- `refactor`
- any change affecting behavior, API, lifecycle, or semantics

A commit body is optional for:

- `docs`
- small `test` changes
- trivial `chore` or `ci` updates

### Readability

Keep body paragraphs readable in GitHub and terminal tools. Wrap long lines
where it improves clarity rather than to satisfy a fixed column count.

### Footer

Use footers for metadata when relevant:

```text
BREAKING CHANGE: description
Refs: #123
Closes: #123
```

## Pull requests

### PR title

PR titles should follow Conventional Commits:

```text
<type>(<scope>): <summary>
```

### PR expectations

Prefer small to medium-sized pull requests. Before opening one, complete the
[working process](#working-process) and explain:

- what was changed
- why it was changed
- any important side effects or constraints

### Labels

Issues and pull requests use scoped labels to describe different review
questions:

- use exactly one `type:*` label for the intended change kind, matching the
  Conventional Commit type when possible
- use zero or more `area:*` labels for the affected subsystem or project
  surface
- use `severity:*` labels for defects, findings, security work, or other
  risk-bearing changes where priority matters

`type:*` and `area:*` labels may intentionally overlap. For example, a CI
workflow change can use both `type:ci` (the change kind) and `area:ci` (the
affected project area).

## Testing

- add tests for new behavior
- add regression tests for bug fixes
- test observable behavior rather than incidental implementation details
- ensure the relevant test slice passes before opening a pull request
- unit tests live in `packages/<pkg>/test/` (vitest), cross-package suites in `tests/`;
  `packages/gui-shell/tests/` is reserved for the Playwright smoke suite

Install once with `npm ci --ignore-scripts`, then run the core checks:

```bash
npm run typecheck
npm run lint
npm run format:check
npm run depcruise
npm run test:coverage
npm run test:packages
```

`npm test` runs the same test suite without coverage instrumentation for local
iteration. `npm run format` fixes formatting. CI runs the core checks on Windows
and Linux and separately prepares Electron, runs the real shell tests, and verifies
the built GUI archive. Follow [the shell verification commands](docs/releasing.md#build-and-verification)
for GUI or packaging changes. Security workflows also check source and dependency
findings; review their results alongside the core and shell jobs.

## Versioning

This project follows Semantic Versioning:

- `fix` -> patch
- `feat` -> minor
- breaking changes -> major
