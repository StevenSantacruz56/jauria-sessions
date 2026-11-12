#!/usr/bin/env python3
"""Open an existing local bundle with production controls and an explicit private profile."""
from pathlib import Path
import argparse,json,subprocess
root=Path(__file__).resolve().parents[1];app=root/'experiments/tauri-vertical'
p=argparse.ArgumentParser();p.add_argument('--data',type=Path,required=True);args=p.parse_args()
name=json.loads((app/'desktop/src-tauri/tauri.conf.json').read_text())['productName']
bundle=app/'desktop/src-tauri/target/debug/bundle/macos'/f'{name}.app'
if not bundle.is_dir():raise SystemExit('Build the local bundle first: python3 scripts/build-macos.py')
data=args.data.expanduser().resolve();data.mkdir(parents=True,exist_ok=True,mode=0o700)
subprocess.run(['/usr/bin/open','-n','-a',str(bundle),'--env','AW_VERTICAL_HOME='+str(data),'--env','AW_VERTICAL_SMOKE=0'],check=True)
