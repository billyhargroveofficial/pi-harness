# Codex TPS: независимые LIVE и native AVG (7 октября 2026)

## Формат и смысл

```text
📁 harness-space · GPT-6.1 Sol 272k high 221k · ~32.2 ~45.5 TPS hit 90.9% in 28.00M out 229k
```

Числа в примере демонстрируют формат, а не результат inference-запроса.

1. **Первое — LIVE**: приблизительная скорость доставки видимого текста и tool
   input клиенту в reference-BPE единицах `o200k_base`.
2. **Второе — AVG**: сумма сообщённых backend native output-токенов / сумма полных
   длительностей измеренных Codex provider operations. Включает hidden reasoning.

Это **два разных счётчика**, явно выбранных Billy. Их равенство не ожидается.
Native terminal usage не масштабирует LIVE. AVG не усредняет LIVE, окна или
TPS отдельных ответов. Никаких `momentum`/`cumulative` и дополнительных подписей
в компактной строке; серый palette 8, маленькие `·`, прежние `hit/in/out` сохранены.

Тильда у LIVE означает reference-token approximation, а у AVG — клиентские
границы времени. Ни одно число не объявляется аппаратным backend decode TPS.

## LIVE: вместо UTF-16 / 4

Используется закреплённый `gpt-tokenizer@4.0.0`, encoder `o200k_base`.
**Это явно выбранный reference encoder, не установленная mapping GPT-6.**

- Encode целых накопленных logical text/tool parts, не независимых chunks.
  Кириллица, CJK, emoji, JSON и строки, похожие на специальные токены,
  обрабатываются как обычное содержимое. Кешируются неизменившиеся parts.
- Checkpoint примерно раз в 200 ms. Первый атомарный checkpoint — untimed
  baseline; его токены и время исключены согласованно. Он не передвигается
  произвольным 50-ms bucket.
- Отношение разницы prefix counts к интервалу последнего приблизительно
  трёхсекундного наблюдаемого окна. Слева сохранён checkpoint at/before cutoff;
  между событиями не выдумываются token timestamps или interpolation.
- До наблюдённого интервала 1 s — warmup, а не деление на sub-ms callback gap.
  Это resolution threshold, не физический предел скорости модели.
- Пересборка unstable BPE suffix может уменьшить prefix count. Signed изменения
  входят в **итоговую** разность; промежуточное уменьшение не выбрасывает
  положительный результат всего окна. Отрицательный итог — неизвестно, не clamp.
- Нет caps по TPS, minChars/minBuckets, burstShare gate, EMA/winsorization.
  Подтверждённый ноль и низкие/высокие измерения не цензурируются по величине.
- Таймер не создаёт токены, но увеличивает длительность активного окна. В активной
  тишине LIVE затухает до `~0.0`. Idle/warmup fallback — последнее final-saved
  проверенное значение (**LAST**), не новая мгновенная скорость.
- Перед подтверждением LAST проверяются response/item/content identity, sequence,
  hashes и окончательно сохранённые текст/tool calls после replacement handlers.
  Tool name/ID/namespace и нормализованные arguments/input не могут незаметно
  замениться. Несовпадение LIVE не уничтожает известные native токены AVG.
- Temporary content только в RAM, общий предел 256 Ki UTF-16 units на ответ.
  При превышении или отсутствии/ошибке dedicated runtime LIVE неизвестен;
  native AVG остаётся работоспособен. После freeze/reset содержимое удаляется.

Reference-токенизация не восстанавливает скрытые/structural native tokens,
серверные token IDs или decode timestamps. Буферизация, parsing, WS queue,
backpressure и awaited соседние extensions меняют клиентскую доставку. Сглаживание
или «красивые» caps не могут восстановить серверное время.

## AVG: native ratio-of-sums

Числитель берётся из raw terminal `response.usage.output_tokens`, **включая
reasoning**. Отсутствующий output неизвестен, явный raw ноль — измеренный ноль.
Отсутствие reasoning details не превращает известный total output в неизвестный
и не заставляет его вычитать либо оценивать по тексту.

Интервал: `before_provider_request → native terminal callback`.

- Входят TTFT, очередь/handshake, reasoning, внутрипоточные паузы и terminal tail.
- User idle и выполнение внешних tools **между** provider operations не входят.
- AVG завершённых измеренных операций = `ΣnativeTokens × 1000 / ΣelapsedMs`.
  Пример: `100 tokens / 1s + 100 / 10s` даёт `200/11`, **не 55 TPS**.
- Пока идёт новый запрос, сохраняется AVG завершённых операций. Старые токены
  не делятся на растущий elapsed нового запроса с ещё неизвестным output.
- Короткие, one-shot, медленные/быстрые, reasoning-only и unsupported для LIVE
  ответы не исключаются по LIVE eligibility.
