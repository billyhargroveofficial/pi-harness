# Авто-тема light/dark и светлый вариант `claude-green`

Задача: pi должен сам переключаться между тёмной и светлой темой по системной теме macOS (как Ghostty с `theme = light:…,dark:…`), а не жить на фиксированной тёмной.

## Три причины, почему не работало

### 1. Тема была задана фиксированным именем

В `agent/settings.json` стояло `"theme": "claude-green"`. Авто-режим в pi включается только синтаксисом `светлая/тёмная`:

```json
{ "theme": "claude-green-light/claude-green" }
```

`parseAutoThemeSetting` / `resolveThemeSetting` (`dist/modes/interactive/theme/theme.js`) видят слэш и выбирают имя по текущей схеме терминала; одно имя = один фиксированный набор цветов, реакции на систему нет. Плюс `themeAdaptive: true` из `ext/settings.json` — это настройка **расширения** (цвета диффов/рамок), на саму тему pi она не влияет; отсюда ощущение «включил адаптивность, а ничего не меняется».

### 2. Chrome расширения осветлялся даже на светлой панели

`pi-claude-code-ui` берёт цвет рамок/подписей из `theme.dim`, аттенюирует его под светлую панель… и затем **всегда** осветляет на `+64` (`OUTLINE_CHROME_BRIGHTEN`):

$$ \text{dim} \; \#859289 \xrightarrow{+64} \#C5D2C9 \;(\text{на тёмном} \approx 11.8{:}1) \qquad \text{dim} \; \#9AA396 \xrightarrow{+64} \#D0D7CD \;(\text{на белом} \approx 1.5{:}1) $$

Подписи `Thought for Ns`, строки `Turn took …`, рамка юзер-сообщения и правила тулов на светлой теме становились почти невидимыми. Замер по скриншотам (PIL, самые тёмные пиксели строки): `#D1D7CE` — ровно старый chrome.

### 3. `stripBackgroundAnsi` ломал truecolor-последовательности

Настоящая причина «сероватого» текста в юзер-боксе. Функция разбирает SGR по отдельным параметрам и выбрасывает всё, что похоже на фон (`48`, `49`, `40–47`, `100–107`), но не учитывает, что у расширенных цветов свои аргументы:

