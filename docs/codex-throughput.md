# TPS: безопасная оценка доставки вывода (7 октября 2026)

## Итоговый интерфейс

```text
📁 harness-space · GPT-6.1 Sol 272k high 221k · ~47.4 TPS hit 90.9% in 28.00M out 229k
```

Это пример формата, не результат нового платного запроса. `momentum` и
`cumulative` удалены. Между основными блоками Pi — маленькая `·`; внутри метрик
нет лишних разделителей. Цвет — тот же серый palette 8. Узкая панель переносит
`TPS`, `hit`, `in`, `out` по полям, затем по словам. При ширине меньше одного
слова неизбежно усечение; все строки ограничены реальной терминальной шириной.
Claude Code сохраняет прежние большие разделители и квоту.

- **`~… TPS`** — приблизительная скорость доставки текста и аргументов тулов
  клиенту за последнее пригодное окно ответа, в условных токенах (UTF-16/4).
  Это **не** точный native decode TPS модели. `~` сохраняется и после завершения.
- **`- TPS`** — пока нет пригодного измерения для этой модели в текущем runtime
  (либо выполнен reset/смена модели/сессии/reload). В v4 последнее корректное TPS
  сохраняется во время пауз, прогрева нового ответа и отвергнутых измерений.
  Это последнее наблюдение, не обещание текущей скорости. Неуспешный ответ не
  заменяет подтверждённое значение своим provisional TPS.
- **`hit`** — cached input / complete input последнего ответа; `0.0%` означает
  подтверждённый промах, `-` — неизвестное. Это не cache hit вывода.
- **`in`** — сумма записанных `input + cacheRead + cacheWrite` всех запросов
  сессии. Повторная обработка одного промпта учитывается каждый раз. Это не
  текущая занятость контекста (`221k` в примере).
- **`out`** — сумма записанного native `usage.output`, **включая скрытый reasoning**.
  Помимо ответов учтены tool-result usage, cache warming, compaction и branch
  summaries, если Pi записал usage. Обрабатываются все сохранённые ветки и
  записи до компактизации. Не сообщённый провайдером расход восстановить нельзя.

Счётчики восстанавливаются из usage на старте/resume/reload и обновляются после
изменения журнала. IDs записей, response IDs и одинаковые объекты защищают от
повторного учёта. Невалидные, отрицательные, дробные/несуществующие счётчики и
переполнение safe integer не превращаются в нули или гигантские числа.

## Воспроизведённый дефект

Старая версия делила прирост последнего маленького chunk на разницу времён
доставки callback. Два callback могут прийти практически одновременно:

```js
w.add(1000, 40);
w.add(1000.0448592, 40);
// v2: 222919.71323598662 TPS
// v3/v4: undefined -> no new measurement (held good TPS, or "-" if none)
```

Дополнительное усиление происходило после `response.completed`: итоговый
`output_tokens - reasoning_tokens` пересчитывал короткое видимое окно. Native
usage не является точным счётчиком видимого текста: OpenAI отдельно предупреждает
о невидимых framing/message/tool/metadata tokens. Даже корректное вычитание
reasoning не делает такой коэффициент безопасным. В v4 итоговый billing usage
никогда не масштабирует скорость и не добавляет timed sample.

## Новая измерительная модель

1. Содержательные native text/function-call/custom-tool deltas получают
   монотонное клиентское время `performance.now()` до нормализации Pi.
2. Callback внутри 50 ms объединяются в один bucket. Весь первый bucket —
   baseline: его объём **исключён из числителя**, раз его получение начинает
   измеренный интервал. Done snapshots, пустые deltas и reasoning summaries
   ничего не прибавляют. Первый chunk не имеет наблюдённого интервала доставки.
3. Окно — около трёх секунд; слева оставляется baseline. Скорость вычисляется как
   `(cumulative_chars(last) - cumulative_chars(baseline)) / 4 / elapsed_seconds`.
4. Для отображения нужны ≥1 s, ≥4 buckets и ≥32 наблюдённых символов. Если один
   небазовый bucket даёт >80% объёма или оценка >1000 TPS, результат **отвергается**,
   а не обрезается до предела. Эти числа — наши консервативные UI-пороги,
   **не физические пределы Codex и не доказательство точности**.
5. При отсутствии пригодной новой оценки показывается последняя безопасная
   оценка окна. Таймер 500 ms обновляет журнал/UI, не создаёт токены и не делит
   вывод на время рендера. Raw window может устареть, но display fallback остаётся.
