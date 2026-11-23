import importlib.util
from pathlib import Path
import re
import subprocess
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]
DESKTOP = ROOT / 'experiments/tauri-vertical/desktop'
spec = importlib.util.spec_from_file_location('browser_tests', ROOT / 'scripts/browser-tests.py')
browser_tests = importlib.util.module_from_spec(spec)
spec.loader.exec_module(browser_tests)


class BrowserSuiteTests(unittest.TestCase):
    def test_every_browser_file_runs_serially(self):
        commands = browser_tests.commands()
        files = {f for _, _, argv in commands for f in argv[3:]}
        expected = {str(p.relative_to(DESKTOP)) for p in (DESKTOP / 'tests/browser').glob('*.test.ts')}
        self.assertTrue(expected and expected <= files, expected - files)
        for _, _, argv in commands:
            self.assertEqual(argv[:3], ['node', '--test', '--test-concurrency=1'])

    def test_every_opt_in_suite_runs_with_its_flag(self):
        # A top-level file gated by `process.env.X_BROWSER !== '1'` must run with X_BROWSER=1.
        gated = {}
        for path in (DESKTOP / 'tests').glob('*.test.ts'):
            for flag in re.findall(r"process\.env\.([A-Z_]+_BROWSER) *!== *'1'", path.read_text()):
                gated.setdefault(str(path.relative_to(DESKTOP)), set()).add(flag)
        self.assertIn('tests/pulso-panel.test.ts', gated)
        commands = browser_tests.commands()
        for file, flags in gated.items():
            runs = [env for _, env, argv in commands if file in argv]
            self.assertTrue(runs, f'{file} never runs')
            for flag in flags:
                self.assertTrue(any(env.get(flag) == '1' for env in runs), f'{file} without {flag}=1')

    def test_both_engines_for_engine_selected_suites(self):
        envs = {label: env for label, env, _ in browser_tests.commands()}
        self.assertTrue(any(env.get('ENGINE') == 'webkit' for env in envs.values()))
        self.assertTrue(any(env.get('TERMINAL_STREAM_ENGINE') == 'webkit' for env in envs.values()))
        self.assertTrue(all(env.get('PULSO_PANEL_WEBKIT') == '1' for env in envs.values() if 'PULSO_PANEL_BROWSER' in env))

    def test_preflight_fails_with_a_clear_message(self):
        with tempfile.TemporaryDirectory(prefix='jauria-browser-test-') as tmp:
            desktop = Path(tmp)
            with self.assertRaises(SystemExit) as missing_modules:
                browser_tests.preflight(desktop, {}, run=lambda *a, **k: self.fail('must not launch'))
            self.assertIn('npm ci', str(missing_modules.exception))
            (desktop / 'node_modules/playwright').mkdir(parents=True)
            failed = lambda argv, **kwargs: subprocess.CompletedProcess(argv, 3, '', 'Playwright WebKit\n')
            with self.assertRaises(SystemExit) as missing_browser:
                browser_tests.preflight(desktop, {}, run=failed)
            self.assertIn('Playwright WebKit', str(missing_browser.exception))
            self.assertIn('npx playwright install webkit', str(missing_browser.exception))
            self.assertIn('--skip-browser-tests', str(missing_browser.exception))
            ok = lambda argv, **kwargs: subprocess.CompletedProcess(argv, 0, '', '')
            browser_tests.preflight(desktop, {}, run=ok)

    def test_run_all_preflights_first_then_runs_each_suite_with_its_flags(self):
        calls = []
        def run(argv, **kwargs):
            calls.append((argv, kwargs.get('env', {})))
            return subprocess.CompletedProcess(argv, 0, '', '')
        with tempfile.TemporaryDirectory(prefix='jauria-browser-test-') as tmp:
            desktop = Path(tmp)
            (desktop / 'node_modules/playwright').mkdir(parents=True)
            (desktop / 'tests/browser').mkdir(parents=True)
            (desktop / 'tests/browser/a.test.ts').write_text('')
            browser_tests.run_all(desktop, {'PATH': '/usr/bin'}, run=run)
        self.assertEqual(calls[0][0][:2], ['node', '--input-type=module'])
        self.assertEqual(calls[1][0], ['node', '--test', '--test-concurrency=1', 'tests/browser/a.test.ts'])
        self.assertEqual(calls[1][1]['PULSO_PANEL_BROWSER'], '1')
        self.assertEqual(calls[1][1]['PATH'], '/usr/bin')
        self.assertEqual(len(calls), 1 + len(browser_tests.commands(desktop)))

    def test_build_runs_the_browser_step_unless_skipped_visibly(self):
        source = (ROOT / 'scripts/build-macos.py').read_text()
        self.assertIn("'--skip-browser-tests'", source)
        self.assertIn("run(['python3','scripts/browser-tests.py'],ROOT)", source)
        self.assertRegex(source, r"if args\.skip_browser_tests: print\(SKIPPED")
        self.assertIn('se saltaron TODAS las pruebas de navegador', source)

    def test_ci_installs_webkit_and_runs_the_build(self):
        workflow = (ROOT / '.github/workflows/macos.yml').read_text()
        self.assertIn('npx playwright install webkit', workflow)
        self.assertIn('python3 scripts/build-macos.py', workflow)
        self.assertNotIn('--skip-browser-tests', workflow)


if __name__ == '__main__':
    unittest.main()
