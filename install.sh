#!/usr/bin/env bash
# Раскладка конфигов pi-harness на машину.
# Копирует файлы с бэкапом существующих, затем ставит расширения из npm.
set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
AGENT_DIR="${PI_AGENT_DIR:-$HOME/.pi/agent}"
EXT_CONFIG="$HOME/.pi/settings.json"
STAMP="$(date +%Y%m%d-%H%M%S)"

backup() {
  if [ -e "$1" ]; then
    cp -p "$1" "$1.bak-$STAMP"
    echo "  backup: $1 -> $1.bak-$STAMP"
  fi
}

put() { # put <src> <dst>
  mkdir -p "$(dirname "$2")"
  backup "$2"
  cp -p "$1" "$2"
  echo "  -> $2"
}

echo "pi-harness: раскладываю конфиги"

put "$REPO_DIR/agent/settings.json"  "$AGENT_DIR/settings.json"
put "$REPO_DIR/agent/models.json"    "$AGENT_DIR/models.json"
put "$REPO_DIR/agent/AGENTS.md"      "$AGENT_DIR/AGENTS.md"
put "$REPO_DIR/agent/subagents.json" "$AGENT_DIR/subagents.json"

mkdir -p "$AGENT_DIR/agents" "$AGENT_DIR/themes"
for f in "$REPO_DIR"/agent/agents/*.md; do put "$f" "$AGENT_DIR/agents/$(basename "$f")"; done
for f in "$REPO_DIR"/agent/themes/*.json; do put "$f" "$AGENT_DIR/themes/$(basename "$f")"; done

# Конфиг расширений семейства claude-code-ui живёт по другому пути (читают $HOME/.pi/settings.json).
put "$REPO_DIR/ext/settings.json" "$EXT_CONFIG"

echo
echo "Расширения (ставятся из npm, в репе только конфиги):"
grep -o 'npm:[^"]*' "$AGENT_DIR/settings.json" | sed 's/^npm://' | while read -r pkg; do
  echo "  pi install npm:$pkg"
  pi install "npm:$pkg" || echo "  ! не удалось поставить $pkg"
done

echo

# Патчи к установленным пакетам (upstream-баги, см. docs/light-theme.md).
# Идемпотентны: уже пропатченное повторно не трогают.
echo "Патчи к пакетам (patches/):"
for f in "$REPO_DIR"/patches/*.mjs; do
  [ -e "$f" ] || continue
  echo "  $(basename "$f")"
  node "$f" || echo "  ! патч не применился: $(basename "$f")"
done

echo
echo "Готово. Ключ DeepSeek не в репе: положи его в ~/.config/deepseek.env как DEEPSEEK_API_KEY=..."
echo "Затем перезапусти pi (или /reload)."
