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

## Брат — хост `flyingkuskus`, его папка `/home/flyingkuskus`

Машина брата — Arch Linux, хост `flyingkuskus`, пользователь `flyingkuskus`; его файлы и проекты лежат в `/home/flyingkuskus`. Он в своём tailnet `taileaee11.ts.net` (аккаунт `morphinethings@`), Mac Billy — в другом (`tail856bc0.ts.net`), поэтому прямой `ssh flyingkuskus@flyingkuskus.taileaee11.ts.net` по Tailscale висит на banner exchange. Рабочий проверенный путь — алиас `ssh brother` в `~/.ssh/config`: Tailscale Funnel TLS на :443 через `openssl s_client`, host key уже в `known_hosts`; `scp`/`sftp` через тот же алиас работают. Адрес внутри его tailnet — `100.92.120.101`; снаружи открыты Funnel `https://flyingkuskus.taileaee11.ts.net:8443` и `:10000`.
