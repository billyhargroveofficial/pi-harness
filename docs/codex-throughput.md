# Codex TPS: LIVE и средний наблюдаемый поток (7 октября 2026)

## Что показывают два числа

```text
~32.2 ~45.5 TPS hit 90.9% in 28.00M out 229k
```

Это пример формата, не результат запроса к модели.

1. **LIVE** — приблизительная скорость доставки видимого текста и tool input
   за последнее наблюдаемое окно около трёх секунд.
2. **AVG** — средняя скорость этого же наблюдаемого потока за измеренную часть
   сессии: сумма reference-токенов / сумма интервалов доставки ответов.

Оба используют закреплённый reference-BPE **o200k_base**, НЕ установленную native
mapping GPT-6. Это клиентская доставка, не точная серверная скорость decode.
Native usage не масштабирует ни одно число. **Hidden reasoning не входит в TPS**.
`hit/in/out` по-прежнему используют native usage; `out` включает reasoning.

Billy явно изменил первоначальный контракт LIVE/native effective request AVG,
увидев `~34.4 ~12.9 TPS` и аналогичное расхождение в другой сессии. Старые 12.9
получались из 65 native токенов / 5.0225 секунды всего запроса, включая ожидание.
Арифметика была верна, но метрика не отвечала запросу на среднюю скорость потока.
Новая версия не «подгоняет» числа: меняет и числитель, и его совместимый интервал.

## LIVE — прежняя схема, без изменения скорости

- Encode целых накопленных logical text/tool parts, не отдельных chunks.
  Кириллица, CJK, emoji, JSON и special-looking строки — обычное содержимое.
  Неизменившиеся parts кешируются; checkpoint примерно раз в 200 ms.
- Первый атомарный chunk — untimed baseline. Его prefix count и ненаблюдавшееся
  время исключены согласованно. Нет плавающего 50-ms первого bucket.
- LIVE — разница prefix counts / время наблюдаемого rolling window около 3 s.
  Слева сохранена реальная точка at/before cutoff; timestamps не интерполируются.
- Разрешение наблюдения — минимум 1 s. Нет TPS caps, minChars/minBuckets,
  burstShare gate, EMA или winsorization. Измеренный ноль остаётся нулём.
- Перетокенизация suffix может уменьшить prefix count. Signed изменения входят
  в итоговую разность; отрицательный итог неизвестен, не clamp.
- Таймер увеличивает длительность активного LIVE, не создаёт токены; в тишине
  скорость затухает до нуля. Idle/warmup fallback — последнее final-saved
  валидное значение (**LAST**), а не новая мгновенная скорость.

## AVG — отдельный whole-response накопитель

Для каждого окончательно сохранённого валидного ответа:

- Начало интервала — **первый непустой raw text/tool-input delta**.
- Конец — **последний непустой raw delta**, не timer, done, terminal или SDK save.
- Числитель — final accumulated reference-prefix count минус prefix count первого
  атомарного delta. Первую порцию нельзя приписывать ненаблюдавшемуся времени.
- В знаменатель НЕ входят ожидание до первого текста, задержка terminal после
  последнего текста, user idle и внешние tools между запросами.
- Паузы **между** первым и последним content callback остаются частью измеренной
  доставки; не вырезаются для получения более красивой скорости.
- AVG = `ΣreferenceTokens × 1000 / ΣstreamElapsedMs`, не среднее LIVE/окон/скоростей
  ответов. `100/1s + 100/10s` даёт **200/11**, не 55.
- Пока новый ответ не сохранён, AVG завершённых измерений не разбавляется временем
  активного запроса. LIVE и AVG имеют независимые baseline/history/reset.
- Однопорционный, same-time, пустой/reasoning-only или доставленный менее чем за
  1 s ответ записывается как **unmeasured**: не прибавляет ни токены, ни время,
  не выдумывает нулевую/огромную скорость и не снижает прежний AVG ожиданием.
  Значит это AVG **измеримых потоковых интервалов**, не всех ответов за всю историю.
- Новый retry response получает свой prefix/первую границу. Отброшенные retry
  prefixes не считаются финально сохранённым текстом; retry waiting не входит.

Минимум 1 s — та же разрешающая способность, что у LIVE, а не порог по скорости.
Чистую серверную TPS, скорость hidden reasoning и длительность первой порции
клиентский поток не раскрывает. Не обещаем инвариантность к delivery buffering:
при изменении первых/последних наблюдаемых chunks меняется доступный интервал.

## Валидация и неизвестное покрытие

