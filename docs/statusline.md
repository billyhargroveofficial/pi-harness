# Статус-строка: как в Claude Code, но для DeepSeek

Задача: внизу pi должна быть **та же** строка, что рисует Claude Code — и тот же скрипт, без второй параллельной
строки от расширений. Позже добавились требования: без недельной квоты Codex (pi живёт на DeepSeek), с **реальным**
уровнем мышления вместо дефолта из настроек CC и с размером контекста в виде `1M`, а не `1000k`.

## Как устроено

- **`pi-statusline`** (0.0.2) — запускает внешнюю команду с CC-совместимым JSON на stdin
  (`model.display_name`, `workspace.current_dir`, `context_window.current_usage`, `pi.session_file`…) и печатает stdout в футере.
- **Тот же скрипт, что у Claude Code** — `~/.local/share/claude-codex-statusline/statusline.py` (`assets/statusline.py` в этой репе),
  с флагом `--no-quota`.

```json
"statusLine": {
  "type": "command",
  "command": "/usr/bin/python3 /Users/billy/.local/share/claude-codex-statusline/statusline.py --no-quota",
  "placement": "footer",
  "timeoutMs": 5000
}
```

## Что дописано в скрипте

| Что | Почему |
|---|---|
| `--no-quota` — не рисовать `● 7d N% …` и не поднимать фоновый `codex`-refresh | в pi квота Codex не нужна; без флага поведение прежнее (Claude Code) |
| Уровень мышления из `pi.session_file`: последняя запись `thinking_level_change` | в CC-нагрузке поля `effort.level` нет, и строка показывала `effortLevel` из `~/.claude/settings.json` — «medium» вместо реального `max` |
| Чтение головы (64 КБ) **и** хвоста (256 КБ) файла сессии | запись уровня есть и при старте сессии (в начале файла), и на каждое переключение (в хвосте) |
| Дефолт `defaultThinkingLevel` из `~/.pi/agent/settings.json` | свежая сессия (файла ещё нет) иначе падала в CC-настройки и показывала `medium` |
| `format_size`: ≥ 1 000 000 → `1M` | было `1000k` |

Строка в pi теперь: `📁 billy ● DeepSeek V4.1 Flash 1M max 331k`

## Патч pi-statusline

`patches/fix-pi-statusline-refresh.mjs` — расширение перерисовывало футер на `session_start` / `turn_end` /
`model_select` / `session_compact|tree|switch|fork`, но **не** на `thinking_level_select`, который pi шлёт при `shift+tab`.
Из-за этого уровень в строке обновлялся только к концу следующего хода. Патч добавляет подписку с тем же дебаунсом.

## Футер один

`better-claude-code-ui` тоже регистрирует футер (своя строка `model · cwd · ctx % · стоимость · время · turns`).
В pi футер один, поэтому патч `patches/fix-better-cc-ui-light-legibility.mjs` закомментировал `registerStatusLine(pi)`
в его `index.ts` — иначе строки рисовались по очереди и победитель зависел от порядка `requestRender()`.

## Проверка

Три тестовых payload'а (без pi, свежая сессия pi, сессия с уровнем) и живой pty-прогон:

| Проверка | Результат |
|---|---|
| payload CC (`--no-quota` не задан) | `📁 billy ● gpt-6-astra 272k medium 33k ● 7d 61% 6d 1h` — прежнее поведение |
| payload pi, свежая сессия | `📁 billy ● DeepSeek V4.1 Flash 1M max 0k` |
| payload pi + сессия с `thinkingLevel: low` | `… 1M low 1k` |
| pty, до `shift+tab` | `📁 billy ● DeepSeek V4.1 Flash 1M max 363k` |
| pty, после `shift+tab` | `📁 billy ● DeepSeek V4.1 Flash 1M off 363k` |

Последние две строки — сквозная проверка: уровень меняется хоткеем, скрипт читает его из файла сессии, патч заставляет
футер перерисоваться сразу.

## Что не мешает

- `pi-live-throughput` пишет метрики через `setWidget` (строка над редактором); его режим `/throughput status` (в футер)
  при кастомном футере не виден — так было и раньше.
- Квота Codex из pi не запрашивается вовсе (флаг `--no-quota` отключает и фоновый `codex app-server` RPC).
- Оба патча идемпотентны и применяются `install.sh`; после `pi update` — заново
  (`node ~/.pi/agent/patches/fix-pi-statusline-refresh.mjs`).
