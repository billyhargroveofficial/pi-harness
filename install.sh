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

# Скрипт статус-строки (его же использует Claude Code, см. assets/statusline.README.md)
SL_DIR="$HOME/.local/share/claude-codex-statusline"
if [ -f "$REPO_DIR/assets/statusline.py" ]; then
  mkdir -p "$SL_DIR"
  backup "$SL_DIR/statusline.py"
  cp -p "$REPO_DIR/assets/statusline.py" "$SL_DIR/statusline.py"
  chmod 700 "$SL_DIR/statusline.py"
  cp -p "$REPO_DIR/assets/statusline.README.md" "$SL_DIR/README.md"
  echo "  -> $SL_DIR/statusline.py"
fi

echo
echo "Расширения (ставятся из npm, в репе только конфиги):"
grep -o 'npm:[^"]*' "$AGENT_DIR/settings.json" | sed 's/^npm://' | while read -r pkg; do
  echo "  pi install npm:$pkg"
  pi install "npm:$pkg" || echo "  ! не удалось поставить $pkg"
done

# pi-claude-code-ui стоит установленным, но с погашенным расширением (его место занял
# better-claude-code-ui, см. docs/extensions.md). `pi install` возвращает ему дефолтные
# extensions и расширение снова начинает грузиться — включая свою статус-строку,
# которая дерётся с pi-statusline за футер. Поэтому фильтр возвращаем после установки.
python3 - "$AGENT_DIR/settings.json" <<'PY'
import json, sys
path = sys.argv[1]
data = json.load(open(path))
FILTERED = {"npm:pi-claude-code-ui", "npm:pi-claude-code-ui@latest"}
changed = False
for i, entry in enumerate(data.get("packages", [])):
    source = entry.get("source") if isinstance(entry, dict) else entry
    if isinstance(source, str) and source in FILTERED and (not isinstance(entry, dict) or entry.get("extensions") != []):
        data["packages"][i] = {"source": source, "extensions": []}
        changed = True
if changed:
    json.dump(data, open(path, "w"), indent=2, ensure_ascii=False)
    open(path, "a").write("\n")
    print("  pi-claude-code-ui: расширение снова погашено (extensions: [])")
else:
    print("  pi-claude-code-ui: фильтр на месте")
PY

echo

# Патчи к установленным пакетам (upstream-баги, см. docs/light-theme.md).
# Идемпотентны: уже пропатченное повторно не трогают.
# Сами файлы тоже кладём в ~/.pi/agent/patches, иначе после `pi update`
# (он сносит правки в node_modules) их негде взять на этой машине.
echo "Патчи к пакетам (patches/):"
mkdir -p "$AGENT_DIR/patches"
for f in "$REPO_DIR"/patches/*.mjs; do
  [ -e "$f" ] || continue
  dst="$AGENT_DIR/patches/$(basename "$f")"
  if [ ! -e "$dst" ] || ! cmp -s "$f" "$dst"; then
    cp -p "$f" "$dst"
    echo "  + $dst"
  fi
done
for f in "$REPO_DIR"/patches/*.mjs; do
  [ -e "$f" ] || continue
  echo "  $(basename "$f")"
  node "$f" || echo "  ! патч не применился: $(basename "$f")"
done

echo
echo "Готово. Ключ DeepSeek не в репе: положи его в ~/.config/deepseek.env как DEEPSEEK_API_KEY=..."
echo "Затем перезапусти pi (или /reload)."
