# Статус-строка Pi / Codex (7 октября 2026)

Один нижний футер, маленькие `·`, одинаковый серый цвет:

```text
📁 harness-space · GPT-6.1 Sol 272k high 221k · pi-patches · ~47.4 TPS hit 90.9% in 28.00M out 229k
```

Пример формата. Первые токены — текущий контекст, `in/out` — записанный расход
всей сессии. Скорость — guarded estimate, не server decode. Исследование причин
spikes и ограничений: [codex-throughput.md](codex-throughput.md).

## Компоненты

- `pi-statusline@0.0.2` запускает внешнюю команду с CC-совместимым JSON на stdin.
- `assets/statusline.py` → `~/.local/share/claude-codex-statusline/statusline.py`:
  папка, модель, окно контекста, реальный thinking, occupancy, имя сессии.
- `pi-live-throughput@0.3.0` + overlay v4 добавляет `~TPS hit … in … out …`
  через `FooterDataProvider.getExtensionStatuses()` без нового запуска Python
  на каждый output delta. Если поле не помещается — переносится, а не исчезает.
- `better-claude-code-ui` не ставит второй футер: это выключено патчем
  `fix-better-cc-ui-light-legibility.mjs`.

```json
"statusLine": {
  "type": "command",
  "command": "/usr/bin/python3 /Users/billy/.local/share/claude-codex-statusline/statusline.py --no-quota",
  "placement": "footer",
  "timeoutMs": 5000
}
```

## Источники полей и независимость Claude Code

| Поле / решение | Реализация |
|---|---|
| Реальный thinking | последняя `thinking_level_change` в `pi.session_file`; head 64 KB + tail 256 KB |
| Свежая сессия без файла | `defaultThinkingLevel` из Pi settings, затем payload/CC fallback |
| Размер контекста | `format_size`: ≥1M отображается в M, не тысячах k |
| Имя после `·` | последняя `session_info`, mmap-поиск с конца; очищенное имя исчезает |
| Разделители | payload Pi → `·`; CC → прежние `●`; UI нормализует legacy Pi bullets |
| `--no-quota` | скрывает квоту и отключает background `codex app-server` refresh; не меняет Codex auth |
| Claude Code | прежний renderer/quota/разделители; имени сессии Pi нет |

`fix-pi-statusline-refresh.mjs` подписывает refresh на `thinking_level_select`
(`Shift+Tab`) и `session_info_changed` (`/name`). `fix-pi-statusline-throughput.mjs`
прикладывает source UI overlay к нижнему футеру. Оба идемпотентны и применяются
установщиком/обновлением; неизвестный UI hash не перезаписывается.

## Офлайн-проверка

```bash
python3 tests/statusline-session-name.py
node tests/codex-throughput-extension.mjs
```

Проверяются имя далеко за head/tail, переименование, очистка, отсутствующий файл,
ограничение длины и неизменность CC. Integration-тест загружает настоящий Pi UI,
проверяет middle dots, серый цвет, dynamic throughput и widths 1–220, без сети
и новых inference requests. При панели уже одного слова возможно усечение слова.

После установки нужен `/reload`; после удаления старого провайдера/ключа лучше
полностью перезапустить Pi, чтобы выгрузить старое расширение и старое окружение.
