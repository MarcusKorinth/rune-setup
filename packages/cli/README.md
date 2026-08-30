# @rune/cli

The `rune` command line currently supports `rune validate`, `rune schema`, and
`rune run --non-interactive` (including `--dry-run`) — see
[docs/architecture.md](../../docs/architecture.md) §4.1. Until the interactive prompter
lands, `rune run` without `--non-interactive` follows the same non-interactive path when
run from a TTY. Interactive prompting and the `rune gui install` / `rune run --gui`
commands are planned for later milestones. Install with `npm install -g @rune/cli`
(Node 22 LTS).

See [docs/roadmap.md](../../docs/roadmap.md) for the milestone plan.