$$ \texttt{\textbackslash x1b[38;2;92;106;114m} \; (\#5C6A72) \;\longrightarrow\; \texttt{\textbackslash x1b[38;2;92;114m} \;(\text{битая последовательность}) $$

Компонента `106` попала под «фон» и вылетела. Терминал рисует битую последовательность как попало — замер по скриншоту дал `#99B89A` вместо `#5C6A72`.

Масштаб: в светлой теме под это попадали 23 из 56 токенов — `muted`, `dim`, `success`, `mdLink`, `mdHeading`, `syntax*`, `thinking*` и производные. В тёмной — 7 (например `border #5C6B57`, `thinkingMinimal #5F6B58`, фоны панелей). После усиления `text` до `#4F5C62` (79;92;98) сам основной текст из-под бага вышел, но остальные токены — нет, поэтому чинить надо было парсер, а не палитру. Ошибка проявляется на любой линии, проходящей через `cleanUserMessageLine` → `stripBackgroundAnsi`.

## Что сделано

| Что | Где |
|---|---|
| Светлая пара к `claude-green` в той же палитре (Everforest Light), 56 токенов | `agent/themes/claude-green-light.json` |
| Авто-режим темы | `agent/settings.json`: `"theme": "claude-green-light/claude-green"` |
| Убран `diffTheme: "everforest-dark"` (он блокировал авто-выбор Shiki `github-light`/`github-dark`, см. `extensions.md`) | `ext/settings.json` |
| Патч 1: chrome на светлой панели тянется к `theme.text` вместо `+64` | `patches/fix-cc-tools-light-chrome.mjs` |
| Патч 2: `38`/`48`/`58` съедают свои аргументы; фоном считаются только самостоятельные `49`/`40–47`/`100–107` | там же |

Серые в светлой теме подтянуты к читаемым значениям (было / стало, контраст на белом):

| Токен | Было | Стало | Контраст |
|---|---|---|---|
| `text` | `#5C6A72` | `#4F5C62` | 5.6 → 6.9 |
| `muted` | `#7A8478` | `#5F6A63` | 3.9 → 5.6 |
| `dim` | `#9AA396` | `#647067` | 2.6 → 5.2 |

Для сравнения — тёмная тема: `text` 10.9, `muted` 7.6, `dim` 5.7. Светлая не может дать таких же цифр на белом, но ладдер сохраняется, а chrome после патча считается как `mix(dim, text, 0.45)` → `#5B6765` (≈ 6.3:1), то есть вровень с основным текстом — как в тёмной теме, где chrome ≈ text.

## Проверка (не «на глаз»)

**Патч воспроизводим.** Скрипт идемпотентен, и из чистого апстрима даёт файл в `node_modules` байт-в-байт:

```bash
npm pack pi-claude-code-ui@1.0.83 && tar xzf pi-claude-code-ui-1.0.83.tgz
mkdir -p /tmp/fakehome/.pi/agent/npm/node_modules/pi-claude-code-ui/extensions
cp package/extensions/index.ts /tmp/fakehome/.pi/agent/npm/node_modules/pi-claude-code-ui/extensions/
HOME=/tmp/fakehome node patches/fix-cc-tools-light-chrome.mjs
cmp /tmp/fakehome/.pi/agent/npm/node_modules/pi-claude-code-ui/extensions/index.ts \
    ~/.pi/agent/npm/node_modules/pi-claude-code-ui/extensions/index.ts   # совпадает
```

**Парсер SGR — юнит-тесты.** Функция вырезается из пропатченного файла и прогоняется на 11 кейсах: truecolor fg, 256-цвет, fg+bg в одной последовательности, standalone-фоны (`40/49/100/107`), стили и сброс. Все проходят; до патча три из них (любой цвет с компонентой 40–49/100–107) выдавали искажённый результат.

**Живой прогон в pty.** Копия реальной сессии открывается отдельным процессом pi (`--session /tmp/copy.jsonl`), чтобы не мешать рабочей; `COLORFGBG=0;15` даёт намёк «светлый фон», окно 50×200, захват ~11 с:

```bash
python3 - <<'PY'
import os, pty, subprocess, time, select, fcntl, termios, struct, signal
master, slave = pty.openpty()
fcntl.ioctl(master, termios.TIOCSWINSZ, struct.pack("HHHH", 50, 200, 0, 0))
env = dict(os.environ, COLORFGBG="0;15", TERM="xterm-256color")
p = subprocess.Popen(["pi", "--offline", "--session", "/tmp/copy.jsonl"],
                     stdin=slave, stdout=slave, stderr=slave, env=env,
                     preexec_fn=os.setsid)
os.close(slave)
buf, deadline = b"", time.time() + 11
while time.time() < deadline:
    r, _, _ = select.select([master], [], [], 0.5)
    if r:
        d = os.read(master, 1 << 20)
        if not d: break
        buf += d
open("/tmp/capture.bin", "wb").write(buf)
os.killpg(os.getpgid(p.pid), signal.SIGKILL)
PY
```

Что показал захват:

| Маркер в кадре | До патчей | После |
|---|---|---|
| битые `38;2;N;N m` | 1 (`38;2;92;114m`) | **0** |
| текст сообщения `#5C6A72` целый | 0 | 1 |
| chrome `#606D6C`/`#5B6765` (патч) | 0 | 6 |
| старый «выцветший» chrome `#D0D7CD` | есть | 0 |
| ошибки загрузки расширения | — | нет |

Плюс: авто-тема в этом прогоне выбралась светлая (`text #5C6A72` в кадре при тёмной теме был бы `#D3C6AA`), то есть связка `settings → detect → тема` работает целиком.

**Тема** валидируется собственным валидатором pi: 56 токенов, все переменные резолвятся, `loadThemeFromPath` в `truecolor` (см. `verification.md`).

## Грабли

- **Патч живёт в `patches/`, а не в репе расширения.** `pi update` переустановит `pi-claude-code-ui` и снесёт правки — `install.sh` применяет патчи заново, для ручного обновления: `node ~/.pi/agent/patches/fix-cc-tools-light-chrome.mjs` (симлинк на файл репы).
- **Код расширения читается при старте.** Правки темы подхватываются на лету (watcher на файл темы), патчи расширения — только после перезапуска pi.
- **Тёмная тема не тронута**, кроме случая `billy-aurora`: у него светлой пары нет, при переключении в авто-режиме он остаётся тёмным.
- Апстрим не уведомлён (в репе нет прав на их трекер) — оба бага стоит сообщить в `pi-cc-tools`, см. `backlog.md`.
