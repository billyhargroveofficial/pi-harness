# Claude Code status line

Matches the gray, non-bold, folder/model/effort/token/weekly layout of cship-wrap on billy@192.168.1.15. Remote configuration is unchanged. Local implementation uses Python 3 without external packages.

Example: 📁 project ● GPT-6 Astra 272k medium 43k ● 7d 45% 6d 15h

The percentage is USED weekly Codex quota; countdown is time until reset. Only rateLimitsByLimitId.codex and windowDurationMins=10080 are accepted. No Claude quota, Spark quota or five-hour quota is rendered. The last token figure is current context input including cache, not lifetime cumulative input. Before the first response it is —k.

Quota comes from the local Codex app-server account/rateLimits/read RPC, with no inference request. A single short-lived subprocess refreshes a private cache at most once per minute on status redraw. A file lock prevents concurrent RPC refreshes. Every process has a bounded timeout and cleanup. No persistent service, watcher or timer was installed. Initial rendering does not wait for network. On errors the previous quota is marked ~; after its reset timestamp it is hidden as —. Missing quota is —, never zero.

Files:
- Renderer: ~/.local/share/claude-codex-statusline/statusline.py
- Quota cache: ~/.cache/claude-codex-statusline/weekly.json
- Status command: statusLine in ~/.claude/settings.json
- Settings backup: ~/.claude/settings.json.backup-statusline-20260919-194746

Verified: live weekly RPC (45% used), weekly-versus-five-hour/Spark filtering, current context sum, live effort input, absent/expired/stale quota, and actual Claude Code TUI rendering at startup.

## pi (флаги)

Тот же скрипт используется статус-строкой pi (`pi-statusline`, настройка `statusLine` в `~/.pi/agent/settings.json`).

```json
"statusLine": { "type": "command",
  "command": "/usr/bin/python3 /Users/billy/.local/share/claude-codex-statusline/statusline.py --no-quota" }
```

- `--no-quota` — не рисовать недельную квоту Codex и не поднимать фоновый refresh (pi живёт на DeepSeek, квота Codex там не нужна). Без флага поведение прежнее, для Claude Code.
- **Уровень мышления** берётся из сессии pi: `pi.session_file` → последняя запись `thinking_level_change` (`thinkingLevel`). Для свежей сессии дефолт из `~/.pi/agent/settings.json` (`defaultThinkingLevel`). Только если ничего из этого нет — падает в `effort.level` нагрузки и настройки Claude Code.
  Записи уровня лежат и в начале файла сессии (старт), и в хвосте (переключения), поэтому читаются и голова (64 КБ), и хвост (256 КБ).
- **Размер контекста** печатается как `1M` при ≥ 1 000 000 (было `1000k`).
- Живое обновление уровня после `shift+tab` обеспечивает патч `patches/fix-pi-statusline-refresh.mjs`
  (pi-statusline не слушал событие `thinking_level_select` и перерисовывался только на границе хода).

Пример строки в pi: `📁 billy ● DeepSeek V4.1 Flash 1M max 331k`
