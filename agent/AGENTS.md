# Pi для Billy

Отвечай по-русски, кратко и связно. Выполняй авторизованную задачу до проверенного результата.

Используй hosted web_search Codex через pi-openai-toolkit для свежей информации и просьб найти или проверить; давай прямые ссылки на источники. Формулы записывай отдельными блоками $$ ... $$ — pi-math рисует их картинками через Kitty-протокол в Orca; сохраняй исходный LaTeX для других терминалов.

Для авторизованных сайтов и браузерных действий используй Playwriter с Chrome Shared; сначала прочитай ~/.agents/skills/playwriter/SKILL.md. При необходимости запускай Chrome Shared через ~/.local/bin/chrome-shared-cdp start (с --activate, если пользователь просит показать окно). После завершения задачи не останавливай Chrome Shared: оставляй браузер запущенным и закрывай только свои временные вкладки и сессии Playwriter. Останавливай Chrome Shared лишь по прямой просьбе пользователя.

По умолчанию работай одним основным агентом. Когда пользователь просит субагентов,
делегирование или workflow, используй установленный @tintinweb/pi-subagents:
Agent для отдельных задач и SubagentWorkflow для оркестрации. Для веб-исследования
есть роль web-researcher; general-purpose выполняет общие задачи, Explore исследует
код, Plan составляет план. Все эти роли используют openai-codex/gpt-6.1-sol и
hosted web_search через pi-openai-toolkit. Не включай isolated: true у задач, которым нужен вебпоиск:
этот режим отключает расширения. Для параллельных правок в Git при необходимости
используй отдельную настройку isolation: worktree.

Не устанавливай dynamic-workflow и watcher. Не отправляй внешние сообщения без
прямой просьбы. Не записывай память без прямой просьбы.

## Брат SSH — хост `flyingkuskus`, его папка `/home/flyingkuskus`

Машина брата — Arch Linux x86_64; хост и пользователь `flyingkuskus`, проекты в `/home/flyingkuskus`.

Основной проверенный 7 октября 2026 доступ — **`ssh brother-direct`** (синоним `brother-chisel`). Алиас подключается к `127.0.0.1:2222` на Mac, использует `~/.ssh/id_ed25519`, `HostKeyAlias flyingkuskus.taileaee11.ts.net` и `StrictHostKeyChecking yes`. Проверку ключей не отключать.

Канал: Chisel на Arch → `https://billyhargrove.ru/_brother-ssh` → Caddy на Mac → Chisel-server `127.0.0.1:18081`. Обратный listener — только `127.0.0.1:2222`, цель — `127.0.0.1:22` на Arch; не публиковать SSH на всех интерфейсах. Mac LaunchAgent — `ru.billyhargrove.brother-tunnel`; Arch service — `brother-tunnel.service`. Приватные инструкции Mac — `~/.config/brother-tunnel/README.md`, секрет Arch — `/etc/brother-tunnel/client.env`. AUTH, пароли и приватные ключи в отчёты/репозиторий не копировать. Pi/Orca/Node gateway/Caddy ради обновления харнесса не перезапускать.

Доступ требует включённых компьютеров и работающей сети; не обещать безусловный uptime. Братскую тему `terracotta-local-*`, OAuth, личные настройки и symlink `~/.pi/agent/AGENTS.md` → `~/.codex/AGENTS.md` сохранять; обновления харнесса выполнять точечно, не запускать полный установщик поверх его конфигурации.

Резерв — **`ssh brother`**, прежний Tailscale Funnel TLS :443 через `openssl s_client`; не удалять и не подменять. Брат в `taileaee11.ts.net`, Mac Billy в `tail856bc0.ts.net`; Tailscale-IP брата `100.92.120.101`. Прямой SSH между tailnet ранее зависал на banner exchange; причина не установлена. Funnel-адреса: `https://flyingkuskus.taileaee11.ts.net:8443` и `:10000`.
