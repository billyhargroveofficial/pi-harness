#!/usr/bin/env python3
"""Deploy JSON templates with portable HOME paths and machine-local provider auth."""
import argparse
import json
from pathlib import Path


def prepare(source, home, previous=None, preserve_auth=False):
    def portable(value):
        if isinstance(value, str):
            return value.replace('/Users/billy', str(home))
        if isinstance(value, list):
            return [portable(item) for item in value]
        if isinstance(value, dict):
            return {key: portable(item) for key, item in value.items()}
        return value
    result = portable(source)
    if preserve_auth and previous:
        providers = result.setdefault('providers', {})
        for name, old in previous.get('providers', {}).items():
            if name != 'openai-codex':
                continue  # canonical harness is Codex-only; do not resurrect retired providers
            if name not in providers:
                providers[name] = old
            elif isinstance(old, dict) and 'apiKey' in old:
                providers[name]['apiKey'] = old['apiKey']  # retain the machine's Codex credential source
    return result


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('source', type=Path)
    parser.add_argument('destination', type=Path)
    parser.add_argument('--home', type=Path, default=Path.home())
    parser.add_argument('--preserve-provider-auth', action='store_true')
    args = parser.parse_args()
    source = json.loads(args.source.read_text())
    previous = json.loads(args.destination.read_text()) if args.preserve_provider_auth and args.destination.exists() else None
    result = prepare(source, args.home, previous, args.preserve_provider_auth)
    args.destination.parent.mkdir(parents=True, exist_ok=True)
    args.destination.write_text(json.dumps(result, ensure_ascii=False, indent=2) + '\n')
    args.destination.chmod(0o600)


if __name__ == '__main__':
    main()
