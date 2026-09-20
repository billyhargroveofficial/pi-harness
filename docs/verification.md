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

## 6. Светлая тема, chrome и битые ANSI

Правки светлой темы и патчей проверялись тремя способами — подробные команды и цифры в [`light-theme.md`](light-theme.md):

- **Замер по скриншотам (PIL).** Цвет берётся из пикселей кадра, а не из конфига: так нашлось, что текст юзер-сообщения рендерится `#99B89A` вместо теминого `#5C6A72`, а chrome — `#D1D7CE` (это `dim` + 64 без патча).
- **Живой прогон в pty на копии сессии.** Отдельный процесс pi с `--session /tmp/copy.jsonl` и `COLORFGBG=0;15` (намёк на светлый фон) — в захвате считаются маркеры: число битых `38;2;N;N m` (до патча 1, после 0), наличие целого цвета текста, значение chrome, ошибки загрузки расширения. Рабочая сессия при этом не трогается.
- **Юнит-тесты парсера SGR и воспроизводимость патча.** Патченная функция вырезается из `node_modules` и прогоняется на 11 кейсах; сам скрипт патча из чистого апстрима (`npm pack`) воспроизводит текущий файл байт-в-байт и при повторном запуске ничего не делает.

Ключевое отличие от пункта 1: реплей нужен для проверки *рендера*, а pty-прогон — для проверки *взаимодействия* настроек, детекта схемы терминала и патчей расширения в одном живом процессе.

## 7. Патч из чистого апстрима — байт-в-байт

Для `better-claude-code-ui` воспроизводимость проверяется так (пакет ставится заново, патч применяется в поддельный HOME):

```bash
cd /tmp && rm -rf ccui-clean && mkdir ccui-clean && cd ccui-clean
npm pack better-claude-code-ui@0.1.8 && tar xzf *.tgz
rm -rf /tmp/ccui-patched && mkdir -p /tmp/ccui-patched/.pi/agent/npm/node_modules/better-claude-code-ui
cp -r package/extension /tmp/ccui-patched/.pi/agent/npm/node_modules/better-claude-code-ui/extension
HOME=/tmp/ccui-patched node ~/repos/pi-harness/patches/fix-better-cc-ui-light-legibility.mjs
for f in index.ts palette.ts spinner.ts tools/diff.ts; do
  cmp /tmp/ccui-patched/.pi/agent/npm/node_modules/better-claude-code-ui/extension/$f \
      ~/.pi/agent/npm/node_modules/better-claude-code-ui/extension/$f && echo "$f идентичен"
done
```

Результат: все четыре файла совпадают с пропатченными в `node_modules`; повторный запуск патча печатает «все блоки уже на месте» (идемпотентность).

## 8. Юнит-тест глоу-рампы спиннера

Функция вырезается из пропатченного файла и прогоняется отдельно (файл копируется в `/tmp`: Node отказывается стрипать типы внутри `node_modules`):

```bash
mkdir -p /tmp/verify-ext && cd /tmp/verify-ext
sed 's|"\./palette.js"|"\./palette.ts"|g' ~/.pi/agent/npm/node_modules/better-claude-code-ui/extension/{spinner,palette}.ts
# блок от «/** Fallback glow ramp» до «function thinkingGlowPaint(» → glow.ts с export
node --experimental-strip-types harness.mjs
```

Считается контраст **всей фазы анимации** (41 точка) к фону схемы и собирается полная строка спиннера:

```
light: #6a6a6a → #3b3b3b   худший контраст за цикл = 5.41:1  OK
dark:  #999999 → #c9c9c9   худший контраст за цикл = 5.85:1  OK
⏺ Thinking… (5s · thinking with max effort)   ← thinking-текст #454545, 9.59:1 на белом
```

## 9. Контраст из ANSI-потока (с учётом DIM)

Захват pty разбирается по SGR-параметрам: трекаются `fg`, `bg`, атрибут `2` (dim) и полный сброс `0`. `DIM` считается как в терминале — 50 % к фону, иначе контекстные строки диффа выглядят «нормальными», хотя на экране они бледные. Только с этим учётом видно разницу «до/после»: контекст диффа был 1.35:1 (DIM), стал 9.63:1 (без DIM).

Скрипт-анализатор — тот же принцип, что в п. 6, но с полным сбросом: без обработки `\e[0m` цвет предыдущего сегмента (например, цвет вертикальной линейки диффа) ошибочно приписывается следующему тексту и даёт ложные 1.1:1.
