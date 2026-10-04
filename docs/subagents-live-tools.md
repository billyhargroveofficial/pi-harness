# Live tool calls в workflow

Проверено 4 октября 2026 на установленном `@tintinweb/pi-subagents` 0.19.0 и Pi 1.0.2.

## Баг

Агенты на `openai-codex/gpt-6.1-sol` выполняли инструменты, но панель
`/agents → Workflows → агент → Activity` писала `No tool calls yet`.
`workflow/host.ts` отдавал `record.toolUses` лишь после `spawnAndWait`,
а `runtime.ts` переносил его в progress лишь при завершении агента.
Это не зависание модели и не отсутствие инструментов.

## Фикс

`patches/fix-subagents-live-tools.mjs` + одноимённый `.patch` добавляют:

- отдельный live `onProgress` в контракт между host и runtime;
- подписку на события дочерней сессии до запуска запроса, включая resume;
- `Running: bash, read` и историю последних шести завершённых инструментов;
- счётчик завершённых tool calls, обновляемый до завершения агента;
- отписку в `finally`, сброс при retry и защиту от поздних событий старой попытки;
- record/model для resume **до** поступления его live-событий.

В progress сохраняются только имена инструментов и счётчик: аргументы, stdout,
результаты и секреты туда не копируются. Полная переписка остаётся под клавишей `c`.
Обычный `Agent` не изменён. Счётчик включает вызовы с ошибкой, как у штатного manager.

## Обновления без форка

Пакет по-прежнему ставится из npm апстрима, не из нашего форка и не из vendored-копии.
Для него снят `@0.19.0` в настройках; остальные версии не менялись.

```bash
cd ~/repos/pi-harness
./update.sh                         # pi update --extensions + повторное применение патчей + тесты
./update.sh --all                   # вместе с обновлением самого Pi
./update.sh npm:@tintinweb/pi-subagents   # обновить только этот пакет + повторно применить патчи
```

Установщик и updater копируют рядом со скриптом и `.patch`.
Если обновлял обычным `pi update`, переустановил пакет или npm затёр `node_modules`:

```bash
node ~/.pi/agent/patches/fix-subagents-live-tools.mjs
node ~/repos/pi-harness/tests/subagents-live-tools.mjs
```

После патча нужен `/reload` или перезапуск Pi; уже работающие сессии/агенты не
переподменяются на лету.

### Совместимость и откат

Патчер сначала проверяет **все** контексты через `git apply --check`; только после
успешной проверки пишет файлы. Повторный запуск распознаёт уже применённый патч.
Совместимое изменение версии само по себе не мешает применению — важен исходный код.
Если контексты апстрима поменялись, патчер завершится с ошибкой **без записи**.
`update.sh` сообщит, что обновление выполнено, но overlay требует проверки.

Это намеренно fail-closed, а не обещание совместимости с неизвестными будущими
версиями. Если апстрим закроет баг, проверить его live-поведение и убрать нашу пару
`fix-subagents-live-tools.mjs` / `.patch` из репы и `~/.pi/agent/patches/`;
не считать само наличие похожего `onProgress` доказательством исправления.

```bash
node ~/.pi/agent/patches/fix-subagents-live-tools.mjs --check   # проверка без записи
node ~/.pi/agent/patches/fix-subagents-live-tools.mjs --revert  # строгий откат наших блоков
```

`--target=/abs/path/to/package` позволяет проверять чистую копию npm-пакета.
`PI_CODING_AGENT_DIR` / `PI_AGENT_DIR` поддерживаются патчером.

## Проверки

```bash
node tests/subagents-live-tools.mjs           # офлайн, без API/моделей
node tests/subagents-update.mjs               # updater на изолированной копии с fake pi
PI_OFFLINE=1 node tests/subagents-live-tools.mjs --live   # явно платный/квотный Codex-тест
```

Офлайн проверены:

- live-события до settle, два параллельных инструмента с одинаковым именем;
- ограничение истории, отсутствие аргументов/секретов в progress;
- реальные host/runtime/dialog модули, spawn/resume, отписка при успехе и ошибке;
- retry: сброс activity и игнорирование поздних событий предыдущей попытки;
- рендер на ширинах 20/40/80/160, отсутствие ложного placeholder при live activity;
- после остановки `Last active`, а не ложное `Running`;
- снятие/reinstall/reapply, идемпотентность, dry run, откат;
- изменённый upstream-контекст: отказ без частичных правок других файлов;
- updater: переустановка, копирование payload, передача CLI-флагов, тесты и отказ при drift;
- чистый `npm pack @tintinweb/pi-subagents@0.19.0` + патч воспроизводят все пять изменённых
  файлов установленного пакета байт-в-байт.

Живой SDK-тест использует реальный AgentManager + WorkflowHost + runtime:
два параллельных Codex-агента (`bash`, затем `read`) и resume первого (`bash`).
Каждый live-progress проверен против `record.status === 'running'`.
Получено: пять завершённых tool calls; все появились до settle, ответы `LIVE_OK`
и `RESUME_OK`. Тест не пишет файлы и использует in-memory сессии.

Снимок фактического вывода:

```text
LIVE a 0: Running: bash
LIVE a 1: Recent: bash
LIVE a 1: Running: read | Recent: bash
LIVE a 2: Recent: bash → read
LIVE a 2: Running: bash          # resume; счётчик не теряется
LIVE a 3: Recent: bash
PASS: real Codex parallel + resume, live Activity verified BEFORE completion
```
