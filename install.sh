#!/usr/bin/env bash
# Раскладка конфигов pi-harness на машину.
# Копирует файлы с бэкапом существующих, затем ставит расширения из npm.
set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
AGENT_DIR="${PI_CODING_AGENT_DIR:-${PI_AGENT_DIR:-$HOME/.pi/agent}}"
export PI_CODING_AGENT_DIR="$AGENT_DIR"
# Drop a retired key inherited from an older terminal for this deployment tree.
unset DEEPSEEK_API_KEY
# Read-only guards run before upstream work; runtime + TPS replacement happens
# together at the overlay transaction below, never before unrelated setup.
if [ -f "$AGENT_DIR/npm/node_modules/pi-live-throughput/package.json" ]; then
  node "$REPO_DIR/patches/fix-pi-live-throughput-codex.mjs" --deploy --preflight
fi
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

# Templates contain Billy's Mac paths; adapt them to this account's HOME.
# Codex credential sources stay machine-local (never copy auth.json or API keys).
put_json() {
  mkdir -p "$(dirname "$2")"
  backup "$2"
  python3 "$REPO_DIR/assets/prepare-config.py" "$1" "$2" --home "$HOME" "${@:3}"
  echo "  -> $2 (portable paths)"
}
put_json "$REPO_DIR/agent/settings.json" "$AGENT_DIR/settings.json"
put_json "$REPO_DIR/agent/models.json"   "$AGENT_DIR/models.json" --preserve-provider-auth
put "$REPO_DIR/agent/AGENTS.md"      "$AGENT_DIR/AGENTS.md"
put "$REPO_DIR/agent/subagents.json" "$AGENT_DIR/subagents.json"

mkdir -p "$AGENT_DIR/agents" "$AGENT_DIR/themes"
for f in "$REPO_DIR"/agent/agents/*.md; do put "$f" "$AGENT_DIR/agents/$(basename "$f")"; done
for f in "$REPO_DIR"/agent/themes/*.json; do put "$f" "$AGENT_DIR/themes/$(basename "$f")"; done

# Локальные display-only расширения: обновления npm их не перезаписывают.
mkdir -p "$AGENT_DIR/extensions"
for f in "$REPO_DIR"/agent/extensions/*.ts; do
  [ -e "$f" ] || continue
  put "$f" "$AGENT_DIR/extensions/$(basename "$f")"
done
# Package-local config files (code itself remains installed from npm).
for f in "$REPO_DIR"/agent/extensions/*/config.json; do
  [ -f "$f" ] || continue
  name="$(basename "$(dirname "$f")")"
  put_json "$f" "$AGENT_DIR/extensions/$name/config.json"
done

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
echo "Расширения из npm (локальные расширения уже скопированы):"
while read -r pkg; do
  echo "  pi install npm:$pkg"
  pi install "npm:$pkg"
done < <(grep -o 'npm:[^"]*' "$AGENT_DIR/settings.json" | sed 's/^npm://')

# `pi install` may reuse an old installed package. Raise versions below our
# tested baseline, but never downgrade newer upstream installations.
upgrades=()
while IFS= read -r pkg; do
  [ -n "$pkg" ] && upgrades+=("$pkg")
done < <(python3 - "$REPO_DIR/assets/tested-package-versions.json" "$AGENT_DIR/npm/node_modules" <<'PY'
import json, pathlib, re, sys
baseline = json.loads(pathlib.Path(sys.argv[1]).read_text())
root = pathlib.Path(sys.argv[2])
def version(v):
    match = re.fullmatch(r"(\d+)\.(\d+)\.(\d+)(?:[-+].*)?", v)
    if not match:
        raise ValueError(f"Unsupported package version: {v}")
    return tuple(map(int, match.groups()))
for name, required in baseline.items():
    file = root / name / "package.json"
    installed = json.loads(file.read_text())["version"] if file.exists() else "0.0.0"
    if version(installed) < version(required):
        print(f"{name}@{required}")
PY
)
if [ "${#upgrades[@]}" -gt 0 ]; then
  echo "Поднимаю старые пакеты до проверенных версий: ${upgrades[*]}"
  npm install --prefix "$AGENT_DIR/npm" --ignore-scripts --no-audit --no-fund "${upgrades[@]}"
fi

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
for f in "$REPO_DIR"/patches/*.mjs "$REPO_DIR"/patches/*.patch; do
  [ -e "$f" ] || continue
  [ "$(basename "$f")" != fix-pi-live-throughput-codex.mjs ] || continue
  dst="$AGENT_DIR/patches/$(basename "$f")"
  if [ ! -e "$dst" ] || ! cmp -s "$f" "$dst"; then
    cp -p "$f" "$dst"
    echo "  + $dst"
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
for f in "$REPO_DIR"/patches/*.mjs; do
  [ -e "$f" ] || continue
  [ "$(basename "$f")" != fix-pi-live-throughput-codex.mjs ] || continue
  echo "  $(basename "$f")"
  node "$f"
done

bash "$REPO_DIR/assets/deploy-tps-speedometer.sh"

echo
python3 "$REPO_DIR/assets/codex-only.py" --agent-dir "$AGENT_DIR" --home "$HOME" --purge-retired-secrets
echo "Готово. Pi настроен только на Codex; поиск — hosted web_search через pi-openai-toolkit."
echo "Codex: /login openai-codex. Машинная OAuth-авторизация не копируется и не заменяется."
echo "Затем перезапусти pi: для Kitty-картинок в Orca /reload недостаточно. Компактные тулы включены; Ctrl+O раскрывает вывод."
