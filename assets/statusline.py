#!/usr/bin/env python3
"""Gray Claude status line with the actual Codex weekly quota only."""
import datetime
import fcntl
import json
import math
import os
from pathlib import Path
import queue
import re
import subprocess
import sys
import threading
import time

ROOT = Path.home() / '.cache/claude-codex-statusline'
CACHE = ROOT / 'weekly.json'
LOCK = ROOT / 'refresh.lock'
CLI = Path.home() / '.local/bin/codex'
TTL = 60

# pi пишет уровень thinking в файл сессии (запись thinking_level_change) — это
# единственный источник реального значения: в CC-нагрузке поля effort.level нет,
# из-за чего строка показывала уровень из ~/.claude/settings.json (medium).
SESSION_TAIL_BYTES = 256 * 1024
SESSION_HEAD_BYTES = 64 * 1024


def read_json(path):
    try:
        return json.loads(path.read_text())
    except (OSError, ValueError):
        return {}


def weekly(result):
    bucket = (result.get('rateLimitsByLimitId') or {}).get('codex')
    if not bucket:
        bucket = result.get('rateLimits') or {}
        if bucket.get('limitId') != 'codex':
            raise ValueError('No confirmed Codex quota')
    for name in ('primary', 'secondary'):
        window = bucket.get(name) or {}
        if window.get('windowDurationMins') != 10080:
            continue
        used, reset = window.get('usedPercent'), window.get('resetsAt')
        if (type(used) not in (float, int) or not math.isfinite(used)
                or not 0 <= used <= 100 or type(reset) not in (float, int)
                or not math.isfinite(reset) or reset <= 0):
            raise ValueError('Invalid weekly quota')
        return {'used_percent': used, 'resets_at': reset, 'limit_id': 'codex',
                'window_minutes': 10080, 'checked_at': time.time()}
    raise ValueError('No seven-day Codex window')


def refresh():
    ROOT.mkdir(parents=True, exist_ok=True, mode=0o700)
    with LOCK.open('a') as lock:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            return
        old = read_json(CACHE)
        if time.time() - old.get('attempted_at', 0) < TTL:
            return
        proc = None
        try:
            proc = subprocess.Popen([str(CLI), 'app-server', '--stdio'],
                stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                stderr=subprocess.DEVNULL, text=True, bufsize=1)
            messages = queue.Queue()
            def read():
                for line in proc.stdout:
                    try:
                        messages.put(json.loads(line))
                    except ValueError:
                        pass
                messages.put({'eof': True})
            threading.Thread(target=read, daemon=True).start()
            deadline = time.monotonic() + 12
            def send(data):
                proc.stdin.write(json.dumps(data) + '\n')
                proc.stdin.flush()
            def call(seq, method, params=None):
                request = {'id': seq, 'method': method}
                if params is not None:
                    request['params'] = params
                send(request)
                while True:
                    left = deadline - time.monotonic()
                    if left <= 0:
                        raise TimeoutError('Codex quota timeout')
                    msg = messages.get(timeout=left)
                    if msg.get('eof'):
                        raise RuntimeError('Codex app-server exited')
                    if msg.get('id') == seq:
                        if 'error' in msg:
                            raise RuntimeError('Codex quota RPC failed')
                        return msg['result']
            call(1, 'initialize', {'clientInfo': {'name': 'claude_statusline',
                 'version': '1.0'}, 'capabilities': None})
            send({'method': 'initialized'})
            data = weekly(call(2, 'account/rateLimits/read'))
        except Exception as exc:
            data = dict(old)
            data['error'] = type(exc).__name__
        finally:
            if proc is not None:
                if proc.poll() is None:
                    proc.terminate()
                    try:
                        proc.wait(timeout=2)
                    except subprocess.TimeoutExpired:
                        proc.kill()
                        proc.wait()
                proc.stdin.close()
                proc.stdout.close()
        data['attempted_at'] = time.time()
        temp = CACHE.with_suffix('.tmp')
        temp.write_text(json.dumps(data) + '\n')
        temp.chmod(0o600)
        temp.replace(CACHE)


def clean(value):
    return re.sub(r'[\x00-\x1f\x7f-\x9f]', '', str(value))


def format_size(size):
    """Размер контекста: 272000 → '272k', 1000000 → '1M'."""
    if size >= 1_000_000:
        millions = size / 1_000_000
        text = f'{millions:.0f}' if abs(millions - round(millions)) < 0.05 else f'{millions:.1f}'
        return f'{text}M'
    return f'{int(size / 1000)}k'


