# Default theme

The RUNE default theme (docs/architecture.md §9.4, theming layer 1): CSS custom
properties (`--rune-accent`, `--rune-radius`, `--rune-font`, …), light and dark
variants, page transitions and progress animations.

The implementation lives in `default.css`; author CSS and manifest overrides load after it.
