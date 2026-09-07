#!/bin/sh
# Electron chooses its display backend before application JavaScript starts.
# Inspect only option positions; preserve the original invocation for the shell parser.
# Confine assignments so inherited exported variables reach the native process unchanged.
if (
  if [ "$#" -eq 1 ] && [ "$1" = --rune-version-probe ]; then
    exit 0
  fi
  headless=
  skip_operand=
  for argument do
    if [ "$skip_operand" = yes ]; then
      skip_operand=
      continue
    fi
    case "$argument" in
      --|--set|--values|--locale|--result|--log-file) skip_operand=yes ;;
      --non-interactive) headless=yes ;;
    esac
  done
  [ "$headless" = yes ]
); then
  set -- --ozone-platform=headless "$@"
fi

case "$0" in
  */*) exec "${0%/*}/rune-gui-shell-bin" "$@" ;;
  *) exec ./rune-gui-shell-bin "$@" ;;
esac
