#!/usr/bin/env bash
# Display-only HYBRID TPS deployment. No sanitizer, settings, auth, theme,
# statusline.py, other overlays, inference, service restart or npm Pi updates.
set -euo pipefail
REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
AGENT_DIR="${PI_CODING_AGENT_DIR:-${PI_AGENT_DIR:-$HOME/.pi/agent}}"
export PI_CODING_AGENT_DIR="$AGENT_DIR"
if [ "$#" -ne 0 ]; then echo 'usage: deploy-tps-speedometer.sh (agentDir via env)' >&2; exit 2; fi
PATCH="$REPO_DIR/patches/fix-pi-live-throughput-codex.mjs"
# Includes canonical patch copies and optional helper paths: fail before npm.
node "$PATCH" --deploy --preflight
mkdir -p "$AGENT_DIR"
STAGE_PARENT="$(mktemp -d "$AGENT_DIR/.tps-deploy.XXXXXXXX")"
trap 'rm -rf "$STAGE_PARENT"' EXIT
bash "$REPO_DIR/assets/install-tps-runtime.sh" --stage "$STAGE_PARENT/runtime"
# One transaction: runtime + installed sources + canonical patch copies.
# Every core/oracle/extension/native-session/transport acceptance and loader
# check runs inside verification: any failure rolls back the whole set.
node "$PATCH" --deploy --runtime-stage="$STAGE_PARENT/runtime" --verify
echo 'TPS display deployed and installed sources verified. AVG measures the current native measurement epoch; LIVE uses reference BPE. No processes restarted.'
