# Расширения: что стоит, зачем и с какими настройками

## pi-claude-code-ui (1.0.83)

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
  "diffTheme": "everforest-dark",
  "toolBranchColorMode": "theme"
}
```

`thinkingMode: "full"` — важно: значение `"live"` (дефолт расширения) принудительно разворачивает thinking во время стрима, перебивая `hideThinkingBlock`. `"full"` оставляет одну строку.

`toolBackground: "transparent"` — без рамок и фонов вокруг тул-строк (вариант автора расширения). `outlines` (дефолт) рисует горизонтальные правила вокруг каждого тула.

`diffTheme: "everforest-dark"` + `toolBranchColorMode: "theme"` — подгонка под зелёную тему `claude-green`.

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

## pi-deepseek-search (1.0.20)

Нативный поиск DeepSeek как инструмент `web_search`: свежие данные + прямые ссылки на источники.

## Формулы: почему без отдельного расширения

`pi-claude-code-ui` перехватывает математику сам: у него есть конвертер LaTeX → юникод (`\int → ∫`, `\sqrt{x} → √(x)`, греческие буквы и т.д.), и он переписывает текст **до** того, как до него доберётся markdown-компонент. Любое расширение, которое рисует формулы картинками через патч markdown (`@fadouse/pi-math`: MathJax → SVG → Resvg → PNG), при живом `pi-claude-code-ui` не получает LaTeX вообще.

Проверено на синтетических сессиях (одна и та же сессия, менялся только набор расширений):

| Конфиг | kitty-графиков в кадре | Что видно |
|---|---|---|
| cc-ui + pi-math | 0 | юникод-текст: `(a)/(b) = c`, `∇ · E = (ρ)/(ε_0)` |
| только pi-math | 7 | настоящие картинки MathJax |

Нюанс: команды, которых нет в таблице конвертера cc-ui (`\qquad`, `\det`, `\begin{pmatrix}` и пр.), остаются в выводе сырым LaTeX — именно это читается как «формулы не рисуются».

Настройки, чтобы выключить конвертер у cc-ui, нет; про pi-math он не знает. Поэтому `pi-math` снят: в паре с cc-ui он не делал ничего, но тянул `mathjax-full` (40 МБ). Если однажды захочется картинок — надо менять рендерер тулов на тот, который не трогает markdown (кандидат: `@vanillagreen/pi-tool-renderer`, не проверялся).

