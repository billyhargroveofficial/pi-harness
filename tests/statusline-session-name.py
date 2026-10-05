#!/usr/bin/env python3
"""Offline regression: Pi session title in the shared status line, CC unchanged."""
import importlib.util
import json
import re
import tempfile
from pathlib import Path

root = Path(__file__).resolve().parents[1]
script = root / 'assets/statusline.py'
spec = importlib.util.spec_from_file_location('pi_harness_statusline', script)
statusline = importlib.util.module_from_spec(spec)
spec.loader.exec_module(statusline)
plain = lambda text: re.sub(r'\x1b\[[0-9;]*m', '', text)


def line(entry):
    return json.dumps(entry, separators=(',', ':'), ensure_ascii=False) + '\n'


with tempfile.TemporaryDirectory() as temp:
    session = Path(temp) / 'session.jsonl'
    with session.open('w') as f:
        f.write(line({'type': 'session', 'cwd': '/tmp/harness-space'}))
        f.write(line({'type': 'thinking_level_change', 'thinkingLevel': 'xhigh'}))
        f.write(line({'type': 'message', 'message': {'role': 'user', 'content': 'a' * 70000}}))
        f.write(line({'type': 'session_info', 'name': 'pi-patches'}))
        f.write(line({'type': 'message', 'message': {'role': 'user', 'content': 'b' * 350000}}))
    data = {
        'workspace': {'current_dir': '/tmp/harness-space'},
        'model': {'id': 'gpt-6-sol', 'display_name': 'GPT-6 Sol'},
        'context_window': {
            'context_window_size': 272000,
            'current_usage': {'input_tokens': 200000, 'cache_read_input_tokens': 21000},
        },
        'pi': {'session_file': str(session)},
    }
    expected = '📁 harness-space ● GPT-6 Sol 272k xhigh 221k · pi-patches'
    assert plain(statusline.render(data, {}, show_quota=False)) == expected

    # Claude Code shares the script but never receives the Pi-only suffix.
    claude = {key: value for key, value in data.items() if key != 'pi'}
    claude['effort'] = {'level': 'xhigh'}
    assert plain(statusline.render(claude, {}, show_quota=False)) == expected.split(' · ')[0]

    with session.open('a') as f:
        f.write(line({'type': 'session_info', 'name': 'renamed'}))
    assert plain(statusline.render(data, {}, show_quota=False)).endswith('221k · renamed')

    with session.open('a') as f:
        f.write(line({'type': 'session_info', 'name': ''}))
    assert plain(statusline.render(data, {}, show_quota=False)) == expected.split(' · ')[0]

    long_name = 'N' * 70
    with session.open('a') as f:
        f.write(line({'type': 'session_info', 'name': long_name}))
    assert plain(statusline.render(data, {}, show_quota=False)).endswith(' · ' + 'N' * 60 + '…')

    data['pi']['session_file'] = str(session.with_name('missing.jsonl'))
    assert plain(statusline.render(data, {}, show_quota=False)) == expected.split(' · ')[0]

patch = (root / 'patches/fix-pi-statusline-refresh.mjs').read_text()
assert 'pi.on("session_info_changed"' in patch, 'missing rename refresh hook'
assert 'pi.on("thinking_level_select"' in patch, 'missing thinking refresh hook'
print('PASS: old name beyond head/tail, rename, clear, length limit, missing file, CC unchanged, refresh hooks')
