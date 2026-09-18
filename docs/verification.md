# Как это проверялось

Правило: не верить конфигу и README, а смотреть, что реально рендерится и что реально читается кодом.

## 1. Реплей реальной сессии в pty

Живой турн в pty не всегда успевает завершиться в окно захвата (модель долго отдаёт первый токен при полном наборе тулов), поэтому рендер проверяется на реплее сохранённой сессии — без сети и модели:

```bash
timeout 30 script -q /dev/null pi --tui-mode regular --session \
  ~/.pi/agent/sessions/<dir>/<session>.jsonl < /dev/null > /tmp/replay.raw 2>&1
```

Дальше снимаются ANSI-последовательности и считаются маркеры (`Done (N lines)`, `Thought for`, `● Bash`, `╭`). Режим `regular` обязателен для замеров: в fullscreen TUI пишет кадры диффом и строки накладываются друг на друга.

Так получены цифры из [`compact-output.md`](compact-output.md) и проверка скрытия thinking (5 блоков → 5 строк `Thought for`, 0 утечек).

## 2. Синтетический прогон расширения

`pi-live-throughput` проверяется без модели: модуль расширения импортируется как есть и управляется фиктивным API pi — собираются обработчики `on(...)`, подменяется `ctx.ui`, затем посылаются синтетические события `session_start` → `before_provider_request` → `message_start` → серия `message_update` → `message_end`.

Нюанс: Node отказывается стрипать типы для файлов внутри `node_modules` (`ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING`), поэтому копия файла кладётся в `/tmp` и импортируется оттуда:

```bash
cp ~/.pi/agent/npm/node_modules/pi-live-throughput/src/index.ts /tmp/live-throughput-test.ts
node --experimental-strip-types /tmp/tps-check.mjs
```

Полученный рендер (реальный вывод расширения, не ожидания):

```
⚡ 206 tok/s · avg 206 tok/s · 100 tok · 0.5s · deepseek-flash
✓ 512 tok in 0.7s · 702 tok/s avg · peak 247 tok/s · input 1.2k tok · cache read 8.0k tok · TTFT 703ms · approx. prompt 1707 tok/s · deepseek-flash
/throughput status → ✓ 512 tok · 702 tok/s · input 1.2k tok · cache read 8.0k tok · TTFT 703ms · approx. prompt 1707 tok/s
/throughput off    → виджет и статус очищены
```

TTFT = 703 ms при вставленной в тест паузе 700 ms — значит отсчёт идёт от границы запроса к провайдеру до первого содержательного события, как заявлено.

## 3. Проверка загрузки

```bash
timeout 20 script -q /dev/null pi --tui-mode regular --no-session < /dev/null > /tmp/boot.raw 2>&1
```

В шапке ресурсов видно, что именно подхватилось:

```
[Extensions]  @tintinweb/pi-subagents@0.19.0:src, pi-claude-code-ui,
              pi-claude-code-ui:spinner.ts, pi-deepseek-search@1.0.20,
              pi-live-throughput:src
[Themes]      billy-aurora, claude-green
```

Плюс проверка на ошибки в кадре (`error|failed|cannot`) — пусто.

## 4. Валидация темы

Тема прогоняется через собственный валидатор pi, а не «на глаз»:

```bash
node --input-type=module -e "
const { validateThemeJson } = await import(
  '<pi>/dist/modes/interactive/theme/theme-json.js');
const json = JSON.parse(require('fs').readFileSync(process.env.HOME +
  '/.pi/agent/themes/claude-green.json','utf8'));
console.log(validateThemeJson('claude-green', json).name);
"
```

Результат: `VALID ✔`, 56 токенов, загрузка через `loadThemeFromPath` в режиме `truecolor` с корректной подстановкой `vars` (проверены `accent`, диффы, границы thinking-уровней, `bashMode`).

## 5. Проверка, что настройка реально читается

Мёртвые ключи ищутся grep'ом по исходнику расширения, а не по README:

```bash
grep -n "readOutputMode\|searchOutputMode\|bashOutputMode" \
  ~/.pi/agent/npm/node_modules/pi-claude-code-ui/extensions/index.ts
```

Так найдено, что в 1.0.83 эти три ключа и `showTruncationHints` объявлены только в интерфейсе настроек и нигде не используются.
