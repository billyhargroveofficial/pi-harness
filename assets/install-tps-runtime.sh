#!/usr/bin/env bash
# Dedicated reference BPE runtime, never a Pi npm extension/package manifest.
# --stage DIR prepares a validated runtime without replacing the live runtime.
# Without --stage, use the unified runtime + code + acceptance transaction.
set -euo pipefail
REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
AGENT_DIR="${PI_CODING_AGENT_DIR:-${PI_AGENT_DIR:-$HOME/.pi/agent}}"
STAGE=""
if [ "$#" -eq 0 ]; then
  exec bash "$REPO_DIR/assets/deploy-tps-speedometer.sh"
elif [ "${1:-}" = --stage ] && [ "$#" -eq 2 ]; then
  STAGE="$2"
else
  echo 'usage: install-tps-runtime.sh [--stage nonexistent-directory]' >&2; exit 2
fi
# Validate the pinned single pure dependency BEFORE creating anything.
node --input-type=module - "$REPO_DIR/assets/tps-runtime" "$AGENT_DIR" <<'JS'
import {readFileSync,lstatSync} from 'node:fs';
import {join} from 'node:path';
import assert from 'node:assert/strict';
const [root,agent]=process.argv.slice(2);
for(const path of [agent,join(agent,'tps-runtime')]){
  let info;try{info=lstatSync(path);}catch(error){if(error.code!=='ENOENT')throw error;}
  assert.ok(!info || (info.isDirectory()&&!info.isSymbolicLink()),'Runtime destination must be a real directory');
}
const pkg=JSON.parse(readFileSync(`${root}/package.json`));
const lock=JSON.parse(readFileSync(`${root}/package-lock.json`));
assert.equal(pkg.private,true);
assert.deepEqual(pkg.dependencies,{'gpt-tokenizer':'4.0.0'});
assert.ok(!pkg.scripts && !pkg.pi && !pkg.optionalDependencies);
assert.equal(lock.lockfileVersion,3);
assert.deepEqual(Object.keys(lock.packages).sort(),['','node_modules/gpt-tokenizer']);
assert.deepEqual(lock.packages[''].dependencies,pkg.dependencies);
const dep=lock.packages['node_modules/gpt-tokenizer'];
assert.equal(dep.version,'4.0.0');
assert.equal(dep.resolved,'https://registry.npmjs.org/gpt-tokenizer/-/gpt-tokenizer-4.0.0.tgz');
assert.equal(dep.integrity,'sha512-YAWIyzvuVUHEfW7tFfFAxH8qQb+Q3RU9nYOTy7skMNX5qzU6Q8jxTHZLyO56ug1vYvCR7wndzpd3jwD86/mhjQ==');
assert.ok(!dep.hasInstallScript && !dep.dependencies && !dep.optionalDependencies);
JS
if [ -e "$STAGE" ] || [ -L "$STAGE" ]; then echo 'Stage must not exist' >&2; exit 1; fi
# Refuse symlinked staging parents as well as a symlinked runtime target.
node --input-type=module - "$STAGE" <<'JS'
import {lstatSync} from 'node:fs';
import {dirname,resolve} from 'node:path';
let path=dirname(resolve(process.argv[2]));
for(;;){if(path==='/tmp'||path==='/var')break;const info=lstatSync(path);if(!info.isDirectory()||info.isSymbolicLink())throw Error('Unsafe runtime stage parent');const parent=dirname(path);if(parent===path)break;path=parent;}
JS
mkdir "$STAGE"
cleanup() { [ -z "$STAGE" ] || rm -rf "$STAGE"; }
trap cleanup EXIT
cp "$REPO_DIR/assets/tps-runtime/package.json" "$REPO_DIR/assets/tps-runtime/package-lock.json" "$STAGE/"
node --input-type=module - "$STAGE" <<'JS'
import {spawnSync} from 'node:child_process';
import {readdirSync,lstatSync,realpathSync} from 'node:fs';
import {createRequire} from 'node:module';
import {join,resolve} from 'node:path';
import assert from 'node:assert/strict';
const stage=resolve(process.argv[2]);
const result=spawnSync('npm',['ci','--ignore-scripts','--no-audit','--no-fund'],{cwd:stage,stdio:'inherit',timeout:120000});
assert.equal(result.status,0,result.error?.message ?? 'npm ci failed');
const modules=join(stage,'node_modules');
assert.ok(lstatSync(modules).isDirectory()&&!lstatSync(modules).isSymbolicLink(),'Dedicated node_modules must be a real directory');
assert.deepEqual(readdirSync(modules).sort(),['.package-lock.json','gpt-tokenizer']);
let count=0,bytes=0;
function walk(path){
  for(const name of readdirSync(path)){
    const file=join(path,name),stat=lstatSync(file);
    assert.ok(!stat.isSymbolicLink(),'No dependency symlinks');
    assert.ok(++count<=4096,'Runtime file-count limit');
    if(stat.isDirectory())walk(file);
    else {assert.ok(stat.isFile() && !name.endsWith('.node'),'Pure JS/data only');bytes+=stat.size;assert.ok(bytes<=64*1024*1024,'Runtime size limit');}
  }
}
walk(join(stage,'node_modules'));
const require=createRequire(join(stage,'package.json'));
const packageRoot=realpathSync(join(modules,'gpt-tokenizer'));
for(const specifier of ['gpt-tokenizer/package.json','gpt-tokenizer/encoding/o200k_base'])assert.ok(realpathSync(require.resolve(specifier)).startsWith(`${packageRoot}/`),'Resolved tokenizer must stay inside dedicated package');
const pkg=require('gpt-tokenizer/package.json');
assert.equal(pkg.name,'gpt-tokenizer');assert.equal(pkg.version,'4.0.0');
assert.ok(!pkg.bin && Object.keys(pkg.dependencies??{}).length===0 && Object.keys(pkg.optionalDependencies??{}).length===0);
const {encode,decode}=require('gpt-tokenizer/encoding/o200k_base');
for(const text of ['literal <|endoftext|> <|fim_prefix|> 😀','Привет 世界','\ud83d\ude00']){
  const ids=encode(text,{allowedSpecial:new Set(),disallowedSpecial:new Set()});
  assert.ok(ids.length>0 && ids.every(Number.isSafeInteger));
  assert.equal(decode(ids),text,'Special-looking text must round-trip as ordinary text');
}
console.log('PASS: pinned pure o200k_base reference runtime (not model-native tokenization)');
JS
STAGE=""
echo 'Staged validated reference TPS runtime; live runtime and overlay unchanged.'
