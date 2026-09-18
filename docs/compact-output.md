# Компактный вывод: что сделано и замеры

Цель — чтобы свёрнутый тул-колл занимал минимум строк, как в Claude Code, а полный вывод открывался явным действием (`Ctrl+O`).

## Что было не так

Дефолты `pi-claude-code-ui` оставляли в свёрнутой строке хвост вывода команды (`liveToolPreview`) и до 8 строк превью для `read`/`grep`/`mcp` (`previewLines`), плюс до 8 строк исходника команды (`bashCommandPreviewLines`). Визуально это выглядело так:

```
● Bash ls -la ~/.pi/agent/ ... ; for f in ~/.pi/agent/conf…
└ Done (58 lines) • ctrl+o to toggle
        ]
      }
    }
  }
  Command exited with code 1
```

## Что стало (текущий конфиг)

```json
{ "previewLines": 1, "bashCollapsedLines": 2, "bashCommandPreviewLines": 0,
  "liveToolPreview": false, "diffCollapsedLines": 8 }
```

```
● Bash ls -la ~/.pi/agent/ ... ; for f in ~/.pi/agent/conf…
└ Done (58 lines) • ctrl+o to toggle
```

Плюс `toolBackground: "transparent"` — убирает горизонтальные правила вокруг тул-строк.

## Замеры

Метод: реплей одной и той же реальной сессии (`--tui-mode regular`, без сети и модели, в pty), подсчёт отрисованных строк и строк вывода под строками `Done (N lines)`.

| Конфиг | Всего строк транскрипта | Сумма строк вывода под bash-строками | Медиана на строку |
|---|---|---|---|
| дефолт (8 / 10 / 8 / 5) | 1653 | 366 | 5 |
| промежуточный (3 / 3 / 2 / 2) | 1457 | 194 | 2 |
| финальный (1 / 2 / 0 / off) | **1263 (−24 %)** | **0** | **0** |

Порядок значений: `previewLines` / `bashCollapsedLines` / `bashCommandPreviewLines` / `liveToolPreviewLines`. В финальном варианте `liveToolPreview: false`.

Отдельный A/B по `toolBackground` на том же реплее: количество символов `─` в кадре 2025 → 1865 (уходят правила вокруг тулов), рамки юзер-сообщений и коннекторы остаются — они захардкожены.

## Скрытие thinking

`~/.pi/agent/settings.json`:

```json
{ "defaultThinkingLevel": "max", "hideThinkingBlock": true }
```

и в `~/.pi/settings.json`: `"thinkingMode": "full"`.

Почему оба: `hideThinkingBlock` — настройка pi (блоки не рендерятся), но дефолтный `thinkingMode: "live"` расширения принудительно ставит `hideThinkingBlock = false` на время стрима, показывая содержимое. `"full"` это отключает: во время размышления видна одна строка `Thinking…`, после — `Thought for Ns`.

Проверка на реплее сессии с 5 thinking-блоками: отрисовано ровно 5 строк `Thought for`, утечек текста размышлений — 0 (фрагменты ≥40 символов из каждого блока искались в выводе).

## Что осталось не-Claude-Code

Захардкожено в `pi-claude-code-ui`, настройками не убирается:

1. рамка-бокс вокруг юзер-сообщения (`roundedUserBorder`) — в CC это `> prompt`;
2. группировка вызовов рисуется деревом `├ └ │` вместо буллета `⏺` с отступом `⎿`;
3. форма веток не настраивается — только цвет (`toolBranchColorMode`).

Штатного способа это убрать нет. Свой код для этого не пишем (принцип харнесса — только готовые расширения), поэтому либо найдётся готовое расширение/тема/настройка, либо остаётся как есть. Патч файла в `node_modules` тоже отпадает: 7.5k строк апстрима и перезапись при `pi update`.
