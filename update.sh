#!/usr/bin/env bash
# Update from upstream, then restore local overlays without overwriting configs.
set -euo pipefail
REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
AGENT_DIR="${PI_CODING_AGENT_DIR:-${PI_AGENT_DIR:-$HOME/.pi/agent}}"
export PI_CODING_AGENT_DIR="$AGENT_DIR"
unset DEEPSEEK_API_KEY
# Guard existing code before upstream update, without replacing its runtime.
if [ -f "$AGENT_DIR/npm/node_modules/pi-live-throughput/package.json" ]; then
  node "$REPO_DIR/patches/fix-pi-live-throughput-codex.mjs" --deploy --preflight
fi
# Preserve the old runtime until the guarded TPS overlay transaction below.

# Retire obsolete provider configs before reconciling packages; retain machine UI/auth.
python3 "$REPO_DIR/assets/codex-only.py" --agent-dir "$AGENT_DIR" --home "$HOME" --purge-retired-secrets

# Defaults to package updates only. Pass --all to update Pi itself too.
if [ "$#" -eq 0 ]; then set -- --extensions; fi
pi update "$@"

mkdir -p "$AGENT_DIR/patches"
for f in "$REPO_DIR"/patches/*.mjs "$REPO_DIR"/patches/*.patch; do
  [ -e "$f" ] || continue
  [ "$(basename "$f")" != fix-pi-live-throughput-codex.mjs ] || continue
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
# Preserve the separate existing statusline overlay payload (not TPS-owned).
mkdir -p "$AGENT_DIR/patches/pi-live-throughput"
source="$REPO_DIR/patches/pi-live-throughput/statusline-ui.ts"
dst="$AGENT_DIR/patches/pi-live-throughput/statusline-ui.ts"
if [ -L "$dst" ] || [ ! -e "$dst" ] || ! cmp -s "$source" "$dst"; then
  tmp="$(mktemp "$AGENT_DIR/patches/pi-live-throughput/.source.XXXXXXXX")"
  cp -p "$source" "$tmp"
  mv -f "$tmp" "$dst"
fi
failed=0
for f in "$REPO_DIR"/patches/*.mjs; do
  [ -e "$f" ] || continue
  [ "$(basename "$f")" != fix-pi-live-throughput-codex.mjs ] || continue
  node "$AGENT_DIR/patches/$(basename "$f")" || failed=1
done
if [ "$failed" -ne 0 ]; then
  echo 'Upstream updated, but an overlay needs review. Incompatible overlays were not forced.' >&2
  exit 1
fi
bash "$REPO_DIR/assets/deploy-tps-speedometer.sh"
PI_CODING_AGENT_DIR="$AGENT_DIR" node "$REPO_DIR/tests/compact-tools.mjs"
PI_CODING_AGENT_DIR="$AGENT_DIR" node "$REPO_DIR/tests/subagents-live-tools.mjs"
PI_CODING_AGENT_DIR="$AGENT_DIR" node "$REPO_DIR/tests/orca-math.mjs"
SL_DIR="$HOME/.local/share/claude-codex-statusline"
mkdir -p "$SL_DIR"
cp "$REPO_DIR/assets/statusline.py" "$SL_DIR/statusline.py"
chmod 700 "$SL_DIR/statusline.py"
python3 "$REPO_DIR/tests/codex-only.py"
python3 "$REPO_DIR/tests/portable-config.py"
python3 "$REPO_DIR/tests/statusline-session-name.py"
node "$REPO_DIR/tests/session-manager-hide-subagents.mjs"
node "$REPO_DIR/tests/codex-throughput.mjs"
node "$REPO_DIR/tests/codex-throughput-extension.mjs"
echo 'Packages updated and overlays verified. Restart pi to enable Orca Kitty images (not just /reload).'
