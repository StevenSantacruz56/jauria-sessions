#!/usr/bin/env python3
"""Every browser suite of the desktop app, with its documented flags, serially.

Run by scripts/build-macos.py (unless --skip-browser-tests) and usable on its
own after `npm ci` in experiments/tauri-vertical/desktop. Suites use Google
Chrome (`channel: chrome`) and Playwright WebKit with synthetic fixtures only:
no runner, profile or provider. A preflight launches both browsers first and
stops with a clear message when one is missing.
"""
from pathlib import Path
import argparse, os, subprocess, sys

ROOT = Path(__file__).resolve().parents[1]
DESKTOP = ROOT / 'experiments/tauri-vertical/desktop'
PULSO = {'PULSO_PANEL_BROWSER': '1', 'PULSO_PANEL_WEBKIT': '1'}

# (label, extra environment, test files relative to desktop). One engine per
# run where the suite selects it with a variable (docs/DEVELOPMENT.md).
def suites(desktop: Path = DESKTOP) -> list[tuple[str, dict[str, str], list[str]]]:
    browser = sorted(str(p.relative_to(desktop)) for p in (desktop / 'tests/browser').glob('*.test.ts'))
    return [
        ('tests/browser (Chrome + WebKit)', PULSO, browser),
        ('pulso-panel (Chrome + WebKit)', PULSO, ['tests/pulso-panel.test.ts']),
        ('settings-panel + agent-permissions (Chrome + WebKit)', {'SETTINGS_PANEL_BROWSER': '1'}, ['tests/settings-panel.test.ts', 'tests/agent-permissions.test.ts']),
        ('attention-consistency (Chrome)', {'ATTENTION_CONSISTENCY_BROWSER': '1'}, ['tests/attention-consistency.test.ts']),
        ('attention-consistency (WebKit)', {'ATTENTION_CONSISTENCY_BROWSER': '1', 'ENGINE': 'webkit'}, ['tests/attention-consistency.test.ts']),
        ('terminal-stream (Chrome)', {'TERMINAL_STREAM_BROWSER': '1'}, ['tests/terminal-stream.test.ts']),
        ('terminal-stream (WebKit)', {'TERMINAL_STREAM_BROWSER': '1', 'TERMINAL_STREAM_ENGINE': 'webkit'}, ['tests/terminal-stream.test.ts']),
    ]

def commands(desktop: Path = DESKTOP) -> list[tuple[str, dict[str, str], list[str]]]:
    # Browser-heavy fixtures are timing sensitive: never two files at once.
    return [(label, env, ['node', '--test', '--test-concurrency=1', *files]) for label, env, files in suites(desktop)]

PREFLIGHT = """
import { chromium, webkit } from 'playwright';
const missing = [];
for (const [name, launch] of [['Google Chrome (channel chrome)', () => chromium.launch({ channel: 'chrome', headless: true })], ['Playwright WebKit', () => webkit.launch({ headless: true })]]) {
  try { const browser = await launch(); await browser.close(); } catch { missing.push(name); }
}
if (missing.length) { console.error(missing.join(', ')); process.exit(3); }
"""

MISSING = ('No se pueden ejecutar las pruebas de navegador: falta {names}. Instala Google Chrome y, desde '
           'experiments/tauri-vertical/desktop tras `npm ci`, ejecuta `npx playwright install webkit`. '
           'Para compilar sin ellas usa --skip-browser-tests (la salida lo deja indicado).')

def preflight(desktop: Path = DESKTOP, env=None, run=subprocess.run) -> None:
    if not (desktop / 'node_modules/playwright').is_dir():
        raise SystemExit('No se pueden ejecutar las pruebas de navegador: falta node_modules/playwright. Ejecuta `npm ci` en experiments/tauri-vertical/desktop.')
    result = run(['node', '--input-type=module', '-e', PREFLIGHT], cwd=desktop, env=env, capture_output=True, text=True)
    if result.returncode != 0:
        names = result.stderr.strip().splitlines()[-1] if result.stderr.strip() else 'un navegador de Playwright'
        raise SystemExit(MISSING.format(names=names))

def run_all(desktop: Path = DESKTOP, env=None, run=subprocess.run) -> None:
    base = dict(os.environ if env is None else env)
    preflight(desktop, base, run)
    for label, extra, argv in commands(desktop):
        print(f'== Pruebas de navegador: {label}', flush=True)
        run(argv, cwd=desktop, env={**base, **extra}, check=True)

def main(argv=None) -> None:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument('--list', action='store_true', help='Print the suites and their flags without running them.')
    args = parser.parse_args(argv)
    if args.list:
        for label, extra, command in commands():
            print(f"{label}: {' '.join(f'{k}={v}' for k, v in extra.items())} {' '.join(command)}")
        return
    run_all()

if __name__ == '__main__':
    main(sys.argv[1:])
