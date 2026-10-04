#!/usr/bin/env bash
# Update from upstream, then restore local overlays without overwriting configs.
set -euo pipefail
REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
AGENT_DIR="${PI_CODING_AGENT_DIR:-${PI_AGENT_DIR:-$HOME/.pi/agent}}"

# Defaults to package updates only. Pass --all to update Pi itself too.
if [ "$#" -eq 0 ]; then set -- --extensions; fi
pi update "$@"

mkdir -p "$AGENT_DIR/patches"
for f in "$REPO_DIR"/patches/*.mjs "$REPO_DIR"/patches/*.patch; do
  [ -e "$f" ] || continue
  cp -p "$f" "$AGENT_DIR/patches/$(basename "$f")"
done
failed=0
for f in "$REPO_DIR"/patches/*.mjs; do
  [ -e "$f" ] || continue
  node "$AGENT_DIR/patches/$(basename "$f")" || failed=1
done
if [ "$failed" -ne 0 ]; then
  echo 'Upstream updated, but an overlay needs review. Incompatible overlays were not forced.' >&2
  exit 1
fi
PI_CODING_AGENT_DIR="$AGENT_DIR" node "$REPO_DIR/tests/subagents-live-tools.mjs"
echo 'Packages updated and overlays verified. /reload or restart pi.'