def pi_default_thinking_level():
    """Дефолт pi для совсем свежей сессии: settings.json → defaultThinkingLevel."""
    settings = read_json(Path.home() / '.pi/agent/settings.json')
    level = settings.get('defaultThinkingLevel')
    return level if isinstance(level, str) and level else None


def pi_thinking_level(data):
    """Живой уровень thinking из сессии pi.

    Запись thinking_level_change пишется и при старте (в начале файла), и на каждое
    переключение (в хвосте), поэтому смотрим голову и хвост и берём последнее
    найденное значение.
    """
    session = ((data.get('pi') or {}).get('session_file')) or ''
    if not session:
        return None
    try:
        size = os.path.getsize(session)
        with open(session, 'rb') as handle:
            if size <= SESSION_TAIL_BYTES:
                chunks = [handle.read()]
            else:
                head = handle.read(SESSION_HEAD_BYTES)
                handle.seek(max(0, size - SESSION_TAIL_BYTES))
                chunks = [head, handle.read()]
    except OSError:
        return None
    level = None
    for chunk in chunks:
        for line in chunk.decode('utf-8', 'replace').splitlines():
            if '"thinking_level_change"' not in line:
                continue
            try:
                entry = json.loads(line)
            except ValueError:
                continue  # крайние строки чанков могут быть обрезаны
            if entry.get('type') == 'thinking_level_change' and entry.get('thinkingLevel'):
                level = entry['thinkingLevel']
    return level


def render(data, quota, now=None, show_quota=True):
    now = time.time() if now is None else now
    cwd = (data.get('workspace') or {}).get('current_dir') or data.get('cwd') or os.getcwd()
    folder = Path(cwd).name or '/'
    model = data.get('model') or {}
    name = model.get('display_name') or model.get('id') or 'GPT'
    name = re.sub(r'\s*\((\w+) context\)', r' \1', name)
    # Приоритет: уровень из сессии pi → дефолт pi → effort из нагрузки → настройки Claude Code.
    pi_payload = bool(data.get('pi'))
    effort = (pi_thinking_level(data) if pi_payload else None)
    if not effort and pi_payload:
        effort = pi_default_thinking_level()
    if not effort:
        effort = (data.get('effort') or {}).get('level')
    if not effort:
        settings = read_json(Path.home() / '.claude/settings.json')
        effort = ((settings.get('modelSettings') or {}).get(model.get('id'), {})
                  .get('effortLevel') or settings.get('effortLevel', ''))
    context = data.get('context_window') or {}
    size = context.get('context_window_size') or 272000
    usage = context.get('current_usage')
    tokens = None
    if isinstance(usage, dict):
        tokens = sum(usage.get(key, 0) or 0 for key in
                     ('input_tokens', 'cache_creation_input_tokens', 'cache_read_input_tokens'))
    elif isinstance(context.get('used_percentage'), (int, float)):
        tokens = size * context['used_percentage'] / 100
    ctx = f'{int(tokens / 1000 + 0.5)}k' if tokens is not None else '—k'
    model_part = f'{name} {format_size(size)} {effort} {ctx}'
    used, reset = quota.get('used_percent'), quota.get('resets_at', 0)
    stale = bool(quota.get('error')) or now - quota.get('checked_at', 0) > 180
    if not show_quota:
        quota_part = None
    elif used is None or reset <= now:
        quota_part = '7d —'
    else:
        minutes = max(1, math.ceil((reset - now) / 60))
        days, remainder = divmod(minutes, 1440)
        hours, minutes = divmod(remainder, 60)
        countdown = f'{days}d {hours}h' if days else (f'{hours}h {minutes}m' if hours else f'{minutes}m')
        quota_part = f'7d {used:g}% {countdown}' + (' ~' if stale else '')
    parts = [f'📁 {folder}', model_part] + ([quota_part] if quota_part else [])
    return '\033[38;5;8m' + clean(' ● '.join(parts)) + '\033[0m'


def main():
    args = sys.argv[1:]
    if '--refresh' in args:
        refresh()
        return
    show_quota = '--no-quota' not in args
    try:
        data = json.load(sys.stdin)
    except (ValueError, OSError):
        data = {}
    quota = read_json(CACHE)
    if show_quota and time.time() - quota.get('attempted_at', 0) >= TTL:
        ROOT.mkdir(parents=True, exist_ok=True, mode=0o700)
        subprocess.Popen([sys.executable, str(Path(__file__).resolve()), '--refresh'],
            stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL, start_new_session=True)
    print(render(data, quota, show_quota=show_quota))


if __name__ == '__main__':
    main()
