# Задача: LIVE + средняя скорость наблюдаемого потока

Billy, 7 октября 2026. Предыдущая версия c6faee7: LIVE/reference и native effective
request AVG. После живых примеров `~34.4 ~12.9 TPS` и `~37.1 ~20.5 TPS` Billy
утвердил **изменение контракта**, затем попросил commit/push/deploy на Mac и у брата.

## Текущее решение

- Первое число — прежний rolling LIVE reference-BPE o200k_base.
- Второе — AVG того же видимого text/tool-input потока: сумма целых prefix
  differences / сумма first→last непустых content intervals завершённых ответов.
- TTFT, terminal tail, user idle и внешние tools между запросами не входят.
  Внутренние паузы между content chunks входят; быстрые/медленные TPS не цензурируем.
- Первый atomic prefix исключается вместе с его ненаблюдавшимся временем.
  First baseline AVG постоянен и не теряется при pruning rolling LIVE samples.
- Empty/reasoning-only, one-shot, same-time и интервал <1s — явное unmeasured;
  не делим native totals на короткий видимый хвост, не придумываем скорость.
  AVG относится к измеримым интервалам, не всей исторической сессии.
- Native usage **не влияет на оба TPS**, остаётся отдельно в `hit/in/out`.
  Hidden reasoning включён в native `out`, но не в видимые LIVE/AVG.
- Нет mean-of-means, EMA, caps, подгонки к ожидаемым цифрам или chars/4.
- Новый durable metric/namespace, новая эпоха после reload: старые native request
  intervals не выдаются за stream intervals и не удаляются из истории.
- Reset LIVE не уничтожает ongoing prefix/time AVG. Reset AVG изолирует inflight
  ответ до следующего pre-request, включая deferred WS message_start.
- Финальное содержимое проверяется после saved-message replacement handlers.
  Отдельный неизвестный/прерванный ответ — coverage gap, не запрет всей AVG.
  Проверенные измерения сохраняются и после abort/Esc/reload/crash; `/throughput info`
  показывает gaps/unmeasured/pending. Повреждение числовых records fail closed.
  Crash/duplicates/fork/model/tree безопасны.
- UI: `~32.2 ~45.5 TPS`, один suffix, без новых подписей. Footer/theme/OAuth и
  native session usage не менять; inference/перезапуск сервисов не нужен.

## Реализация и проверки

Canonical `patches/pi-live-throughput/`; guarded feature deployment
`assets/deploy-tps-speedometer.sh`. c6faee7/51868d0 разрешены как предшественники;
runtime/overlay/canonical copies меняются одной rollback-транзакцией.

Тесты: 103 unit/math/controller + 600 replays, 8 независимых oracle, 15 real
footer/loader guards, 38 real SessionManager stream lifecycle, 17 subscription
SSE/WS transport, 46 TEMP-only deploy/rollback checks. Дополнительные preserved
регрессии: native in/out, statusline, portable config, Codex-only, compact tools,
subagents updater/live tools, session manager и Orca Math.

Контракт/ограничения: `docs/codex-throughput.md`. Исторический исследовательский
workflow и первоначальное решение сохранены в `docs/codex-tps-speedometer-audit.md`.
Они не означают, что новая версия использует native AVG.
