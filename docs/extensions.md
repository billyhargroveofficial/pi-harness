# Расширения: что стоит, зачем и с какими настройками

**Актуальный набор (5 октября 2026):** `better-claude-code-ui@0.1.8` (рендер тулов в стиле CC, из него же тема), `@fadouse/pi-math@0.2.0` (MathJax-картинки),
`pi-statusline` (статус-строка = тот же скрипт, что в Claude Code — см. [`statusline.md`](statusline.md)),
`@tintinweb/pi-subagents`, `pi-deepseek-search`, `pi-live-throughput`, `pi-mcp-adapter`, `pi-openai-toolkit`,
`@vanillagreen/pi-session-manager@2.0.4` и локальный `zzzz-compact-tools.ts`. Разделы ниже — по пакетам;
`pi-claude-code-ui` оставлен установленным, но **отключён** (`"extensions": []`), его место занял форк.

## better-claude-code-ui (0.1.8)

Клон-форк `pi-claude-code-ui`: те же задачи (баннер, спиннер с CC-вербами, статус-строка, CC-рендер тулов,
Shiki-диффы, группировка вызовов), но без двух багов того пакета: chrome берётся из токенов **активной темы** (без
`+64`-осветления), а SGR-парсер не портит truecolor. Плюс `host-patches.ts`: патчит два публичных класса pi
(`AssistantMessageComponent`, `InteractiveMode`) рантаймом — пустые строки от скрытых thinking-блоков и мусорный
статус `Tool output: expanded` после `Ctrl+O`.

Темы: шесть CC-палитр (`claude-code-dark/light`, `-ansi`, `-daltonized`). Светлая тема нашей парой не используется —
вместо неё `claude-code-light-hc` (см. [`light-theme.md`](light-theme.md)), а её статус-строка отключена патчем в пользу
`pi-statusline`.

Патч: `patches/fix-better-cc-ui-light-legibility.mjs` — светлый diff-chrome, глоу спиннера от темы, контекстные строки
диффа без `DIM`, отключённый футер. Патч применяется `install.sh`, идемпотентен, воспроизводим из чистого апстрима
байт-в-байт (команды — в [`verification.md`](verification.md), п. 7).

Установленный форк читает `groupToolCalls`, `ccToolsExtraDetail`, `ccTheme` из `~/.pi/settings.json`.
`/cc-tools group on|off|toggle` переключает группировку, `/cc-tools detail on|off|toggle` — детализацию
(8 строк в обычном режиме, до 12000 в extra-detail). Старые ключи `previewLines`, `liveToolPreview`,
`bashCollapsedLines` нельзя считать настройкой этого форка: они относятся к предшественнику ниже.

## Локальный компактный рендер

`agent/extensions/zzzz-compact-tools.ts` — display-only патч `ToolExecutionComponent`, установленный вне npm.
Все свёрнутые тулы занимают одну строку без результатов и live-preview; `Ctrl+O` сохраняет штатное раскрытие.
При мигании кружочка его колонка остаётся зарезервированной. `/compact-tools on|off|toggle` управляет режимом
в памяти процесса. Установку делает `install.sh`; проверки — `node tests/compact-tools.mjs`.
Подробности и исторические замеры — [`compact-output.md`](compact-output.md).

## pi-openai-toolkit

Добавлен в локальный `agent/settings.json`. Конфиги авторизации и данные запросов в репу не копируются.
Встроенный MCP отключён через `extensions: ["-builtin:mcp"]`, остаётся установленный `pi-mcp-adapter`.

## @vanillagreen/pi-session-manager (2.0.4)

Отдельный браузер сессий `/sessions` (или `F1` после перезапуска Pi). `Tab` переключает Current/All;
All вызывает `SessionManager.listAll()` и читает сессии всех рабочих папок из стандартного
`~/.pi/agent/sessions/`. Проверено на изолированном HOME с двумя разными cwd: Current показал одну,
All — обе. Не заменяет штатный `/resume`: там `Tab` тоже переключает область поиска.

