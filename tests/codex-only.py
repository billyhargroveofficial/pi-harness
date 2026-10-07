#!/usr/bin/env python3
"""Offline migration regression; all credentials and homes below are fake."""
import importlib.util
import json
from pathlib import Path
import tempfile
import stat

root = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('migration', root / 'assets/codex-only.py')
m = importlib.util.module_from_spec(spec); spec.loader.exec_module(m)
settings = json.loads((root / 'agent/settings.json').read_text())
assert all(p.startswith('openai-codex/') for p in settings['enabledModels'])
assert not m.retired(json.dumps(settings))
for p in (root / 'agent/agents').glob('*.md'):
    text = p.read_text()
    assert 'model: openai-codex/' in text and 'extensions: [pi-openai-toolkit]' in text
    assert not m.retired(text)
assert not m.retired((root / 'agent/AGENTS.md').read_text())
with tempfile.TemporaryDirectory() as tmp:
    home = Path(tmp); agent = home / '.pi/agent'; (agent / 'agents').mkdir(parents=True)
    def put(name, data):
        path = agent / name; path.write_text(json.dumps(data)); path.chmod(0o600); return path
    old = 'deepseek'
    cfg = put('settings.json', {'theme':'terracotta-local-user','defaultProvider':old,'defaultModel':'deepseek-flash',
        'enabledModels':[old+'/deepseek-flash','openai-codex/gpt-6-sol'],
        'packages':['npm:pi-deepseek-search@1.0.20','npm:pi-openai-toolkit','machine-local-addon']})
    put('models.json', {'providers':{old:{'apiKey':'SECRET'},'openai-codex':{'apiKey':'!machine-specific-helper'}}})
    put('models-store.json', {old:{'models':[]},'openai-codex':{'models':[]}})
    auth = put('auth.json', {old:{'key':'SECRET'},'openai-codex':{'oauth':'UNCHANGED'},'unrelated':{'key':'KEEP'}})
    put('settings.json.bak-before-codex', {'packages':['npm:pi-deepseek-search@1.0.20']})
    (agent/'npm/node_modules/pi-deepseek-search').mkdir(parents=True)
    put('npm/package.json', {'dependencies':{'pi-deepseek-search':'1.0.20','pi-openai-toolkit':'keep'}})
    put('npm/package-lock.json', {'packages':{'':{'dependencies':{'pi-deepseek-search':'1.0.20','pi-openai-toolkit':'keep'}},'node_modules/pi-deepseek-search':{},'node_modules/pi-openai-toolkit':{'version':'keep'}}})
    shell = home / '.zshrc'; shell.write_text('# DeepSeek API key for the remaining clients.\n[ -r "$HOME/.config/deepseek.env" ] && source "$HOME/.config/deepseek.env"\nexport KEEP=1\n')
    (home / '.config').mkdir(); secret=home/'.config/deepseek.env';secret.write_text('SECRET')
    shared=home/'AGENTS.shared.md';shared.write_text('Используй нативный поиск DeepSeek для свежей информации.\nPersonal instructions remain.\n')
    (agent/'AGENTS.md').symlink_to(shared)
    coder=agent/'agents/custom.md';coder.write_text('---\nmodel: openai-codex/gpt-6-sol\nextensions: []\n---\ncustom\n')
    researcher=agent/'agents/old.md';researcher.write_text('---\nmodel: deepseek/deepseek-flash\ntools: "read, ext:pi-deepseek-search/web_search"\nextensions: [pi-deepseek-search]\n---\nresearch\n')
    coder_before=coder.read_text()
    m.migrate(home,agent,True)
    assert json.loads(cfg.read_text())['theme']=='terracotta-local-user'
    assert json.loads(cfg.read_text())['packages']==['npm:pi-openai-toolkit','machine-local-addon']
    assert json.loads(auth.read_text())=={'openai-codex':{'oauth':'UNCHANGED'},'unrelated':{'key':'KEEP'}}
    assert json.loads((agent/'models.json').read_text())['providers']=={'openai-codex':{'apiKey':'!machine-specific-helper'}}
    assert not secret.exists() and shell.read_text()=='export KEEP=1\n'
    assert not (agent/'npm/node_modules/pi-deepseek-search').exists()
    assert not m.retired((agent/'npm/package.json').read_text())
    assert not m.retired((agent/'npm/package-lock.json').read_text())
    assert json.loads((agent/'npm/package.json').read_text())['dependencies']=={'pi-openai-toolkit':'keep'}
    assert (agent/'AGENTS.md').is_symlink() and 'Personal instructions remain.' in shared.read_text()
    assert coder.read_text()==coder_before and not m.retired(researcher.read_text())
    assert stat.S_IMODE(auth.stat().st_mode)==0o600
    assert m.migrate(home,agent,True)==0
    # Corrupt config aborts before any other files/keys are changed.
    cfg.write_text('{"packages":["npm:pi-deepseek-search"]}')
    (agent/'models.json').write_text('INVALID')
    before=cfg.read_text()
    try: m.migrate(home,agent,True)
    except json.JSONDecodeError: pass
    else: raise AssertionError('malformed file was accepted')
    assert cfg.read_text()==before
print('PASS: Codex-only defaults and agents; migration preserves themes, custom Codex models, shared-instruction symlinks, OAuth and permissions; removes retired secrets; idempotent; malformed-file preflight')