- Failed/incomplete/error с достоверным raw usage и matched identity/time могут
  учитываться. Missing usage/clock/correlation или неизвестный расход ранней
  retry attempt делает coverage неизвестным, а не нулём/пропуском.
- Retries с известным usage всех attempts суммируют токены, сохраняя полный
  интервал операции. Native completion не пересчитывает live tail.
- Freeze в `message_end`; commit только через сохранённый assistant в
  `turn_end.messageEntryId/getEntry` после replacement handlers. Поздний конец
  предыдущего ответа не может заморозить новый запрос.

Это effective request throughput, не отдельный decode-only показатель. Особенно
при большом reasoning LIVE и AVG могут существенно различаться.

## Сессия, coverage и команды

AVG охватывает **измеренные Codex операции собственного session ID с момента
включения/последнего reset эпохи**, всех его веток и моделей. Старые исторические
usage без длительности не превращаются в придуманный AVG. Hidden child/subagent
и вспомогательные usage без соответствующего operation interval входят в `in/out`,
но не добавляются тайно к AVG.

`pi.appendEntry` сохраняет только version/metric/epoch, start/observation/unknown,
origin, hashed operation/response identifiers, attribution, native count и elapsed.
Не сохраняются текст, промпты, token IDs, payload, credentials или абсолютный
monotonic clock. Records не входят в контекст модели.

Reload/resume/compaction восстанавливают сумму; чужие inherited records fork
исключены. Replay epoch marker не отменяет reset и не скрывает unknown coverage.
Unclosed start после crash → AVG `-`; конфликтующие duplicates и overflow — тоже
неизвестно. Model switch очищает LIVE, **не** сессионный native AVG.

```text
/throughput on|off|widget|status
/throughput reset       # LIVE only; AVG и native in/out остаются
/throughput reset-avg   # новая durable эпоха AVG
/throughput reset-all   # LIVE + новая эпоха AVG; usage остаётся
```

Ответ, начатый до AVG-reset, не переносится в новую эпоху — включая WS created
перед отложенным SDK message_start. Следующий настоящий pre-request boundary
разрешает новые измерения. При неизвестном coverage можно начать новую эпоху
`reset-avg`; пропущенное время/токены не восстанавливаются задним числом.

Вне Codex пара TPS — `- - TPS`. `hit` — cache read / полный input последнего ответа;
`in/out` — прежняя native usage accounting всех записанных веток/auxiliary costs.

## Runtime, deployment и offline verification

Reference package изолирован в `<agentDir>/tps-runtime`, pinned manifest/lock;
`npm ci --ignore-scripts`, без изменения Pi npm manifests. Resolver обязан
оставаться внутри dedicated runtime: parent-node_modules fallback недопустим.

`assets/deploy-tps-speedometer.sh` — feature-only deployment. Он не меняет модели,
settings, OAuth, тему, MCP, skills, statusline.py или transport. Runtime, overlay
и canonical patch copies обновляются одним guarded комплектом с rollback при
ошибке проверки; не полный installer. Unknown local edits не перезаписываются.

Offline suites (нужен установленный runtime либо `TPS_TOKENIZER_DIR`):

```bash
node tests/codex-throughput.mjs
node tests/codex-throughput-oracles.mjs
node tests/codex-throughput-extension.mjs
node tests/codex-throughput-native-session.mjs
node tests/codex-throughput-transport.mjs
node tests/codex-throughput-deploy.mjs
```

Есть ручные математические oracle, actual Pi loader/ExtensionRunner/SessionManager,
SSE с delivery schedule вне metrics callback, native WS queue/retry/continuation,
saved-message boundaries, narrow footer, persistence/crash/fork/reset и guarded
rollback. Все используют synthetic fixtures и dummy auth, не inference.

После deployment действующая Pi загружает новые файлы через `/reload`.
Рабочие сервисы/SSH/Orca автоматически не перезапускаются.

## Исследование и первичные источники

- Решение Billy и контракт: `docs/codex-tps-speedometer-task.md`.
- Независимые исследования/ограничения: `docs/codex-tps-speedometer-audit.md`.
- OpenAI subscription implementation: https://github.com/openai/codex/tree/main/codex-rs/codex-api/src/sse
- Pi native transport: https://github.com/earendil-works/pi/blob/main/packages/ai/src/api/openai-codex-responses.ts
- OpenAI token counting: https://developers.openai.com/api/docs/guides/token-counting
- OpenAI tiktoken mapping/core: https://github.com/openai/tiktoken/tree/main/tiktoken
- Reference implementation: https://github.com/niieani/gpt-tokenizer
- NVIDIA client/chunk/token metrics: https://docs.nvidia.com/aiperf/dev/reference/ai-perf-metrics-reference

Optional backend timing, не воспроизведённый критиком и не определённый для
конкретного subscription transport, не используется как выдуманный server TPS.
