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

## 2. Офлайн-прогон гибридного LIVE/native AVG (7 октября 2026)

```bash
node tests/codex-throughput.mjs
node tests/codex-throughput-oracles.mjs
node tests/codex-throughput-extension.mjs
node tests/codex-throughput-native-session.mjs
node tests/codex-throughput-transport.mjs
node tests/codex-throughput-deploy.mjs
```

Нужен dedicated pinned runtime `<agentDir>/tps-runtime`; TEMP-фикстуру можно
выбрать `TPS_TOKENIZER_DIR`. LIVE и AVG проверяются **разными** oracle:
reference-BPE prefix differences и native ratio-of-sums с client operation time.

После исправлений основным агентом: unit/controller suite — **99 PASS + 600
математических replay**, independent oracle — **8 PASS**, loader/footer/guards —
**15 PASS**, actual SessionManager/saved-boundary suite — **34 PASS**, native
SSE/WebSocket transport — **17 PASS**. Сеть/inference запрещены fixtures;
настоящие credentials и приватные session contents не читаются.

Exact hybrid fixture выводит `~32.2 ~45.5 TPS`. Нативный `output=320` с
`reasoning=300` даёт numerator **320**, не 20. Weighted `100/1s + 100/10s`
даёт **200/11**, не 55. Смена native output не изменяет LIVE.

Реальный SSE delivery schedule задаёт clock вне metrics callback; whole-body
buffered test не растягивает события искусственно. Есть actual Pi loader,
ExtensionRunner, SessionManager/AgentSession boundary, native WS queue,
retry/continuation, reset-before-deferred-start, late duplicate end, crash gap,
fork/compaction, saved replacement, dedup/conflicting records и widths 1–220.
Дополнительные регрессии защищают net signed BPE recovery, replay epoch markers
и финальные tool identities/arguments независимо от AVG.

Benchmark: 50 000 символов/callbacks, **26** полных encode, около **21 ms** общего
offline wall time на Mac в конкретном прогоне (не server latency/модельный TPS).
Runtime/deploy suite — **45 PASS**. Все пять acceptance suites и actual-loader
smoke прошли также внутри реального Mac deployment против installed bytes,
без `TPS_TOKENIZER_DIR`; successful install не подменён canonical-only тестами.
Суммарно: **218 checks + 600 mathematical replays**. Восемь файлов моделей,
OAuth/инструкций/настроек и существующего футера остались byte-identical.
Isolated updater regression дополнительно проверяет flags/reinstall/error
propagation; его HOME и agent directory находятся только в TEMP.

Контракт и пределы: [codex-throughput.md](codex-throughput.md). Старые UTF-16/4
или native-rescaled числа не используются как эталон новой схемы.

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
