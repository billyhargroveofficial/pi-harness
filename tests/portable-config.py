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
models = json.loads((root / 'agent/models.json').read_text())
original = copy.deepcopy(models)
home = Path('/home/flyingkuskus')
portable = module.prepare(settings, home)
assert portable['skills'] == ['/home/flyingkuskus/.agents/skills']
assert '/home/flyingkuskus/' in portable['statusLine']['command']
assert '/Users/billy' not in json.dumps(portable)
previous = {'providers': {
    'deepseek': {'apiKey': '!machine-local-auth-helper', 'models': [{'id': 'old-model'}]},
    'openai-codex': {'apiKey': '!python3 /home/flyingkuskus/.pi/agent/bin/codex-access-token.py'},
}}
merged = module.prepare(models, home, previous, preserve_auth=True)
assert merged['providers']['deepseek']['apiKey'] == '!machine-local-auth-helper'
assert merged['providers']['deepseek']['models'][0]['id'] == 'deepseek-flash'
assert merged['providers']['openai-codex'] == previous['providers']['openai-codex']
assert 'runpod-qwen-cyber' in merged['providers']
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