6. Новый запрос очищает временные samples, **не последнее подтверждённое TPS**.
   Live-оценка обновляется только пригодным окном; после успешной проверки ответа
   она становится подтверждённым fallback. Ошибочный/непроверенный ответ откатывает
   provisional значение к предыдущему подтверждённому. Burst в конце проверенного
   ответа не стирает пригодную оценку из его более раннего окна.
   Reset, смена модели/провайдера/сессии и reload очищают fallback. Пауза, после
   которой вывод возобновляется, входит в новое окно, пока не состарится.

Число `~` — осознанный proxy. Четыре UTF-16 единицы не равны четырём символам
Unicode или точной токенизации: CJK, кириллица, emoji, код, JSON, escape sequences
и разные токенизаторы дают иной коэффициент. Hash сравнивает UTF-16 байты, чтобы
разделённые между chunks суррогатные пары не ломали проверку целостности.

## Почему нельзя просто «отфильтровать выбросы»

- SSE/WS chunks — события доставки, а не аппаратные timestamps отдельных токенов.
  Буферизация прокси, HTTP/body parser, TCP, WebSocket frames, backpressure,
  задержки event loop/GC/расширений могут сжать большую часть ответа в один burst.
- Precise monotonic clock устраняет clock jumps и уточняет **клиентское** время,
  но не восстанавливает момент декодирования на сервере.
- Native output billing, hidden reasoning и видимый текст — разные множества.
  TTFT, очередь, prefill/cache, terminal tail, выполнение тулов и idle пользователя
  — разные интервалы, их нельзя без определения смешивать в одном TPS.
- Настоящая speculative decoding тоже может давать многотокенные bursts.
  Отвержение burst — недостаток наблюдаемости, не диагноз «модель врёт».
- Медиана, EMA, winsorization, clipping или накопленная средняя могут спрятать
  ошибку измерения. Поэтому нет smoothing/cumulative, а невалидный новый sample
  не обновляет TPS. Сохранённое число — последнее безопасное наблюдение, не
  восстановленная скорость ошибочного ответа. Без такого наблюдения — `-`.

Даже поток, равномерно выгруженный из буфера в течение нескольких секунд, может
пройти эти проверки. Клиент **не способен доказать server decode TPS** без
серверных timestamps/счётчика, а policy cap скрывает и некоторые настоящие
быстрые ответы. Здесь исправлен конкретный воспроизводимый spike и классы
наблюдаемой невалидности; «все возможные погрешности устранены» не утверждается.

## Матрица краевых случаев и наблюдаемость

| Класс | Защита / результат | Проверка / предел |
|---|---|---|
| One-shot, одинаковые/sub-ms timestamps, <1 s, мало buckets/chars | нет нового измерения; hold, либо `-` до первой оценки | literal 222919.7 repro + boundary/fuzz |
| Доминирующий большой chunk, uniform rate >policy | нет новой оценки; hold предыдущей пригодной, без clamp | burst, fast-distributed и held fixtures |
| Огромный native usage или поздний billing jump | влияет на `out`, не TPS | native=1M; реальный SDK parser |
| Reasoning summaries/hidden output | summaries не timed output; native output входит в `out` | reasoning=300, output=320 |
| Missing reasoning metadata | не масштабируем; guarded proxy возможен | native metadata absent fixture |
| Cache reads/writes | только input; не добавляются к output | hit bounds + usage totals |
| Первый chunk, пустой delta, repeated done snapshot | baseline/ignore; native hash подтверждает stream | fixture + surrogate split |
| Long terminal tail, tool execution, TTFT | не timed output | delayed completed fixture |
| Пауза между deltas / idle | пауза включается при возобновлении; последнее TPS сохраняется | pause, idle hold, next-request warmup |
| Clock rollback, NaN, Infinity, negative/fractional/overflow | fail-closed | deterministic inputs |
| Duplicate/out-of-order/missing sequence | consecutive seq required, когда поле есть | duplicate и seq-gap; отсутствие seq допускается |
| Response/item/content ID mismatch, lost text, malformed fields | текущая оценка отвергнута; fallback предыдущего проверенного ответа | native fixtures + parser + rollback |
| Retry / WS-created-before-message-start | новая response ID обнуляет окно; prepared measurement сохраняется | request lifecycle fixtures |
| Error, abort, length limit, incomplete/failed terminal | не заменяет предыдущий проверенный TPS; известный расход остаётся | each stop reason + failed provisional rollback |
| Hosted search/image/audio/refusal/unhandled output | неизвестный output type исключает TPS | conservative unsupported-output fixture |
| Provider/model/session change, reload, reset | rate очищен, usage восстановлен; reset не стирает usage | real extension handlers |
| Generic provider без native hook | guarded delta-only proxy; thinking/usage snapshot игнорируются | offline generic fixture; Codex-only конфиг его не выбирает |
| Branching, compaction, cache warming, classifier/image tool usage | recorded ledger учтён независимо от контекста | all supported entry kinds + event/idle refresh |
| Double message end, ID/object replay | dedup | same/clone response и history entry IDs |
| Narrow Unicode/ANSI footer, dynamic update | `·`, same gray, wrap units, no command rerun | widths 1–220; слова шире панели усекаются |
| Burst из реального server speculative decode / evenly buffered stream | нельзя различить по client data | явно сохраняющийся предел |
| Laptop sleep, networking delay, slow consumers | может быть отвергнут/занижен; clock не server clock | нет эмуляции каждой ОС/транспортной топологии |

