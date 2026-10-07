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

## 2. Офлайн-прогон LIVE/observed stream AVG (7 октября 2026)

```bash
node tests/codex-throughput.mjs
node tests/codex-throughput-oracles.mjs
node tests/codex-throughput-extension.mjs
node tests/codex-throughput-native-session.mjs
node tests/codex-throughput-transport.mjs
node tests/codex-throughput-deploy.mjs
```

Нужен dedicated pinned runtime `<agentDir>/tps-runtime`; TEMP можно выбрать
через `TPS_TOKENIZER_DIR`. Обе TPS используют reference-BPE prefix differences,
но LIVE — rolling window, AVG — постоянный first→last content interval ответа.
Native request durations больше не являются AVG.

Unit/controller — **99 PASS + 600 mathematical replays**, независимые oracle —
**8 PASS**, loader/footer/guards — **15 PASS**, actual SessionManager/saved-boundary —
**36 PASS**, subscription SSE/WebSocket — **17 PASS**, runtime/deploy — **46 PASS**.
Итого **221 checks + 600 replays**. Fixtures запрещают inference/реальную авторизацию.

Exact fixture даёт `~32.2 ~45.5 TPS`: весь поток 455 reference-токенов /10s,
последний rolling участок 161/5s. Native output 999999 не меняет оба TPS.
Weighted `100/1s +100/10s` = **200/11**, не55. Native output 320 (reasoning300)
сохраняет `out=320`, но не увеличивает наблюдаемый numerator.

AVG не включает TTFT, terminal/done/save tail, user/tool idle. Проверены крупный
first atomic prefix и его согласованное исключение, first/last timestamps между
checkpoint cadence, timer silence, whole-response baseline после LIVE pruning,
same-time/one-shot/sub-resolution/empty/reasoning-only unmeasured, signed BPE
recovery и native totals от missing/zero до миллиона. LIVE-only reset посреди
ответа не уничтожает его AVG. Новый namespace игнорирует и сохраняет прежние
native records; на reload начинается stream epoch без выдуманной миграции.

Настоящие Pi loader/ExtensionRunner/SessionManager/AgentSession replacement/save
boundary; native SSE parser и WS queue/retry/continuation. Delivery clock задаёт
внешний fixture driver, не метрика; whole-body burst не становится растянутым
stream. Real wall-clock stream с медленным соседним extension проверяет last
content boundary, не start→terminal. Crash/fork/tree/compaction/model/reset,
duplicate/late/conflicting events, saved text/tool identity и widths1–220 проверены.

Benchmark 50k callbacks: **26** full-prefix encode; около **22ms** на Mac в одном
прогоне — offline CPU fixture, не модельный TPS. Все пять acceptance suites и
actual-loader smoke запускаются транзакционно против **installed bytes**; guard
поддерживает predecessor c6faee7, rollback источников/runtime/canonical copies,
idempotence, first install, отказ на local edits и symlink escapes.

Protected files проверяются SHA-256 до/после feature-only deployment: models,
OAuth, settings/инструкции, Python statusline и существующий footer не изменяются.
Updater regression работает только в TEMP HOME и проверяет propagation ошибки23.
Полный набор сохранённых statusline/Codex-only/portable config/compact-tools/
subagents/session-manager/Orca Math регрессий также проходит.

Контракт: [codex-throughput.md](codex-throughput.md). Native effective request AVG
из предыдущей версии — историческая метрика, не эталон новой потоковой схемы.

## 3. Проверка загрузки

Тесты загружают реальный модуль через Pi loader и требуют `loaded.errors = []`.
Дополнительный интерактивный smoke boot без запроса к модели:

```bash
timeout 20 script -q /dev/null pi --tui-mode regular --no-session < /dev/null > /tmp/boot.raw 2>&1
```

Ресурсы и ошибки проверяются в фактическом capture, не по ожидаемому баннеру.

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

## 10. Статус-строка и Codex-only конфигурация

```bash
python3 tests/statusline-session-name.py
python3 tests/portable-config.py
python3 tests/codex-only.py
```

Statusline tests используют именованную, переименованную, очищенную и свежую
сессии; проверяют маленькие `·` только в Pi и прежние `●` в CC. Refresh hooks
проверяются для thinking и имени. Integration throughput проверяет Unicode/ANSI
widths 1–220 и динамический футер без повторного запуска Python.

Migration-тест на fake HOME проверяет удаление retired provider/search/отдельного
ключа, sanitization конфигурационных бэкапов, сохранение OAuth, приватных прав,
машинной темы, пользовательской Codex-модели и symlink общих инструкций.
Ошибочный JSON останавливает миграцию до записи других файлов. Офлайн-проверки
не утверждают успешный реальный HTTP inference или работоспособность чужого OAuth.

## 11. Компактные тулколы и неподвижный текст при мигании

```bash
node tests/compact-tools.mjs
bash -n install.sh
```

Тест без модели и сети загружает реальный `ToolExecutionComponent` установленного pi
через его jiti. Проверяет одну строку на ширинах 1–200, скрытие stdout,
раскрытие/сворачивание, клик, ошибки, пустые групповые строки, fallback MCP,
`/compact-tools on|off` и повторную загрузку без двойного патча.

Регрессия мигания: сравниваются колонки начала `Bash` и визуальные ширины строк
при `●` и пробеле вместо кружочка — должны совпадать. Если установлен
`better-claude-code-ui`, дополнительно прогоняются его реальные рендереры `bash`,
`read`, `write`; иначе это явно отмечается как SKIP. `PI_PACKAGE_ROOT` позволяет
указать нестандартную папку pi, `PI_AGENT_DIR` — папку пакетов пользователя.

Результат на pi 1.0.2 + better-claude-code-ui 0.1.8: все эти проверки PASS.
Пользователь отдельно подтвердил работу в живом TUI и отсутствие горизонтального
скачка после сохранения ведущих пробелов строки.
