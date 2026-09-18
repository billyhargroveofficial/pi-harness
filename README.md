# pi-harness

Мой рабочий сетап [pi](https://pi.dev) (AI coding agent CLI) — конфиги, темы, расширения и решения с замерами.

Назначение репы: держать харнесс версионируемым и переносимым. Здесь лежат только текстовые конфиги; сами расширения ставятся из npm, секретов в репе нет.

Принцип подбора: **только готовые расширения**. Свой код не пишем — если готового решения нет, задача либо откладывается, либо закрывается настройкой (см. `docs/backlog.md`).

## Что внутри

| Путь | Куда раскладывается |
|---|---|
| `agent/settings.json` | `~/.pi/agent/settings.json` — глобальные настройки pi |
| `agent/models.json` | `~/.pi/agent/models.json` — провайдер и модели |
| `agent/AGENTS.md` | `~/.pi/agent/AGENTS.md` — глобальные инструкции агенту |
| `agent/subagents.json` | `~/.pi/agent/subagents.json` — настройки субагентов |
| `agent/agents/*.md` | `~/.pi/agent/agents/` — кастомные типы субагентов |
| `agent/themes/*.json` | `~/.pi/agent/themes/` — кастомные темы |
| `ext/settings.json` | `~/.pi/settings.json` — конфиг расширений (см. ниже, почему не `agent/`) |
| `docs/` | журнал решений, замеры, что проверялось, бэклог |

Установка на новой машине: `./install.sh` (копирует с бэкапом существующих файлов).

## Стек

- **pi** 0.85.1
- **провайдер/модель**: `deepseek/deepseek-flash` (DeepSeek V4.1 Flash, `openai-completions`, контекст 1M, max output 384k)
- **thinking**: уровень `max` по умолчанию, уровень `medium`/`xhigh` у модели скрыт (`thinkingLevelMap`)
- **thinking-блоки скрыты**: видно `Thinking…` во время и `Thought for Ns` после, содержимое не рендерится (`hideThinkingBlock: true`)
- **тема**: `claude-green` — тёплые нейтральные фоны в духе Claude Code + зелёный акцент `#A7C080` вместо рыжего
- **TUI**: fullscreen
- **компактный вывод тулов**: свёрнутая bash-строка — ровно одна строка, вывод только по `Ctrl+O`
- **метрики**: TPS / TTFT / avg через `pi-live-throughput`
- **формулы**: `$$ ... $$` рисуются юникод-текстом силами `pi-claude-code-ui` (картиночный `pi-math` с ним несовместим, снят)

## Расширения

Ставятся из npm (`pi install npm:<name>`), в репе лежат только их конфиги.

| Пакет | Версия | Зачем |
|---|---|---|
| `pi-claude-code-ui` | 1.0.83 | Рендер тулов в стиле Claude Code: группировка вызовов, Shiki-диффы, `Thought for Ns`, спиннер с CC-вербами, MCP-рендер |
| `@tintinweb/pi-subagents` | 0.19.0 | Субагенты и workflow-оркестрация (`Agent`, `SubagentWorkflow`) |
| `pi-deepseek-search` | 1.0.20 | Нативный веб-поиск DeepSeek как инструмент |
| `pi-live-throughput` | 0.2.0 | TPS / avg TPS / TTFT / peak / input / cache read после каждого ответа |

Конфиг расширений — `ext/settings.json` → `~/.pi/settings.json`. Важный нюанс: расширения семейства `pi-claude-code-ui` читают **не** `~/.pi/agent/settings.json`, а жёстко `$HOME/.pi/settings.json` и `$(pwd)/.pi/settings.json` (HOME-файл перекрывает проектный). Поэтому конфиг расширений живёт отдельным файлом и не смешивается с настройками pi.

Подробности по каждому решению — в `docs/`:

- [`docs/extensions.md`](docs/extensions.md) — что за расширения, какие у них настройки и что у них мертво
- [`docs/compact-output.md`](docs/compact-output.md) — как сделан компактный вывод и замеры «до/после»
- [`docs/verification.md`](docs/verification.md) — как это проверялось (без веры на слово)
- [`docs/backlog.md`](docs/backlog.md) — что ещё хочется доделать, сюда же складываются идеи

## Как обновлять

```bash
pi update --all                 # pi + пакеты
cp ~/.pi/agent/settings.json    agent/settings.json      # и остальные файлы
cp ~/.pi/settings.json          ext/settings.json
git commit -am "sync: <что поменялось>"
```

## Приватность

В репе нет ключей: `auth.json` пустой, API-ключ DeepSeek не хранится в конфиге, а подтягивается командой из `~/.config/deepseek.env` (см. `agent/models.json`). В `.gitignore` закрыты `auth.json`, `models-store.json`, `sessions/`, `npm/`, `backups/`, `trust.json`.
