# Аудит Codex TPS: решение перед реализацией

7 октября 2026. Workflow `codex-tps-speedometer-research`, run `wf_17a6e11e9f66`:
четыре независимых read-only исследования и один cross-result критик.
База кода: `ac30afa`; Pi 1.0.4. Это результат исследования, не реализованный v5.

## Почему нельзя просто добавить среднее

- CURRENT v4 считает UTF-16 / 4, не токены модели. Коэффициент зависит от языка,
  emoji, кода и структуры tool input. Тильда обозначает приближение, но не
  устраняет систематическую ошибку.
- Первый 50-ms bucket передвигает baseline: `40@0,500,1000,1500 ms` даёт 20,
  а split первого chunk `20@0 + 20@49` с остальными теми же points — 20.6754.
- Минимальные 4 buckets/1 s и cap 1000 отбирают типы ответа. Например, равномерные
  40 units каждые 5 s не показываются; равномерные 2000 proxy TPS отвергаются.
  AVG от прошедших gates будет средним отобранных наблюдений.
- Rolling windows перекрываются. Их объёмы/интервалы нельзя суммировать для AVG;
  арифметическое среднее TPS ответов тоже неверно.
- Held значение в тишине — LAST, не новый CURRENT.

## Что реально наблюдаемо

Исследование subscription-клиента установленного Pi и официального Codex
подтвердило terminal usage, включая output и reasoning metadata, если backend
их прислал. Нормализация Pi подставляет ноль для отсутствующих полей: raw отсутствие
reasoning нельзя принимать за подтверждённый ноль.

В доступных проверенных deltas не найден per-token cumulative counter либо
timestamps decode отдельных токенов. Время raw hook — время клиентского callback
после parse/queue; его меняют backpressure и awaited handlers других расширений.
Итоговый native output нельзя пропорционально растянуть на видимое короткое окно.

Public OpenAI token-counting documentation также описывает невидимые structural
output tokens, даже когда reasoning=0. Она объясняет предел локальной видимой
токенизации, но сама по себе не документирует subscription backend.

Для gpt-6.1-sol, gpt-6-sol, gpt-6-astra публичная проверенная tokenizer mapping
не установлена. Выбрать o200k_base по аналогии нельзя. Даже известный encoder
не восстанавливает native generated sequence и timestamps; encode каждого chunk
независимо некорректен из-за изменения unstable BPE suffix.

Protocol-исследователь сообщил optional websocket engine timing fields;
критик не воспроизвёл находку в текущем telemetry source. Без immutable source,
семантики weighting/единиц/token scope и response correlation эту находку нельзя
использовать в вычислениях или объявлять подтверждённой для подписки Billy.

## Два различающихся допустимых контракта

### Native effective provider-operation TPS

Числитель: сообщённые backend native output tokens, включая reasoning.
Знаменатель: полностью наблюдённая provider-operation duration, включая TTFT,
reasoning, transport pauses и terminal tail; исключая user/tool idle вне операции.

Итоговый показатель операции обновляется только при известном terminal usage.
Session AVG — отношение суммарных совместимых native tokens к суммарной
длительности. Это effective request throughput, **не live backend decode TPS**.
Если usage/time/coverage неизвестны, нельзя выдавать полный session AVG за известный.
Во время запроса native numerator текущего момента неизвестен: live CURRENT
не восстанавливается. Отображение LAST или `-` должно быть согласовано с Billy.

### Observable live delivery

Числитель: фактически доставленное текстовое содержимое, function arguments и
custom-tool input. Summaries/snapshots/billing ничего не добавляют.
Единица без verified tokenizer — UTF-16 units/s или bytes/s. `/4` и подпись `~TPS`
означали бы явно согласованные условные token-equivalents, не модельные токены.

Последние три секунды пересекаются с активной provider-operation; CURRENT —
объём за это пересечение / его длительность. AVG — объём всех операций / их
полную экспозицию, включая текущую. TTFT/внутренние паузы/terminal tail входят;
межзапросный user/tool idle не входит. Все chunks, включая первый, учитываются.
Нет cap/burst gates/EMA и цензуры по значению. Ноль при положительном наблюдаемом
интервале означает отсутствие доставки; нулевой знаменатель — неизвестно.
Нормально наблюдавшийся failed prefix не должен тихо исчезать из выборки.
Невалидное или неизвестное покрытие нельзя замаскировать исключением ответа.

После окончания операции активного CURRENT нет. Продолжать показывать последнее
наблюдение возможно только как явно согласованный LAST UI-контракт.

Оба контракта дают ratio-of-sums, но разные числители, фазы и величины. Нельзя
без пояснения вывести live proxy CURRENT рядом с native effective AVG как одну
однородную пару TPS. Ни один контракт не доказывает backend decode TPS.

## Persistence/lifecycle и обязательные изменения при реализации

