# @rune/cli

The `rune` command line currently supports `rune validate`, `rune schema`, and
`rune run --non-interactive` (including `--dry-run`) — see
[docs/architecture.md](../../docs/architecture.md) §4.1. Until the interactive prompter
lands, every current `rune run` invocation uses the non-interactive path regardless of TTY
state or whether `--non-interactive` is supplied. Interactive prompting is planned for a
later milestone, as are `rune gui install` and `rune run --gui`. Install with
`npm install -g @rune/cli`
(Node 22 LTS).

See [docs/roadmap.md](../../docs/roadmap.md) for the milestone plan.
