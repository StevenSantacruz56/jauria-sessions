import importlib.util
import json
from pathlib import Path
import re
import shutil
import subprocess
import sys
import tempfile
import unittest

REPO = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('jauria_version', REPO / 'scripts/version.py')
versioning = importlib.util.module_from_spec(spec)
spec.loader.exec_module(versioning)


class VersioningTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(prefix='jauria-version-')
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        for relative in [*versioning.render(REPO, '0.1.1'), Path('CHANGELOG.md'), Path('scripts/version.py')]:
            path = self.root / relative
            path.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(REPO / relative, path)
        # A stable disposable baseline keeps these tests valid after later bumps.
        for relative, content in versioning.render(self.root, '0.1.1').items():
            (self.root / relative).write_text(content)
        (self.root / 'CHANGELOG.md').write_text('## [Unreleased]\n\n## [0.1.1] - 2026-11-13\n')

    def test_sync_changes_own_versions_without_changing_dependencies(self):
        before = {p: (self.root / p).read_text() for p in versioning.render(self.root, '0.1.1')}
        edits = versioning.render(self.root, '0.1.2')
        for relative, content in edits.items():
            if relative.name == 'Cargo.lock':
                packages = lambda text: re.findall(r'\[\[package\]\]\nname = "([^"]+)"\nversion = "([^"]+)"', text)
                old, new = packages(before[relative]), packages(content)
                own = 'aw-runner' if 'runner' in relative.parts else 'aw-vertical-desktop'
                self.assertEqual([v for name, v in new if name == own], ['0.1.2'])
                self.assertEqual([(name, v) for name, v in old if name != own], [(name, v) for name, v in new if name != own])
            elif relative.name in ('package.json', 'package-lock.json'):
                old, new = json.loads(before[relative]), json.loads(content)
                if relative.name == 'package-lock.json':
                    old['packages'].pop('')
                    new['packages'].pop('')
                old.pop('version')
                new.pop('version')
                self.assertEqual(old, new)

    def test_check_detects_independent_manifest_and_generated_label_drift(self):
        self.assertEqual(versioning.check(self.root, '0.1.1'), [])
        package = versioning.DESKTOP / 'package.json'
        data = json.loads((self.root / package).read_text())
        data['version'] = '0.9.9'
        (self.root / package).write_text(json.dumps(data))
        generated = versioning.DESKTOP / 'src/app-version.ts'
        (self.root / generated).unlink()
        errors = versioning.check(self.root, '0.1.1')
        self.assertIn(str(package), errors)
        self.assertIn(str(generated), errors)

    def test_release_requires_a_dated_changelog_entry(self):
        for relative, content in versioning.render(self.root, '0.1.2').items():
            (self.root / relative).write_text(content)
        self.assertEqual(versioning.check(self.root, '0.1.2'), ['CHANGELOG.md: release entry or Unreleased missing'])

    def test_invalid_version_is_rejected_before_writing(self):
        before = {p: (self.root / p).read_bytes() for p in versioning.render(self.root, '0.1.1')}
        for invalid in ('0.01.2', '1.2', '1.2.3-01', '1.2.3\ninjected'):
            result = subprocess.run([sys.executable, str(self.root / 'scripts/version.py'), '--set', invalid], capture_output=True)
            self.assertNotEqual(result.returncode, 0)
            self.assertEqual(before, {p: (self.root / p).read_bytes() for p in before})
        self.assertTrue(versioning.valid_version('0.2.0-beta.1'))


if __name__ == '__main__':
    unittest.main()