- `message_end` вызывается до сохранения assistant и последующих replacement
  handlers. Финальную запись привязывать к `turn_end.messageEntryId` и фактически
  сохранённому message после повторной валидации.
- `pi.appendEntry` хранит non-context custom measurement records; не сохранять
  текст, credentials, tokens, raw events, absolute monotonic timestamps.
- Для полного AVG хранить coverage/start/end состояния, включая нулевой output
  и unknown interval. Одни successful observations не выявляют crash/старую
  историю/пропущенные операции.
- Дедуп записи/response key; conflicting duplicate не суммировать. После ошибки
  append проверить уже появившийся ключ: память меняется до синхронной file write.
- Session ID фильтрует собственные измерения; fork не должен превращать inherited
  history в новый наблюдавшийся запрос. Определить all-branches vs active-branch AVG.
- Reload/resume/compaction не выдумывают duration из message timestamps или usage.
- Reset семантика AVG требует отдельного durable epoch/coverage marker.
- Provider events содержат actual routed model; `ctx.model` может отличаться.
- Retry/WS fallback могут происходить без нового before_provider_request.
  Возможны metadata events до response.created, WS created до message_start.
- Замена выбранной модели во время tools не должна потерять frozen measurement.
- Параллельные операции требуют корреляции; current singleton не доказывает
  поддержку concurrency. Child/subagent timing не выводится из parent usage.

## Тесты, которые действительно нужны

- Ручные ratio-of-sums oracle: `100/1s + 100/10s = 200/11`, не 55.
- Нормальные быстрые/медленные, one-chunk/zero/failed-prefix, первый chunk,
  TTFT/tail, одинаковые времена, clock offset/rollback/NaN/overflow, literal spike.
- Полный итог при одинаковых operation boundaries и content не зависит от split;
  реальные split-surrogate и UTF-8/frame boundary случаи.
- SSE ReadableStream с управляемой доставкой и whole-body buffered case;
  нельзя передвигать clock в metrics callback и называть это проверкой доставки.
- Fake native WebSocket: очередь/close/fallback/cached continuation/backpressure;
  настоящий ExtensionRunner и медленный соседний handler.
- Реальный SessionManager: fork-at-assistant, reload/tree/compaction, replacement
  handlers, duplicate/conflicting measurements, reset во время operation, crash gap.
- Footer: оба числа в правильном порядке, целые numeric words при достаточной
  ширине; ширины 1–220, ANSI/Unicode, actual statusline loader/placement/refresh.
- Strict predecessor hash guards и rollback всего комплекта при сбое между writes;
  installed-source tests и compare после feature-only deployment, не full installer.

## Найденные слабые места старых проверок

Старый SSE fixture получает весь body сразу, но искусственно продвигает clock
на 500 ms внутри callback: это parser-routing test, не delivery timing oracle.
WS ordering проверяется ручными событиями, не native queue. Surrogate fixture
не режет саму surrogate pair. Fuzz допускает always undefined и policy cap, поэтому
не доказывает точную математику. Width test проверяет размер, не сохранность чисел.

Один исследователь запустил прежний unit-suite: 75 cases + 1200 replays PASS.
Это baseline, не тест новой реализации. Новые код/пакеты/настройки/auth/runtime
не изменялись; inference и перезапуски не выполнялись.

## Первичные источники исследования

- https://github.com/openai/codex/blob/main/codex-rs/model-provider-info/src/lib.rs
- https://github.com/openai/codex/blob/main/codex-rs/codex-api/src/sse/responses.rs
- https://github.com/earendil-works/pi/blob/main/packages/ai/src/api/openai-codex-responses.ts
- https://github.com/openai/tiktoken/blob/main/tiktoken/model.py
- https://github.com/openai/tiktoken/blob/main/tiktoken/core.py
- https://developers.openai.com/api/docs/guides/token-counting
- https://docs.nvidia.com/aiperf/dev/reference/ai-perf-metrics-reference

Ссылки на main изменяемы; перед реализацией зависимых решений закрепить версии.
Локальные установленные пути и исходные выводы сохранены в workflow JSONL.

## Последующее явное решение Billy

Billy утвердил гибрид: «нейтив для авг использовать лайв то что можно высчитывать
в реальном времени», подтвердив, что это два независимых счётчика.

Основной агент выбрал LIVE в reference-BPE o200k_base (явный proxy, не догадка
о native GPT-6 tokenizer), а AVG — native effective provider-operation TPS.
Подробный согласованный контракт: `docs/codex-tps-speedometer-task.md`.

Implementation/verification workflow `wf_3c95fa75fdc3` реализует этот выбор.
Поэтому рекомендация критика не смешивать estimands без согласования выполнена:
выбор раздельных величин сделан пользователем явно, а ограничения остаются.
Этот документ — исторический результат аудита; не утверждает, что v5 уже готов.