## Первичные источники и привязка к решениям

Проверены 7 октября 2026; локальный код Pi — установленная версия, не предположение
о latest npm. Эти источники объясняют измерительные границы, **не задают наши
пороговые константы**.

1. [NVIDIA GenAI-Perf metrics](https://docs.nvidia.com/nim/benchmarking/llm/latest/metrics.html),
   `Inter Token Latency`: промежутки между tokens после первого, различие TTFT,
   end-to-end latency и generation phase. Не смешиваем фазы/числители.
2. [NVIDIA AIPerf metrics](https://docs.nvidia.com/aiperf/metrics.html),
   `inter_token_latency`, `chunked_inter_token_latency`, `time_per_output_token`:
   chunks и tokens — разные измерительные единицы; поэтому клиентский proxy.
3. [OpenAI reasoning](https://developers.openai.com/api/docs/guides/reasoning/),
   `How reasoning works`, `Controlling costs`: reasoning расходуется как output,
   есть также invisible message/tool/metadata tokens. Не rescale native usage.
4. [OpenAI streaming](https://developers.openai.com/api/docs/guides/streaming-responses/)
   и [Responses streaming events](https://developers.openai.com/api/reference/resources/responses/streaming-events):
   lifecycle/delta/done, sequence numbers, item/content indices. Не считаем snapshots
   новыми tokens, сверяем целостность потока.
5. [WHATWG Server-Sent Events](https://html.spec.whatwg.org/multipage/server-sent-events.html),
   `Interpreting an event stream`: line/block buffering может задержать dispatch.
   [WebSocket message event](https://developer.mozilla.org/en-US/docs/Web/API/WebSocket/message_event):
   timestamp события — не timestamp каждого token в сообщении.
6. [MDN performance.now](https://developer.mozilla.org/en-US/docs/Web/API/Performance/now),
   monotonic clock / ticking during sleep, и [Node event loop](https://nodejs.org/en/learn/asynchronous-work/event-loop-timers-and-nexttick):
   высокая точность часов не отменяет задержки callbacks.
7. [NVIDIA speculative decoding](https://docs.nvidia.com/nim/large-language-models/latest/speculative-decoding.html):
   multi-token decoding допустима; burst gate не устанавливает физическую истину.
8. [OpenAI prompt caching](https://developers.openai.com/api/docs/guides/prompt-caching/):
   cached_tokens — input usage, не вывод. Cache latency не server output TPS.
9. [NIST outliers](https://www.itl.nist.gov/div898/handbook/eda/section3/eda35h.htm):
   investigate/label vs accommodation; не маскируем неизвестный процесс clipping.
10. Локальный Pi: `dist/modes/interactive/components/footer.js:getSessionStats`,
    `dist/core/agent-session.js:getSessionStats`, `session-manager.d.ts`: набор
    recorded usage entries. Наши `in/out` не ограничены assistant messages.

## Проверка и установка

```bash
node tests/codex-throughput.mjs
node tests/codex-throughput-extension.mjs
python3 tests/statusline-session-name.py
```

Первый тест: adversarial cases и 1200 детерминированных schedule fuzz replays.
Второй: настоящий loader установленного Pi, настоящий Codex SSE parser, локальный
mock Response и dummy JWT; сеть отключена. Проверяются native/generic lifecycle,
usage counters, футер и hash guards. Никаких новых inference-запросов/затрат.
Старые synthetic benchmark TPS v2 не используются как gold standard: у них был
другой, небезопасный числитель и native rescale.

Payload — `patches/pi-live-throughput/*.ts`. Патчи принимают только известные
upstream/v2/v3/v4 хэши и предварительно проверяют все файлы; неизвестные правки не
перезаписываются. После установки в уже открытой Pi нужен `/reload` (для удаления
старых провайдеров и секретов из окружения надёжнее полностью перезапустить Pi).

Команды: `/throughput on|off|status|widget|reset`; default — включённый status.
Reset очищает только TPS, не журнал расходов. Отдельные настройки запроса,
содержимое сообщения, модель и учётные данные измерительное расширение не меняет.
