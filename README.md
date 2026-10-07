# pi-harness

Мой рабочий сетап [pi](https://pi.dev) (AI coding agent CLI) — конфиги, темы, расширения и решения с замерами.

Назначение репы: держать харнесс версионируемым и переносимым. Здесь лежат конфиги, точечные патчи и небольшие локальные UI-расширения; основные расширения ставятся из npm, секретов в репе нет.

Принцип подбора: **готовые расширения в первую очередь**. Баги пакетов закрываются точечными патчами в `patches/`. Авторизованное исключение — `agent/extensions/zzzz-compact-tools.ts`: компактный display-only рендер тулов, которого нет в настройках установленного UI.

## Что внутри

| Путь | Куда раскладывается |
|---|---|
| `agent/settings.json` | `~/.pi/agent/settings.json` — глобальные настройки pi |
| `agent/models.json` | `~/.pi/agent/models.json` — провайдер и модели |
| `agent/AGENTS.md` | `~/.pi/agent/AGENTS.md` — глобальные инструкции агенту |
| `agent/subagents.json` | `~/.pi/agent/subagents.json` — настройки субагентов |
| `agent/agents/*.md` | `~/.pi/agent/agents/` — кастомные типы субагентов |
| `agent/extensions/*.ts` | `~/.pi/agent/extensions/` — локальные UI-расширения, сохраняются при обновлении npm |
| `tests/compact-tools.mjs` | проверка компактного рендера на установленном pi |
| `tests/orca-math.mjs` | проверка Kitty-графики и реальных формул pi-math |
| `tests/subagents-live-tools.mjs` | регрессии live tool calls workflow; `--live` — проверка на Codex |
| `update.sh` | обновить npm-пакеты из апстрима, вернуть патчи и проверить live tool calls и формулы |
| `agent/themes/*.json` | `~/.pi/agent/themes/` — кастомные темы (`claude-code-light-hc`, `claude-green*`, `billy-aurora`) |
| `ext/settings.json` | `~/.pi/settings.json` — конфиг расширений (см. ниже, почему не `agent/`) |
| `assets/statusline.py` | `~/.local/share/claude-codex-statusline/statusline.py` — скрипт статус-строки (его же использует Claude Code) |
| `patches/*.mjs` | идемпотентные патчи к установленным пакетам; правит `node_modules`, применяет `install.sh` |
| `docs/` | журнал решений, замеры, что проверялось, бэклог |

Установка на новой машине: `./install.sh` (копирует с бэкапом существующих файлов).
JSON-пути адаптируются к `$HOME`; существующие команды получения ключей в
`models.json` сохраняются только для `openai-codex`. Старые провайдеры не восстанавливаются.
`auth.json` и OAuth-токены не копируются.
Конфиг `agent/extensions/pi-openai-toolkit/config.json` включает hosted web search
для Codex. Установщик поднимает старые npm-пакеты до проверенного минимума из
`assets/tested-package-versions.json`, не понижая более новые версии. На Linux нужны Python 3, Node.js/npm, git и `pi` в PATH (у брата `~/.npm-global/bin`); приложения и туннели Mac не переносятся. Каталог навыков `~/.agents/skills`, MCP-конфиги и учётные данные остаются машинными; Orca-managed расширения создаёт сам Orca. Временные диагностические probe-расширения не входят в репозиторий.

## Стек

Снимок конфигурации репозитория: **7 октября 2026** (не заявление о последних версиях npm).

- **pi** 1.0.4
- **провайдер/модель по умолчанию**: `openai-codex/gpt-6.1-sol`, thinking `high`
- **только Codex**: также доступны `openai-codex/gpt-6-sol` (xhigh), `openai-codex/gpt-6-astra` (medium). Все четыре стандартных субагента используют Codex Sol 6.1; поиск — hosted `web_search` через OpenAI toolkit. В `models.json` нет сторонних провайдеров.
- **compaction**: для доступных GPT-моделей с окном 272k `reserveTokens: 27000` → порог авто-компактизации при превышении 245k; для остальных моделей `reserveTokens: 1000`. `keepRecentTokens: 500` остаётся общим
- **thinking-блоки скрыты**: видно `Thinking…` во время и `Thought for Ns` после, содержимое не рендерится (`hideThinkingBlock: true`)
- **тема**: авто по системной теме macOS — светлая `claude-code-light-hc` / тёмная `claude-code-dark` (палитра Claude Code; в светлой приглушённые токены подтянуты до ≥4.5:1). Детект — `CSI ? 996 n` + подписка на mode 2031, Ghostty это отдаёт
- **статус-строка**: `pi-statusline` запускает тот же скрипт, что и Claude Code, с флагом `--no-quota` — папка, модель, размер контекста (`1M`), **реальный** уровень мышления, токены и `· имя сессии` (только pi); квота Codex в pi не спрашивается
- **TUI**: fullscreen
- **компактный вывод тулов**: одна строка без stdout, диффов, картинок и стриминг-превью; `Ctrl+O` раскрывает обычный рендер, `/compact-tools off` возвращает старый вид. Мигающая точка сохраняет своё место — текст не дёргается. Дополнительной группировки одинаковых вызовов нет; после сообщений пользователя и ассистента добавляется пустая строка
- **метрики**: `· ~32.2 ~45.5 TPS hit 90.9% in 28.00M out 229k` в нижнем статусбаре. Первое число — LIVE в reference-BPE `o200k_base`, второе — независимый native AVG: сумма output (включая reasoning) / сумма длительностей измеренных Codex-запросов. Native usage не масштабирует LIVE; idle между запросами не разбавляет AVG. Это delivery/effective request metrics, не backend decode TPS. Durable AVG начинается с включения/reset эпохи; неизвестный coverage даёт `-`, а старые usage без времени не выдумывают среднее. `in/out` — прежний записанный расход всей сессии. `/throughput reset` очищает LIVE, `reset-avg` — эпоху AVG. Подробности и пределы — ниже.
- **сессии**: `/sessions` от `@vanillagreen/pi-session-manager` открывает Current/All (`Tab`) и скрывает сохранённые сессии субагентов, оставляя обычные форки/ветки. Патч `fix-pi-session-manager-hide-subagents` не меняет штатный `/resume`, файлы сессий и возобновление субагентов по `@handle`.
- **формулы**: `@fadouse/pi-math@0.2.0` рисует MathJax-картинки через Kitty внутри Orca; локальное расширение `orca-kitty-images.ts` передаёт Pi графические возможности Orca. Формулы слева: белые в тёмной теме и тёмные в светлой, цвет меняется вместе с темой. Дисплейные формулы в Orca ужимаются в одну строку, иначе построчная перерисовка стирает картинки. Старый `pi-claude-code-ui` с Unicode-конвертером отключён; активен совместимый `better-claude-code-ui`.

## Расширения

Основные пакеты ставятся из npm (`pi install npm:<name>`). Локальный компактный рендер хранится в `agent/extensions/` и копируется установщиком.

| Пакет | Версия | Зачем |
|---|---|---|
| `better-claude-code-ui` | 0.1.9 | Рендер тулов в стиле Claude Code: группировка вызовов, Shiki-диффы, `Thought for Ns`, спиннер с CC-вербами, MCP-рендер(+ тема `claude-code-dark`) |
| `pi-statusline` | 0.0.2 | Статус-строка внешней командой (CC-совместимый JSON на stdin) — внизу та же строка, что в Claude Code; патч `fix-pi-statusline-refresh` |
| `pi-mcp-adapter` | 5.1.0 | MCP-серверы в pi (notion, telegram) |
| `@tintinweb/pi-subagents` | 0.19.0 проверена; npm без version pin | Субагенты и workflow-оркестрация; патчи `fix-subagents-typebox-peers` и `fix-subagents-live-tools` (live Activity) |
| `pi-live-throughput` | 0.3.0 + hybrid overlay | Нижний футер: `~LIVE ~AVG TPS`, независимые reference-BPE и native counters, durable coverage, hit % и session in/out |
| `pi-openai-toolkit` | 0.20.8 | Инструменты интеграции OpenAI, добавлен в текущие настройки |
| `@vanillagreen/pi-session-manager` | 2.0.4 | Менеджер `/sessions`: поиск, Current/All, возобновление, переименование и удаление; патч скрывает субагентов только в этом списке |
| `@fadouse/pi-math` | 0.2.0 | Настоящие LaTeX-картинки внутри Orca (MathJax → Kitty); патчи для однострочного отображения в Orca и зависимости xmldom |
| `orca-kitty-images.ts` | локальный | Безопасно распознаёт ORCA_IMAGE_PROTOCOL=kitty в Pi, сохраняет явный PI_IMAGE_PROTOCOL=none и блокирует tmux/screen |
| `zzzz-compact-tools.ts` | локальный | Однострочные тулколы без вывода, штатное раскрытие, стабильная позиция мигающей точки |

Конфиг расширений — `ext/settings.json` → `~/.pi/settings.json`. Важный нюанс: расширения семейства `pi-claude-code-ui` читают **не** `~/.pi/agent/settings.json`, а жёстко `$HOME/.pi/settings.json` и `$(pwd)/.pi/settings.json` (HOME-файл перекрывает проектный). Поэтому конфиг расширений живёт отдельным файлом и не смешивается с настройками pi.

Подробности по каждому решению — в `docs/`:

- [`docs/codex-throughput.md`](docs/codex-throughput.md) — гибрид LIVE/native AVG, независимые числители и фазы, persistence/reset/coverage, offline transport/session/deployment проверки
- [`docs/extensions.md`](docs/extensions.md) — что за расширения, какие у них настройки и что у них мертво
- [`docs/statusline.md`](docs/statusline.md) — статус-строка: `pi-statusline` + тот же скрипт (без квоты Codex, реальный уровень мышления)
- [`docs/light-theme.md`](docs/light-theme.md) — авто light/dark, светлая тема и патчи к cc-ui (две итерации)
- [`docs/compact-output.md`](docs/compact-output.md) — как сделан компактный вывод и замеры «до/после»
- [`docs/verification.md`](docs/verification.md) — как это проверялось (без веры на слово)
- [`docs/subagents-live-tools.md`](docs/subagents-live-tools.md) — исправление live Activity workflow, проверки на Codex и безопасные upstream-обновления
- [`docs/backlog.md`](docs/backlog.md) — что ещё хочется доделать, сюда же складываются идеи

## Как обновлять

Только новый гибридный TPS-счётчик, **без изменений settings, OAuth, темы или
прочих пакетов** (изолированный pinned reference runtime устанавливается вместе
с overlay; проверки выполняются до завершения общей транзакции):

```bash
cd ~/repos/pi-harness
./assets/deploy-tps-speedometer.sh
```

После установки — `/reload` в Pi. Новый native AVG не восстанавливается из
старых токенов без времени; начнётся собственная эпоха измерений.

Codex-only/TPS/statusline настройки, **без npm-обновлений и замены
машинной темы, MCP, навыков или пользовательских Codex-defaults**:

```bash
./assets/deploy-codex-status.sh
# У брата: export PATH="$HOME/.npm-global/bin:$PATH"; git pull --ff-only;
# затем ./assets/deploy-codex-status.sh из ~/repos/pi-harness
```

Скрипт проверяет известный hash общего Python-рендерера, применяет guarded overlays
и тестирует именно установленный код. Старые открытые Pi/терминалы/Orca следует
перезапустить: удалённый env-файл не стирает ключ из окружения уже живого процесса.
История чатов и Git не переписываются.

Полное upstream-обновление:

```bash
./update.sh                     # npm-пакеты + патчи + офлайн-регрессии
./update.sh --all               # то же, вместе с обновлением Pi
# Или вручную после обычного pi update --extensions / --all:
for p in ~/.pi/agent/patches/*.mjs; do node "$p"; done   # node_modules перезаписывается
cp ~/.pi/agent/settings.json    agent/settings.json      # и остальные файлы
cp ~/.pi/settings.json          ext/settings.json
cp ~/.pi/agent/extensions/zzzz-compact-tools.ts agent/extensions/
node tests/compact-tools.mjs
node tests/orca-math.mjs
# auth.json не копировать в репу; models.json канонически пуст (built-in Codex).
git add agent ext docs tests patches README.md install.sh update.sh
git commit -m "sync: <что поменялось>"
```

Патчи применяются к апстрим-пакету, не требуют форка. Codex TPS overlay хранит
свои TypeScript-исходники в `patches/pi-live-throughput/`; они копируются
установщиком и обновлением вместе с `fix-pi-live-throughput-codex.mjs` и `fix-pi-statusline-throughput.mjs`. Live-tools overlay проверяет все
контексты до записи и отказывается править неизвестный изменённый код; см.
[`docs/subagents-live-tools.md`](docs/subagents-live-tools.md). Для включения картинок после установки **перезапусти Pi** (`/reload` может быть недостаточно: протокол фиксируется при старте).

## Приватность

Ключи и OAuth-токены в репу не включаются; `auth.json` не отслеживается. Настройки, модельный кэш, агенты и поиск — только Codex. Миграция `assets/codex-only.py` удаляет старое поисковое расширение и его отдельный env-ключ, чистит конфигурационные бэкапы, сохраняет OAuth Codex, машинные темы и пользовательские Codex-модели. История чатов и встроенный каталог SDK не переписываются. Codex авторизуется через `/login`. В `.gitignore` закрыты `auth.json`, `models-store.json`, `sessions/`, `npm/`, `backups/`, `trust.json`.