В обоих интерфейсах видны сохранённые дочерние сессии `@tintinweb/pi-subagents`. Установленный
менеджер не имеет фильтра «скрыть субагентов», а `Ctrl+N`/`Alt+N` фильтрует только *неименованные*
сессии — текущие субагенты имеют имена `Explore#…` и `general-purpose#…`, поэтому остаются видны.
`rememberAgents: false` в `agent/subagents.json` предотвратит появление **новых** дочерних сессий,
но отключит их долговременное возобновление по `@handle`; существующие сессии никуда не денутся.
Пока этот параметр не меняем и историю не удаляем.

## pi-statusline (0.0.2)

Запускает внешнюю команду статус-строки с CC-совместимым JSON на stdin и печатает её stdout в футере. Конфиг —
`statusLine` в `agent/settings.json`. Патч `patches/fix-pi-statusline-refresh.mjs` добавляет перерисовку на
`thinking_level_select` (иначе уровень мышления в строке отставал до конца хода). Полностью — [`statusline.md`](statusline.md).

## pi-claude-code-ui (1.0.83) — отключён

Предшественник: те же тулы/диффы, шёл из npm как `npm:pi-claude-code-ui`; в `agent/settings.json` у него стоит
`"extensions": []`, то есть код расширения не грузится (пакет остаётся ради темы и на случай возврата).
Патчи `patches/fix-cc-tools-light-chrome.mjs` — про него и применяются по-прежнему, если пакет вернуть в работу.

Рендерер тулов в стиле Claude Code. Переопределяет встроенные тулы (`read`, `bash`, `edit`, `write`, `grep`, `find`, `ls`), регистрируя свои с тем же именем — execution берётся из встроенных, меняется только отображение.

Что даёт:

- группировка соседних/параллельных вызовов (`● Bash: 2 done` + дерево `├ ● … └ ● …`);
- Shiki-диффы для `edit`/`write`/`apply_patch`: split или unified, word-level подсветка, `+N/-M`-сводка;
- `Thought for Ns` вместо простыни размышлений, спиннер с вербами из Claude Code (`Fermenting`, `Perambulating`, `Flibbertigibbeting`…), кадры `· ✢ ✳ ✶ ✻ ✽`;
- `⎿`-вывод, мигающая точка агента, live-preview выполняющихся тулов.

Команды: `/cc-tools` (status | outlines | transparent | default | group | thinking live|full | branch theme|fixed|<0-255> | detail), `/cc-theme` (привязка границ/диффов к активной теме pi), `/cc-spinner` (цвета верба и статуса).

### Что из README не работает

