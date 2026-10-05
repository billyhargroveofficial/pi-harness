#!/usr/bin/env bash
# Update from upstream, then restore local overlays without overwriting configs.
set -euo pipefail
REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
AGENT_DIR="${PI_CODING_AGENT_DIR:-${PI_AGENT_DIR:-$HOME/.pi/agent}}"
export PI_CODING_AGENT_DIR="$AGENT_DIR"

# Defaults to package updates only. Pass --all to update Pi itself too.
if [ "$#" -eq 0 ]; then set -- --extensions; fi
pi update "$@"

mkdir -p "$AGENT_DIR/patches"
for f in "$REPO_DIR"/patches/*.mjs "$REPO_DIR"/patches/*.patch; do
  [ -e "$f" ] || continue
  dst="$AGENT_DIR/patches/$(basename "$f")"
  # Older installs may have symlinks back to this repo. `cp source symlink`
  # fails when both paths resolve to the same file. Replace links with real
  # copies; skip already-identical regular files.
  if [ -L "$dst" ] || [ ! -e "$dst" ] || ! cmp -s "$f" "$dst"; then
    tmp="$(mktemp "$AGENT_DIR/patches/.patch.XXXXXXXX")"
    cp -p "$f" "$tmp"
    mv -f "$tmp" "$dst"
  fi
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
PI_CODING_AGENT_DIR="$AGENT_DIR" node "$REPO_DIR/tests/compact-tools.mjs"
PI_CODING_AGENT_DIR="$AGENT_DIR" node "$REPO_DIR/tests/subagents-live-tools.mjs"
PI_CODING_AGENT_DIR="$AGENT_DIR" node "$REPO_DIR/tests/orca-math.mjs"
python3 "$REPO_DIR/tests/statusline-session-name.py"
echo 'Packages updated and overlays verified. Restart pi to enable Orca Kitty images (not just /reload).'
