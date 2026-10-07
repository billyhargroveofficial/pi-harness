#!/usr/bin/env bash
# Feature-only deployment: preserve machine theme, custom Codex defaults, OAuth,
# MCP and skills. No npm/Pi version updates and no inference requests.
set -euo pipefail
REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
AGENT_DIR="${PI_CODING_AGENT_DIR:-${PI_AGENT_DIR:-$HOME/.pi/agent}}"
export PI_CODING_AGENT_DIR="$AGENT_DIR"
unset DEEPSEEK_API_KEY
SL_DIR="$HOME/.local/share/claude-codex-statusline"

# Refuse unknown machine-local edits to the shared CC/Pi renderer.
python3 - "$REPO_DIR/assets/statusline.py" "$SL_DIR/statusline.py" <<'PY'
import hashlib, pathlib, sys
source, target = map(pathlib.Path, sys.argv[1:])
known = {'1faba08776e30f1de68e36d2765f0fd4563fc40a411bfe7a44f5e7b09933a2ab',
         hashlib.sha256(source.read_bytes()).hexdigest()}
if target.exists() and hashlib.sha256(target.read_bytes()).hexdigest() not in known:
    raise SystemExit('STOP: shared statusline.py has unreviewed local edits; nothing changed')
PY
python3 "$REPO_DIR/assets/codex-only.py" --agent-dir "$AGENT_DIR" --home "$HOME" --purge-retired-secrets

put_atomic() {
  mkdir -p "$(dirname "$2")"
  local tmp
  tmp="$(mktemp "$(dirname "$2")/.codex-status.XXXXXXXX")"
  cp -p "$1" "$tmp"
  mv -f "$tmp" "$2"
}
for name in fix-pi-live-throughput-codex.mjs fix-pi-statusline-throughput.mjs; do
  put_atomic "$REPO_DIR/patches/$name" "$AGENT_DIR/patches/$name"
done
for source in "$REPO_DIR"/patches/pi-live-throughput/*.ts; do
  put_atomic "$source" "$AGENT_DIR/patches/pi-live-throughput/$(basename "$source")"
done
node "$AGENT_DIR/patches/fix-pi-live-throughput-codex.mjs"
node "$AGENT_DIR/patches/fix-pi-statusline-throughput.mjs"
mkdir -p "$SL_DIR"
if [ -f "$SL_DIR/statusline.py" ] && ! cmp -s "$REPO_DIR/assets/statusline.py" "$SL_DIR/statusline.py"; then
  cp -p "$SL_DIR/statusline.py" "$SL_DIR/statusline.py.bak-$(date +%Y%m%d-%H%M%S)"
fi
put_atomic "$REPO_DIR/assets/statusline.py" "$SL_DIR/statusline.py"
chmod 700 "$SL_DIR/statusline.py"
put_atomic "$REPO_DIR/assets/statusline.README.md" "$SL_DIR/README.md"

python3 "$REPO_DIR/tests/codex-only.py"
python3 "$REPO_DIR/tests/portable-config.py"
python3 "$REPO_DIR/tests/statusline-session-name.py"
node "$REPO_DIR/tests/codex-throughput.mjs"
THROUGHPUT_SOURCE="$AGENT_DIR/npm/node_modules/pi-live-throughput/src/index.ts" \
STATUSLINE_UI_SOURCE="$AGENT_DIR/npm/node_modules/pi-statusline/src/ui.ts" \
node "$REPO_DIR/tests/codex-throughput-extension.mjs"
python3 - "$REPO_DIR" "$AGENT_DIR" "$SL_DIR" <<'PY'
import pathlib, sys
repo, agent, status = map(pathlib.Path, sys.argv[1:])
for src, dst in [(repo/'patches/pi-live-throughput/index.ts', agent/'npm/node_modules/pi-live-throughput/src/index.ts'),
                 (repo/'patches/pi-live-throughput/codex-throughput.ts', agent/'npm/node_modules/pi-live-throughput/src/codex-throughput.ts'),
                 (repo/'patches/pi-live-throughput/statusline-ui.ts', agent/'npm/node_modules/pi-statusline/src/ui.ts'),
                 (repo/'assets/statusline.py', status/'statusline.py')]:
    assert src.read_bytes() == dst.read_bytes(), f'Deployed source mismatch: {dst}'
print('PASS: deployed sources match canonical repo')
PY
echo 'Codex-only configuration and compact status deployed. Restart Pi and old terminal/Orca processes to discard inherited retired API-key environments.'
