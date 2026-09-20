# Статус-строка: та же, что в Claude Code

Задача: в pi внизу должна быть **та же** строка, что рисует Claude Code, а не собственная строка расширения.
В CC у Billy статус-строка задана командой (`~/.claude/settings.json`):

```json
"statusLine": { "type": "command",
  "command": "/usr/bin/python3 /Users/billy/.local/share/claude-codex-statusline/statusline.py" }
```

Скрипт печатает одной строкой `📁 <папка> ● <модель> <контекст> <effort> <токены> ● 7d <квота> <до сброса>` — серым (`\e[38;5;8m`), квоту берёт из `codex` CLI
через кэш `~/.cache/claude-codex-statusline/weekly.json` (TTL 60 c).

## Решение: `pi-statusline`

Пакет `pi-statusline` (0.0.2) — единственное расширение из найденных, которое **запускает CC-скрипт как есть**:
шлёт ему на stdin CC-совместимый JSON (`model.display_name`, `workspace.current_dir`, `context_window.current_usage`, `cost`…)
и рендерит stdout в футере. Свой скрипт переписывать не пришлось.

Конфиг (в `agent/settings.json`, читается из `~/.pi/agent/settings.json`):

```json
"statusLine": {
  "type": "command",
  "command": "/usr/bin/python3 /Users/billy/.local/share/claude-codex-statusline/statusline.py",
  "placement": "footer",
  "timeoutMs": 5000
}
```

`placement: "footer"` — именно статус-строка (вариант `widget` рисует строку над редактором).

## Пришлось убрать вторую статус-строку

`better-claude-code-ui` тоже регистрирует футер (`ctx.ui.setFooter`) — свою CC-подобную строку
`model · cwd · ctx % · стоимость · время · turns`. Футер в pi **один**, поэтому два расширения дрались за него:
в захвате кадра обе строки рисовались по очереди, а победитель зависел от того, кто последним вызвал `requestRender()`.

Патч `patches/fix-better-cc-ui-light-legibility.mjs` (блок «status line owned by pi-statusline») закомментировал
`registerStatusLine(pi)` в `extension/index.ts`. Обратно включать, только если `pi-statusline` снят.

## Проверка (pty-захват)

Тот же метод, что в [`verification.md`](verification.md): отдельный процесс pi на копии сессии, `COLORFGBG=0;15`, окно 40×170.

| Маркер в кадре | До | После |
|---|---|---|
| `📁 … ● … 7d …` (строка скрипта) | нет | **да** |
| `deepseek-flash · ~ · ctx 6% · … · 2 turns` (строка cc-ui) | да | **нет** |
| цвет строки | — | `38;5;8` (тот же серый, что в CC) |

Реальный кадр:

```
📁 billy ● DeepSeek V4.1 Flash 1000k medium 58k ● 7d 60% 6d 2h ~
```

Поля совпадают с CC: папка, модель (из pi — имя модели), размер контекста, effort (из `~/.claude/settings.json`,
как в скрипте), занятые токены, недельная квота Codex и время до сброса. `~` в конце — признак устаревшего кэша квоты
(`stale`), как и в CC.

## Что не мешает

- `pi-live-throughput` пишет метрики через `setWidget` (строка над редактором) и `setStatus`; виджет от смены футера не страдает.
  Режим `/throughput status` (в футер) при кастомном футере не виден — так было и раньше, пока футер занимал cc-ui.
- Квота обновляется тем же путём, что в CC: скрипт сам поднимает фоновый `--refresh`, ошибки кэшируются и помечаются `~`.
