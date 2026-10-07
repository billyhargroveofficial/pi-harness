# Задача: CURRENT + session AVG TPS для Codex-подписки

Запрошено Billy 7 октября 2026. Начальная версия: pi-harness `ac30afa`, метрики v4.
Статус: гибридная реализация завершена и проверена: 218 checks + 600 mathematical
replays, реальные loader/parser/sessionManager и installed-source Mac deployment.
Два независимых счётчика утверждены Billy: LIVE из доступного потока, native AVG
из usage. Implementation workflow `wf_3c95fa75fdc3` + исправления findings основным
агентом. Контракт/ограничения: `docs/codex-throughput.md`; результаты проверки:
`docs/verification.md`; исследование: `docs/codex-tps-speedometer-audit.md`.

## Утверждённый гибридный контракт

Billy: «нейтив для авг использовать лайв то что можно высчитывать в реальном
времени», затем «два числа пускай показывает с разных счетчиков как и задумывалось».

- LIVE — reference-BPE o200k_base доступного текста и tool input / наблюдённый
  интервал доставки. Это явно выбранная приближённая единица, НЕ утверждение,
  что модель GPT-6 имеет этот tokenizer. Заменяет старый UTF-16/4 proxy, который
  особенно зависел от языка. Count целых logical parts, не отдельных chunks.
- AVG — сумма raw native output_tokens (включая reasoning) / сумма полных
  длительностей измеренных Codex provider operations, от before_provider_request
  до native terminal event. TTFT, reasoning и transport/terminal pauses входят;
  user/tool idle между операциями не входит. Это effective request TPS,
  НЕ backend decode TPS. Reasoning metadata не нужно для известного total output.
- Два числителя и знаменателя независимы. Native usage не масштабирует LIVE;
  LIVE/current windows не фильтруют и не усредняют native AVG.
- AVG завершённых измеренных операций обновляется после их завершения. В активном
  запросе неизвестный current native output не заменяется старым numerator,
  делённым на растущий elapsed. Явно неизвестный coverage приводит к `-`.
- Сохранение AVG с эпохой измерений, start/observation/unknown records и own session
  origin. У старых расходов до включения счётчика нет времени: они не превращаются
  в AVG. UI без дополнительных надписей: `~32.2 ~45.5 TPS`.
- `/throughput reset` очищает LIVE, сохраняет AVG/usage. `reset-avg` и `reset-all`
  создают durable новую эпоху; ответ, начатый до reset, не смешивается с новой.

Из-за разных измеряемых величин равенство этих чисел не ожидается. Особенно
reasoning-heavy ответ может иметь низкий/неизвестный LIVE и высокий native AVG.
Тильда у native AVG относится к клиентской границе времени, не к выдуманным токенам.

## Интерфейс

```text
~32.2 ~45.5 TPS hit 90.9% in 28.00M out 229k
```

- Первое число — CURRENT, второе — AVG за сессию.
- Не добавлять надписи CURRENT/AVG в компактную строку.
- Сохранить `hit`, `in`, `out`, серый цвет, маленькие `·`, status/widget и переносы.
- Пустое/непригодное наблюдение не подменять нулём, произвольным числом либо cap.
- Сохранённое последнее измерение должно оставаться именно последним измерением,
  а не объявляться новой скоростью в период простоя.

## Требования к расчёту

1. Зафиксировать источники каждого числителя и интервала отдельно. После явного
   решения Billy LIVE и AVG намеренно измеряют разные величины; не объявлять их
   двумя оценками одной и той же backend decode скорости.
2. Проверить настоящий Codex subscription transport установленного Pi,
   а не делать выводы только по публичному Responses API.
3. Устранить исправимые систематические смещения в обе стороны. Отдельно проверить
   зависимость от языка/кода/JSON/emoji, размера chunk, bucket и фаз ответа.
4. AVG — отношение сумм native output и полных operation intervals, не среднее
   значений на UI-тиках и не среднее средних. Idle пользователя и выполнение
   внешних инструментов между запросами не входят. TTFT/hidden reasoning/terminal
   tail входят по явно выбранному native effective request estimand.
5. Нельзя считать first-chunk tokens поверх ненаблюдавшегося интервала или
   растягивать итоговый native usage на случайный короткий хвост потока.
6. Не использовать clamps, winsorization, красивую EMA или отбор только быстрых
   ответов для получения «правдоподобных» значений. Проверить selection bias
   старых порогов и влияние исключённых коротких/медленных/быстрых ответов.
7. Streaming tokenizer, если нужен, обязан корректно учитывать границы BPE,
   части items, surrogate pairs и re-tokenization. Независимое encode каждого
   chunk недопустимо. Неподтверждённый tokenizer не называть native/exact.
8. Session AVG должен безопасно переживать reload/resume, compaction, fork/tree,
   reset, retry, повторные события, модель/провайдер, abort/error и unsupported
   output. Исторические токены без сохранённого времени нельзя превращать в TPS.
9. Персистентность — только числовые измерения/минимальные идентификаторы;
   не записывать текст, токены авторизации, промпты, полные события или секреты.
10. Не менять модели/параметры запросов, OAuth, темы, сторонние сервисы. Не запускать
    inference-нагрузку для тестов: сначала offline, реальный loader/parser,
    детерминированные fixtures, property/fuzz и adversarial проверки.

## Проверка результата

- Ручные вычисления с известным объёмом и временем; weighted AVG для неодинаковых
  длительностей. CURRENT/AVG и reset/resume имеют проверяемые ожидаемые числа.
- Literal spike `222919.7`, одинаковые/sub-ms timestamps, buffered bursts,
  нормальная высокая/низкая скорость, длинные паузы и длинный reasoning.
- Инвариантность к разбиению содержимого на chunks там, где наблюдения дают
  одинаковые числитель и интервал; ограничения observability не скрываются.
- Duplicate/missing/out-of-order events, response/item/content ID mismatch,
  clocks rollback/NaN/Infinity, переполнение, failed provisional rollback.
- Реальный установленный Pi loader и Codex parser без сети; footer ширины 1–220.
- Независимая проверка изменений и запуск полного связанного regression suite.
- Canonical payload, strict hash guards, install/update/deploy проверены; после
  установки источники совпадают с canonical. Рабочие процессы не перезапускать.
- В итоговой документации явно разделить гарантии вычисления и пределы знания
  client-side метрик. Не обещать точный server TPS, если протокол его не даёт.

## Первичные источники, проверенные основным агентом

- OpenAI, Counting tokens:
  https://developers.openai.com/api/docs/guides/token-counting
  Usage output включает невидимые structural/tool/channel tokens даже при
  reasoning_tokens=0; фиксированную разницу с видимым текстом предполагать нельзя.
- NVIDIA AIPerf, Metrics Reference:
  https://docs.nvidia.com/aiperf/dev/reference/ai-perf-metrics-reference
  Отличает TTFT, first content chunk, chunk latency, token-normalized decode
  и E2E throughput. Отдельно описывает first-chunk correction для chunks,
  содержащих несколько токенов.

Эти источники не подтверждают сами по себе формат конкретного Codex subscription
потока и не задают наши UI-пороговые константы; протокол исследуется отдельно.