Проверяются response/item/content identity, sequence, UTF-16 hashes, tool
ID/name/namespace и semantic arguments/input. Freeze в `message_end`; commit
только по `turn_end.messageEntryId/getEntry` после всех replacement handlers.
Замена сохранённого текста/tool call не может подтвердить AVG другого содержимого.

Ошибки корреляции/clock, missing runtime, превышение RAM-предела 256 Ki UTF-16
units, unsupported/failed/incomplete output или неполная saved boundary дают
**unknown конкретного ответа**. Это явный coverage gap, не нулевой numerator,
не выдуманная длительность и **не запрет AVG всех остальных валидных интервалов**.
Abort/Esc или crash gap не могут навсегда отравить всю эпоху. AVG остаётся средним
проверенных интервалов, а не обещанием полного покрытия; `/throughput info`
показывает counts measured/unmeasured/gaps/pending. При отсутствии измерений — `-`.

Повреждённые числовые records, missing-start observations, конфликтующие duplicates,
переполнение и непроверенная запись после I/O failure по-прежнему fail closed — `-`.
Пустое корректно завершённое untimed output — отдельный unmeasured. Content только
в RAM и очищается после freeze/закрытия операции.

## Сессия, миграция и команды

Используется НОВЫЙ namespace `pi-harness:codex-stream-throughput` и metric
`reference-stream-delivery`. **Старые native AVG records не пересчитываются**:
из них нельзя восстановить первый/последний content timestamp. Они сохраняются
в истории, но игнорируются новым счётчиком. Первый переход с native-версии через
`/reload` создаёт stream эпоху; последующие reload восстанавливают её измерения.

`pi.appendEntry` хранит version/metric/epoch, start/observation/unmeasured/unknown,
own origin, hashed operation/response, actual provider/api/model, `tokens` и
`elapsedMs`. Нет текста, prompt, token IDs, credentials, raw events или absolute
monotonic timestamps. Custom records не входят в контекст модели.

Reload/resume/tree/compaction восстанавливают измеренные own-session branches
и модели; foreign inherited fork/child записи не смешиваются. Unclosed start
после crash → coverage gap; существующие валидные суммы сохраняются. Конфликт
числовых duplicates → AVG `-`; replay marker не отменяет reset. Прежние unknown
records тоже восстанавливаются как gaps, без reset/перезаписи истории.

```text
/throughput on|off|widget|status
/throughput info        # measured/unmeasured/gaps/pending; не переключает UI
/throughput reset       # только LIVE; ongoing AVG prefix и native in/out сохранены
/throughput reset-avg   # новая эпоха stream AVG
/throughput reset-all   # LIVE + новая эпоха stream AVG; native usage сохранён
```

AVG reset отбрасывает уже начатый ответ, включая поздний SDK start после WS
created. Следующий реальный pre-request разрешает новые измерения. Для обычных
прерываний reset больше не нужен; новую эпоху можно начать вручную, например
после повреждения records. Пропущенное время не восстанавливается.
Вне Codex — `- - TPS`. Footer/status/widget, цвет и переносы не меняются.

## Установка и проверка

Dedicated `<agentDir>/tps-runtime`, `gpt-tokenizer@4.0.0`, pinned manifest/lock,
`npm ci --ignore-scripts`. Resolver не допускает parent fallback/symlink escape.

```bash
node tests/codex-throughput.mjs
node tests/codex-throughput-oracles.mjs
node tests/codex-throughput-extension.mjs
node tests/codex-throughput-native-session.mjs # имя историческое; тестирует stream AVG
node tests/codex-throughput-transport.mjs
node tests/codex-throughput-deploy.mjs
./assets/deploy-tps-speedometer.sh
```

Guarded feature-only deploy обновляет runtime/source/canonical copies одной
транзакцией с rollback, всеми installed-byte acceptance suites и real-loader
smoke. Принимает проверенные предшественники c6faee7/51868d0, не неизвестные local edits.
Не меняет models/settings/OAuth/тему/statusline.py, не обновляет Pi/npm extensions,
не перезапускает процессы. Действующая Pi подхватывает код через `/reload`.

227 проверок + 600 mathematical schedule replays: actual Pi loader, runner,
SessionManager/AgentSession final-save boundary, SSE parser и native WS queue,
first/last/timers, weighted AVG, migration/crash/reset/fork, reference BPE,
footer widths 1–220 и deployment rollback. Fixtures — без inference/auth.

Исторический аудит: `docs/codex-tps-speedometer-audit.md`; текущая задача:
`docs/codex-tps-speedometer-task.md`; результаты: `docs/verification.md`.
