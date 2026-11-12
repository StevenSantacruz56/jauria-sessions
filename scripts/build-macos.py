#!/usr/bin/env python3
"""Portable local build using installed native tools and inherited environment."""
from pathlib import Path
import argparse, os, platform, shutil, subprocess
ROOT=Path(__file__).resolve().parents[1]
APP=ROOT/'experiments/tauri-vertical'
p=argparse.ArgumentParser();p.add_argument('--check-only',action='store_true');args=p.parse_args()
if platform.system()!='Darwin' or platform.machine()!='arm64':raise SystemExit('This release supports macOS Apple Silicon only.')
for tool in ('cargo','rustc','node','npm','xcodebuild'):
    if not shutil.which(tool):raise SystemExit('Install '+tool+' and expose it on PATH before building.')
env=os.environ.copy()
# Bundle resource path expects the runner in runner/target. Avoid inherited target overrides.
env.pop('CARGO_TARGET_DIR',None)
def run(argv,cwd):subprocess.run(argv,cwd=cwd,env=env,check=True)
runner=APP/'runner';desktop=APP/'desktop'
run(['npm','ci','--ignore-scripts','--no-audit','--no-fund'],desktop)
run(['npm','run','build'],desktop)
run(['node','--test',*map(str,sorted((desktop/'tests').glob('*.test.ts')))],desktop)
run(['cargo','test','--locked','--bin','aw-runner','--test','rpc','--test','storage_retention'],runner)
run(['cargo','build','--release','--locked'],runner)
run(['cargo','test','--locked'],desktop/'src-tauri')
if not args.check_only:
    run(['npm','run','tauri','--','build','--debug','--bundles','app','--no-sign','--','--locked'],desktop)
    print('Unsigned local bundle:',desktop/'src-tauri/target/debug/bundle/macos')