В 1.0.83 объявлены в `SettingsFile`, но **нигде не читаются** (проверено grep'ом по исходнику):

- `readOutputMode`, `searchOutputMode`, `bashOutputMode`
- `showTruncationHints`

Из `~/.pi/settings.json` их лучше убрать, чтобы не создавать иллюзию управления.

### Рабочие ключи (наши значения)

```json
{
  "toolBackground": "transparent",
  "mcpOutputMode": "preview",
  "previewLines": 1,
  "expandedPreviewMaxLines": 4000,
  "extraExpandedPreviewMaxLines": 12000,
  "groupToolCalls": true,
  "thinkingMode": "full",
  "bashCollapsedLines": 2,
  "bashCommandPreviewLines": 0,
  "liveToolPreview": false,
  "liveToolPreviewLines": 2,
  "diffCollapsedLines": 8,
  "themeAdaptive": true,
  "toolBranchColorMode": "theme"
}
```

`thinkingMode: "full"` — важно: значение `"live"` (дефолт расширения) принудительно разворачивает thinking во время стрима, перебивая `hideThinkingBlock`. `"full"` оставляет одну строку.

`toolBackground: "transparent"` — без рамок и фонов вокруг тул-строк (вариант автора расширения). `outlines` (дефолт) рисует горизонтальные правила вокруг каждого тула.

`themeAdaptive: true` + `toolBranchColorMode: "theme"` — расширение само выводит цвета границ/бранчей/диффов из активной темы pi. Ключевой нюанс: **это настройка расширения, а не темы pi** (она читается из `$HOME/.pi/settings.json`, см. ниже) — на выбор тёмной/светлой темы pi она не влияет вообще.

`diffTheme` убран намеренно. С ним `syncDiffShikiTheme()` выходит первой же строкой (`if (config.diffTheme) return;`), поэтому Shiki-тема кода в диффах не переключалась на `github-light`, а `autoDeriveBgFromTheme()` не пересчитывал фон под светлую панель. Значение `everforest-dark` при этом даже не входит в `DIFF_PRESETS` (там только `default`/`midnight`/`neon`) — то есть фон диффов оно не задавало, а авто-режим ломало. Без `diffTheme` диффы наследуются от темы: светлая панель → `github-light` + светлые тинты, тёмная → `github-dark`.

### Патчи к пакету

В 1.0.83 два бага бьют по светлым темам, оба закрыты патчем `patches/fix-cc-tools-light-chrome.mjs` (подробности и замеры — [`light-theme.md`](light-theme.md)):

1. `outlineChromeAnsiFromBranch()` всегда осветляет chrome на `+64` — на белом фоне `Thought for Ns` / `Turn took …` / рамки выцветали до ≈ 1.5:1. Патч: на светлой панели цвет тянется к `theme.text`.
2. `stripBackgroundAnsi()` выбрасывала компоненты truecolor-цвета, попавшие в диапазоны фоновых кодов (`40–49`, `100–107`) — `\x1b[38;2;92;106;114m` превращался в битую `\x1b[38;2;92;114m`, и терминал рисовал текст чужим цветом. Патч: `38`/`48`/`58` съедают свои аргументы.

Патч идемпотентен и применяется `install.sh`; после `pi update` (он переустановит пакет) — запустить заново:

```bash
node ~/.pi/agent/patches/fix-cc-tools-light-chrome.mjs
```

Что захардкожено и настройками не меняется: рамка вокруг юзер-сообщения (`roundedUserBorder`), коннекторы `├ └ │` (меняется только цвет), форма строк.

## pi-live-throughput (0.2.0)

Одна строка с метриками генерации. Живые значения берёт из `usage.output` провайдера, если тот отдаёт накопленный счёт во время стрима; иначе помечает оценку как `est.` / `~`.

```
⚡ 92.3 tok/s · avg 84.5 tok/s · 1.2k tok · 14.2s · deepseek-flash
✓ 512 tok in 2.0s · 256 tok/s avg · peak 319 tok/s · input 1.2k tok · cache read 8.0k tok · TTFT 420ms · approx. prompt 2900 tok/s
```

TTFT — от `before_provider_request` до первого содержательного события (текст/thinking/tool-call). Это end-to-end наблюдение: включает сеть, очередь, кеш, а не только prefill.

Режимы (по умолчанию `widget` — строка над редактором; `/throughput status` — компактная строка в футере):

| Команда | Действие |
|---|---|
| `/throughput` | вкл/выкл |
| `/throughput status` | компактный режим в футере |
| `/throughput widget` | строка над редактором |
| `/throughput reset` | сбросить измерение/итог |

Состояние режима живёт только в памяти сессии (`let mode = "widget"`), в файлы не пишется — после рестарта снова `widget`, включено.

## @tintinweb/pi-subagents (0.19.0)

Субагенты: `Agent` (одна задача) и `SubagentWorkflow` (детерминированная оркестрация скриптом: `pipeline`, `parallel`, `agent(..., {schema})`, гейты). Настройки — `agent/subagents.json`:

```json
{
  "maxConcurrent": 4,
  "maxConcurrentForeground": 4,
  "defaultMaxTurns": 60,
  "graceTurns": 3,
  "scopeModels": true,
  "strictAgentFiles": true,
  "workflowsEnabled": true,
  "schedulingEnabled": false,
  "showModel": true,
  "showCost": true,
  "reportUsage": true,
  "fleetView": true,
  "widgetMode": "background"
}
```

Пользовательские типы — `agent/agents/*.md` (frontmatter: `model`, `thinking`, `tools`, `extensions`, `prompt_mode`). Все четыре ходят через `deepseek/deepseek-flash` и имеют `web_search`. Важно: не ставить `isolated: true` там, где нужен веб-поиск — этот режим отключает расширения.

### Патч к пакету

В 0.19.0 манифест держит `typebox` и `@sinclair/typebox` в `dependencies`, хотя оба — хост-пакеты: pi отдаёт их расширениям своими jiti-алиасами (`getAliases()` в `dist/core/extensions/loader.js`). На старте pi ругается: физическая копия может перебить маппинг хоста и создать дублирующие модули/классы. Патч `patches/fix-subagents-typebox-peers.mjs` переносит оба пакета в `peerDependencies` с диапазоном `"*"` (как в `pi-mcp-adapter`) и убирает дубли из `node_modules`. Идемпотентен, применяется `install.sh`; после `pi update` (переустановит пакет) — запустить заново:

```bash
node ~/.pi/agent/patches/fix-subagents-typebox-peers.mjs
```

## pi-deepseek-search (1.0.20)

Нативный поиск DeepSeek как инструмент `web_search`: свежие данные + прямые ссылки на источники.

## Формулы: pi-math с активным better-claude-code-ui

Установлен `@fadouse/pi-math@0.2.0`: он рисует настоящий LaTeX (MathJax → SVG → Resvg → PNG → Kitty). `better-claude-code-ui` не переписывает LaTeX в ответах и потому не мешает `Markdown.render()` из pi-math. Устаревший `pi-claude-code-ui` отключён (`extensions: []`); **если его включить, конфликт вернётся** — старый конвертер переписывает формулы до pi-math. В Orca есть Kitty-графика, но Pi 1.0.2 не определяет `TERM_PROGRAM=Orca`; локальное расширение `orca-kitty-images.ts` переводит `ORCA_IMAGE_PROTOCOL=kitty` в capabilities Pi, уважает явный `PI_IMAGE_PROTOCOL=none` и не включается в tmux/screen.

`patches/fix-pi-math-zz-orca-style.mjs` выравнивает блочные формулы по левому краю с сохранением отступа текста. Следующий патч `fix-pi-math-zzz-theme.mjs` читает актуальный `ctx.ui.theme.appearance`: в тёмной теме формулы белые (`#ffffff`), в светлой — тёмные (`#202124`). Цвет входит в ключ кеша, поэтому при переключении темы картинка пересоздаётся; старый объект Theme не захватывается. Встроенные формулы остаются внутри строки. Переключение dark → light → dark, цвет и отступы проверяются в `tests/orca-math.mjs`; светлая тема проверена также визуально в Orca.

Orca при построчной перерисовке Pi стирает многострочные Kitty-картинки. Патч `patches/fix-pi-math-z-orca-one-row.mjs` масштабирует **только в Orca** дисплейные формулы до одной строки терминала, сохраняя настоящую типографику MathJax (у длинных формул размер будет мелким). В остальных терминалах pi-math работает как прежде. Патч применяется после переустановки пакета через `install.sh` или `update.sh`.

Регрессия: `node tests/orca-math.mjs` проверяет Kitty-последовательности для дисплейной и встроенной формулы, однострочность в Orca, неизменность исходного LaTeX и кодовых блоков, opt-out/tmux и активный стек UI. В `patches/fix-pi-math-xmldom.mjs` пинится безопасная транзитивная `@xmldom/xmldom@0.9.12` — MathJax 3 через speech-rule-engine жёстко тянет уязвимую 0.9.10. Проверено также визуально в терминале Orca. **Перезапусти Pi**, не ограничивайся `/reload`: Pi фиксирует протокол картинок при запуске. `/math-render status` должен показать `kitty`.

### История несовместимости старого UI

`pi-claude-code-ui` перехватывал математику сам: у него есть конвертер LaTeX → юникод (`\int → ∫`, `\sqrt{x} → √(x)`, греческие буквы и т.д.), и он переписывает текст **до** того, как до него доберётся markdown-компонент. Любое расширение, которое рисует формулы картинками через патч markdown, при включённом `pi-claude-code-ui` не получает LaTeX вообще.

Проверено на синтетических сессиях (одна и та же сессия, менялся только набор расширений):

| Конфиг | kitty-графиков в кадре | Что видно |
|---|---|---|
| cc-ui + pi-math | 0 | юникод-текст: `(a)/(b) = c`, `∇ · E = (ρ)/(ε_0)` |
| только pi-math | 7 | настоящие картинки MathJax |

Нюанс: команды, которых нет в таблице конвертера cc-ui (`\qquad`, `\det`, `\begin{pmatrix}` и пр.), остаются в выводе сырым LaTeX — именно это читается как «формулы не рисуются».

Настройки, чтобы выключить конвертер у старого cc-ui, нет; про pi-math он не знает. Поэтому раньше pi-math снимали, а рендерер тулов впоследствии заменили на `better-claude-code-ui` — он не трогает формулы.

