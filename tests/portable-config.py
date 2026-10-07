#!/usr/bin/env python3
import copy
import importlib.util
import json
import stat
import subprocess
import sys
import tempfile
from pathlib import Path

root = Path(__file__).resolve().parents[1]
helper = root / 'assets/prepare-config.py'
spec = importlib.util.spec_from_file_location('prepare_config', helper)
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
settings = json.loads((root / 'agent/settings.json').read_text())
subagents = json.loads((root / 'agent/subagents.json').read_text())
if subagents.get('scopeModels'):
    assert all(':' not in entry for entry in settings['enabledModels']), 'pi-subagents scopeModels ignores :thinking suffixes'
    assert 'openai-codex/gpt-6-sol' in settings['enabledModels']
    assert settings['modelThinkingLevels']['openai-codex/gpt-6-sol'] == 'xhigh'
for model in ('openai-codex/gpt-6-sol', 'openai-codex/gpt-6.1-sol', 'openai-codex/gpt-6-astra'):
    assert model in settings['enabledModels']
    assert 272000 - settings['compaction']['modelOverrides'][model]['reserveTokens'] == 245000
assert settings['compaction']['reserveTokens'] == 1000, 'generic fallback threshold'
assert all(model.startswith('openai-codex/') for model in settings['enabledModels'])
models = json.loads((root / 'agent/models.json').read_text())
original = copy.deepcopy(models)
home = Path('/home/flyingkuskus')
portable = module.prepare(settings, home)
assert portable['skills'] == ['/home/flyingkuskus/.agents/skills']
assert '/home/flyingkuskus/' in portable['statusLine']['command']
assert '/Users/billy' not in json.dumps(portable)
previous = {'providers': {
    'retired-provider': {'apiKey': '!machine-local-auth-helper', 'models': [{'id': 'old-model'}]},
    'openai-codex': {'apiKey': '!python3 /home/flyingkuskus/.pi/agent/bin/codex-access-token.py'},
    'runpod-qwen-cyber': {'apiKey': '!machine-local-optional-provider'},
}}
merged = module.prepare(models, home, previous, preserve_auth=True)
assert merged['providers'] == {'openai-codex': previous['providers']['openai-codex']}
assert models['providers'] == {}, 'canonical harness uses built-in Codex catalog only'
assert models == original
with tempfile.TemporaryDirectory() as temp:
    dst = Path(temp) / 'models.json'
    dst.write_text(json.dumps(previous))
    subprocess.run([sys.executable, str(helper), str(root / 'agent/models.json'), str(dst), '--home', str(home), '--preserve-provider-auth'], check=True)
    assert json.loads(dst.read_text()) == merged
    assert stat.S_IMODE(dst.stat().st_mode) == 0o600
    dst.write_text('INVALID ORIGINAL')
    result = subprocess.run([sys.executable, str(helper), str(root / 'agent/models.json'), str(dst), '--preserve-provider-auth'], capture_output=True)
    assert result.returncode != 0
    assert dst.read_text() == 'INVALID ORIGINAL'
print('PASS: portable HOME, machine-local auth preservation, canonical model updates, private permissions, malformed-file safety')
