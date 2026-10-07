#!/usr/bin/env python3
"""Retire the old search/provider without touching sessions, skills or other credentials.

Safe to re-run. Config parsing is completed before any writes. Removes only the
retired extension's own npm manifest entries/directory, never SDK/catalog code.
"""
import argparse
import json
import os
from pathlib import Path
import re
import shutil
import stat
import tempfile

RETIRED = 'deepseek'
MODEL = 'openai-codex/gpt-6.1-sol'


def retired(value):
    return isinstance(value, str) and RETIRED in value.lower()


def clean_json(data, kind):
    if kind == 'settings':
        data['packages'] = [p for p in data.get('packages', []) if not retired(p.get('source') if isinstance(p, dict) else p)]
        if 'enabledModels' in data:
            data['enabledModels'] = [p for p in data['enabledModels'] if p.startswith('openai-codex/')] or [MODEL]
        if retired(data.get('defaultProvider')) or retired(data.get('defaultModel')):
            data.update(defaultProvider='openai-codex', defaultModel='gpt-6.1-sol', defaultThinkingLevel='high')
        for field in ('modelThinkingLevels',):
            if field in data:
                data[field] = {k: v for k, v in data[field].items() if k.startswith('openai-codex/')}
        for field in ('compaction',):
            overrides = data.get(field, {}).get('modelOverrides')
            if overrides is not None:
                data[field]['modelOverrides'] = {k: v for k, v in overrides.items() if k.startswith('openai-codex/')}
        for field in ('extensions',):
            if field in data:
                data[field] = [p for p in data[field] if not retired(p)]
    elif kind == 'models':
        data['providers'] = {k: v for k, v in data.get('providers', {}).items() if k == 'openai-codex'}
    elif kind == 'store':
        data = {k: v for k, v in data.items() if k == 'openai-codex'}
    elif kind == 'auth':
        data = {k: v for k, v in data.items() if not retired(k)}  # preserve all unrelated account tokens
    elif kind == 'npm':
        for field in ('dependencies', 'devDependencies', 'optionalDependencies'):
            if isinstance(data.get(field), dict):
                data[field] = {k: v for k, v in data[field].items() if not retired(k)}
        if isinstance(data.get('packages'), dict):
            data['packages'] = {k: clean_json(v, 'npm') for k, v in data['packages'].items() if not retired(k)}
    return data


def clean_instructions(text):
    text = text.replace('Используй нативный поиск DeepSeek', 'Используй hosted web_search Codex через pi-openai-toolkit')
    text = text.replace('Все эти роли используют deepseek/deepseek-flash и\nимеют web_search.',
                        'Все эти роли используют openai-codex/gpt-6.1-sol и\nhosted web_search через pi-openai-toolkit.')
    return text


def clean_agent(text):
    # Only the frontmatter model directive, not examples/quoted text in a task.
    if not text.startswith('---\n'):
        return text
    front, sep, body = text[4:].partition('\n---')
    front = re.sub(r'^model:[^\n]+$', lambda match: match[0] if match[0].split(':', 1)[1].strip().strip("\"'").startswith('openai-codex/') else f'model: {MODEL}', front, flags=re.M)
    front = re.sub(r',?\s*ext:pi-deepseek-search/web_search', '', front)
    front = front.replace('pi-deepseek-search', 'pi-openai-toolkit')
    front = front.replace('DeepSeek', 'Codex').replace('deepseek/deepseek-flash', MODEL)
    return '---\n' + front + sep + body


def replace(path, content):
    mode = stat.S_IMODE(path.stat().st_mode) if path.exists() else 0o600
    fd, name = tempfile.mkstemp(prefix='.codex-only-', dir=path.parent)
    try:
        with os.fdopen(fd, 'w') as stream:
            stream.write(content)
        os.chmod(name, mode)
        os.replace(name, path)  # callers resolve symlinks, preserving shared instructions
    finally:
        if os.path.exists(name):
            os.unlink(name)


def migrate(home, agent_dir, purge_retired_secrets=False):
    changes = {}
    paths = list(agent_dir.glob('*'))
    paths.extend(p for p in (agent_dir / 'npm').glob('package*.json'))
    backups = agent_dir / 'backups'
    if backups.exists():
        paths.extend(p for p in backups.rglob('*') if p.is_file() and 'node_modules' not in p.parts)
    # Sanitize known config backups too: restoring one must not re-enable the retired provider.
    for path in paths:
        if not path.is_file():
            continue
        kind = next((kind for prefix, kind in [('settings.json', 'settings'), ('models.json', 'models'),
                    ('models-store.json', 'store'), ('auth.json', 'auth'), ('package.json', 'npm'), ('package-lock.json', 'npm')] if path.name.startswith(prefix)), None)
        if kind:
            raw = path.read_text()
            data = json.loads(raw)
            if not retired(raw) and kind != 'models':
                continue
            content = json.dumps(clean_json(data, kind), ensure_ascii=False, indent=2) + '\n'
            if content != raw:
                changes[path.resolve()] = content
        elif path.name == 'AGENTS.md':
            raw = path.read_text(); content = clean_instructions(raw)
            if content != raw:
                changes[path.resolve()] = content
    for path in (agent_dir / 'agents').glob('*.md'):
        raw = path.read_text(); content = clean_agent(raw)
        if content != raw:
            changes[path.resolve()] = content
    secret = home / '.config/deepseek.env'
    if purge_retired_secrets:
        for name in ('.zshrc', '.zprofile', '.bashrc', '.bash_profile', '.profile'):
            path = home / name
            if not path.is_file():
                continue
            raw = path.read_text()
            # Do not erase arbitrary shell commands mentioning the old provider.
            lines = [l for l in raw.splitlines(keepends=True) if not (retired(l) and
                     (l.lstrip().startswith('# DeepSeek API key') or ('deepseek.env' in l and ('source ' in l or '. ' in l))))]
            content = ''.join(lines)
            if content != raw:
                changes[path.resolve()] = content
    for path, content in changes.items():
        replace(path, content)
        print('updated:', path)
    package = agent_dir / 'npm/node_modules/pi-deepseek-search'
    if package.is_symlink():
        package.unlink()
        print('removed retired extension symlink')
    elif package.is_dir():
        shutil.rmtree(package)
        print('removed retired extension directory')
    if purge_retired_secrets and secret.exists():
        secret.unlink()  # deliberately no backup of the retired secret
        print('removed retired credential file')
    return len(changes)


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--home', type=Path, default=Path.home())
    parser.add_argument('--agent-dir', type=Path)
    parser.add_argument('--purge-retired-secrets', action='store_true')
    args = parser.parse_args()
    migrate(args.home, args.agent_dir or args.home / '.pi/agent', args.purge_retired_secrets)
