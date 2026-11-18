import hashlib
import importlib.util
import json
from pathlib import Path
import plistlib
import shutil
import subprocess
import tempfile
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('package_macos', ROOT / 'scripts/package-macos.py')
packaging = importlib.util.module_from_spec(spec)
spec.loader.exec_module(packaging)


class PackageTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory(prefix='jauria-package-test-')
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name).resolve()
        (self.root / 'VERSION').write_text('1.0.0\n')
        (self.root / 'docs').mkdir()
        (self.root / 'docs/INSTALLATION.md').write_text('Instalar Jauria')
        (self.root / 'NOTICE.md').write_text('Avisos de terceros')
        self.license_bytes = (ROOT / 'LICENSE').read_bytes()
        (self.root / 'LICENSE').write_bytes(self.license_bytes)
        (self.root / 'THIRD_PARTY_NOTICES.txt').write_text('Otros avisos')
        (self.root / 'docs/DEPENDENCIES.md').write_text('Dependencias')
        self.app = self.root / 'Jauria.app'
        self.info = {'CFBundleName': 'Jauria', 'CFBundleShortVersionString': '1.0.0',
                     'CFBundleVersion': '1.0.0', 'CFBundleExecutable': 'Jauria'}
        for relative in ('Contents/MacOS/Jauria', 'Contents/Resources/bin/aw-runner'):
            binary = self.app / relative
            binary.parent.mkdir(parents=True, exist_ok=True)
            binary.write_bytes(b'fake arm64 binary')
            binary.chmod(0o755)
        self.write_info()
        self.output = self.root / 'out'
        self.arch = 'arm64'
        self.signed = False
        self.developer_id = False
        self.assessed = False
        self.stapled = False
        self.fail = None
        self.calls = []
        for target, replacement in [('platform.system', lambda: 'Darwin'),
                                     ('platform.machine', lambda: 'arm64'),
                                     ('subprocess.run', self.fake_tool)]:
            mock = patch.object(packaging.platform, target.split('.')[1], replacement) if target.startswith('platform.') else patch.object(packaging.subprocess, 'run', replacement)
            mock.start()
            self.addCleanup(mock.stop)

    def write_info(self):
        with (self.app / 'Contents/Info.plist').open('wb') as stream:
            plistlib.dump(self.info, stream)

    def fake_tool(self, argv, **kwargs):
        self.calls.append(argv)
        tool = argv[0]
        code, stdout = 0, ''
        if tool == 'lipo':
            stdout = self.arch + '\n'
        elif tool == 'codesign':
            code = 0 if (self.developer_id if '-R' in argv else self.signed) else 1
        elif tool == 'spctl':
            code = 0 if self.assessed else 1
        elif tool == 'xcrun':
            code = 0 if self.stapled else 1
        elif tool == 'ditto':
            shutil.copytree(argv[1], argv[2])
        elif tool == 'hdiutil' and argv[1] == 'create':
            payload = Path(argv[argv.index('-srcfolder') + 1])
            self.assertEqual((payload / 'Applications').readlink(), Path('/Applications'))
            self.assertEqual((payload / 'INSTALAR.txt').read_text(), 'Instalar Jauria')
            self.assertEqual((payload / 'NOTICE.md').read_text(), 'Avisos de terceros')
            self.assertEqual((payload / 'LICENSE').read_bytes(), self.license_bytes)
            self.assertEqual((payload / 'THIRD_PARTY_NOTICES.txt').read_text(), 'Otros avisos')
            self.assertEqual((payload / 'docs/DEPENDENCIES.md').is_file(),
                             (self.root / 'docs/DEPENDENCIES.md').is_file())
            if (self.root / 'docs/DEPENDENCIES.md').is_file():
                self.assertEqual((payload / 'docs/DEPENDENCIES.md').read_text(), 'Dependencias')
            self.assertFalse((payload / 'DEPENDENCIES.md').exists())
            reference = (payload / 'SOURCE_REFERENCE.txt').read_text(encoding='utf-8')
            version = self.info['CFBundleShortVersionString']
            repository = 'https://github.com/StevenSantacruz56/jauria-sessions'
            self.assertIn(repository + '/tree/v' + version + '\n', reference)
            self.assertIn(repository + '/archive/refs/tags/v' + version + '.tar.gz\n', reference)
            for required in ('GPL-3.0-only', 'no una oferta escrita vinculante',
                             'ni una entrega automática', 'No certifica el cumplimiento',
                             'Antes de redistribuir', 'Corresponding Source'):
                self.assertIn(required, reference)
            expected = ['Applications', 'INSTALAR.txt', 'Jauria.app', 'LICENSE', 'NOTICE.md',
                        'SOURCE_REFERENCE.txt', 'THIRD_PARTY_NOTICES.txt']
            if (self.root / 'docs/DEPENDENCIES.md').is_file():
                expected.append('docs')
            self.assertEqual(sorted(p.name for p in payload.iterdir()), expected)
            self.assertEqual(argv[argv.index('-format') + 1], 'UDZO')
            Path(argv[-1]).write_bytes(b'simulated image, not an actual DMG')
        if self.fail == (tool, argv[1]):
            code = 1
        return subprocess.CompletedProcess(argv, code, stdout, 'private account diagnostic')

    def package(self, **kwargs):
        return packaging.package(self.app, self.output, root=self.root, **kwargs)

    def test_unsigned_package_checksum_receipt_and_no_overwrite(self):
        artifact = self.package()
        self.assertEqual(artifact.name, 'Jauria_1.0.0_aarch64_unsigned.dmg')
        digest = hashlib.sha256(artifact.read_bytes()).hexdigest()
        self.assertEqual((self.output / 'SHA256SUMS').read_text(), digest + '  ' + artifact.name + '\n')
        receipt_text = (self.output / (artifact.name + '.receipt.json')).read_text()
        receipt = json.loads(receipt_text)
        self.assertEqual((receipt['version'], receipt['arch'], receipt['sha256']), ('1.0.0', 'aarch64', digest))
        self.assertFalse(receipt['signed'])
        self.assertFalse(receipt['notarized'])
        self.assertFalse(receipt['dmgSigned'])
        self.assertNotIn('private account', receipt_text)
        self.assertIn(['hdiutil', 'verify', str(next(c[-1] for c in self.calls if c[:2] == ['hdiutil', 'create']))], self.calls)
        with self.assertRaises(packaging.PackageError):
            self.package()
        self.assertEqual(len(list(self.output.iterdir())), 3)

    def test_development_signature_remains_unsigned_distribution(self):
        self.signed = True
        artifact = self.package()
        self.assertTrue(artifact.name.endswith('_unsigned.dmg'))
        receipt = json.loads((self.output / (artifact.name + '.receipt.json')).read_text())
        self.assertTrue(receipt['signed'])
        self.assertFalse(receipt['developerIdSigned'])

    def test_rejects_binary_with_builder_home_path(self):
        binary = self.app / 'Contents/MacOS/Jauria'
        binary.write_bytes(binary.read_bytes() + b'/Users/example/secret-worktree/src/main.rs')
        with self.assertRaisesRegex(packaging.PackageError, 'ruta absoluta'):
            self.package()
        self.assertFalse(self.output.exists())

    def test_notarization_requires_all_three_checks_before_image_creation(self):
        self.signed = self.developer_id = self.assessed = self.stapled = True
        artifact = self.package(require_notarized=True)
        self.assertTrue(artifact.name.endswith('_notarized.dmg'))
        receipt = json.loads((self.output / (artifact.name + '.receipt.json')).read_text())
        self.assertTrue(receipt['notarized'])
        create_index = next(i for i, c in enumerate(self.calls) if c[:2] == ['hdiutil', 'create'])
        self.assertTrue(any(c[:3] == ['xcrun', 'stapler', 'validate'] for c in self.calls[:create_index]))
        self.assertFalse(any('--sign' in c for c in self.calls))

    def test_require_notarized_failure_never_creates_artifact(self):
        for missing in ('signed', 'developer_id', 'assessed', 'stapled'):
            self.signed = self.developer_id = self.assessed = self.stapled = True
            setattr(self, missing, False)
            with self.subTest(missing=missing), self.assertRaises(packaging.PackageError):
                self.package(require_notarized=True)
            self.assertFalse(self.output.exists())
        self.assertFalse(any(c[0] == 'hdiutil' for c in self.calls))

    def test_invalid_host_version_plist_and_architecture_fail(self):
        for target, value in [('system', 'Linux'), ('machine', 'x86_64')]:
            with patch.object(packaging.platform, target, return_value=value), self.assertRaises(packaging.PackageError):
                self.package()
        for version in ('../escape', '1.0', '01.0.0', '1.0.0\ninjected'):
            (self.root / 'VERSION').write_text(version)
            with self.assertRaises(packaging.PackageError):
                self.package()
        (self.root / 'VERSION').write_text('1.0.0')
        for field, value in [('CFBundleName', 'Other'), ('CFBundleShortVersionString', '0.9.0'),
                             ('CFBundleVersion', '0.9.0'), ('CFBundleExecutable', '../outside')]:
            saved = self.info[field]
            self.info[field] = value
            self.write_info()
            with self.assertRaises(packaging.PackageError):
                self.package()
            self.info[field] = saved
        self.write_info()
        (self.app / 'Contents/Info.plist').write_text('<?xml version="1.0"?><plist><broken>')
        with self.assertRaises(packaging.PackageError):
            self.package()
        self.write_info()
        for self.arch in ('x86_64', 'x86_64 arm64', ''):
            with self.assertRaises(packaging.PackageError):
                self.package()
        self.assertFalse(self.output.exists())

    def test_invalid_paths_missing_binary_and_symlink_rejected(self):
        with self.assertRaises(packaging.PackageError):
            packaging.package(Path('relative.app'), self.output, root=self.root)
        alias = self.root / 'Alias.app'
        alias.symlink_to(self.app, target_is_directory=True)
        with self.assertRaises(packaging.PackageError):
            packaging.package(alias, self.output, root=self.root)
        runner = self.app / 'Contents/Resources/bin/aw-runner'
        runner.unlink()
        with self.assertRaises(packaging.PackageError):
            self.package()
        runner.symlink_to('/bin/sh')
        with self.assertRaises(packaging.PackageError):
            self.package()
        self.assertFalse(self.output.exists())

    def test_unsafe_outputs_and_existing_symlink_never_overwritten(self):
        alias = self.root / 'alias'
        alias.symlink_to(self.root, target_is_directory=True)
        for output in (Path('/'), self.app / 'output', alias / 'out'):
            with self.assertRaises(packaging.PackageError):
                packaging.package(self.app, output, root=self.root)
        self.output.mkdir()
        checksum = self.output / 'SHA256SUMS'
        checksum.symlink_to(self.root / 'missing')
        with self.assertRaises(packaging.PackageError):
            self.package()
        self.assertTrue(checksum.is_symlink())
        self.assertFalse((self.root / 'missing').exists())

    def test_tool_failure_does_not_publish_partial_release(self):
        for self.fail in (('ditto', str(self.app)), ('hdiutil', 'create'), ('hdiutil', 'verify')):
            with self.subTest(failure=self.fail), self.assertRaises(packaging.PackageError):
                self.package()
            self.assertEqual(list(self.output.iterdir()), [])

    def test_default_output_and_arguments(self):
        artifact = packaging.package(self.app, root=self.root)
        self.assertEqual(artifact.parent, self.root / 'dist/macos')
        args = packaging.parser().parse_args(['--app', str(self.app), '--require-notarized'])
        self.assertEqual(args.app, self.app)
        self.assertTrue(args.require_notarized)
        with patch('sys.stderr'), self.assertRaises(SystemExit):
            packaging.parser().parse_args([])

    def test_optional_dependencies_notice_can_be_absent(self):
        (self.root / 'docs/DEPENDENCIES.md').unlink()
        self.assertTrue(self.package().is_file())

    def test_missing_invalid_or_symlink_license_fails_before_image_creation(self):
        license_path = self.root / 'LICENSE'
        license_path.unlink()
        for kind in ('missing', 'directory', 'empty', 'symlink', 'dangling-symlink'):
            with self.subTest(kind=kind):
                if kind == 'directory':
                    license_path.mkdir()
                elif kind == 'empty':
                    license_path.write_bytes(b'')
                elif kind == 'symlink':
                    license_path.symlink_to(ROOT / 'LICENSE')
                elif kind == 'dangling-symlink':
                    license_path.symlink_to(self.root / 'missing-license')
                with self.assertRaisesRegex(packaging.PackageError, 'LICENSE'):
                    self.package()
                self.assertFalse(self.output.exists())
                self.assertFalse(any(call[0] == 'hdiutil' for call in self.calls))
                if kind == 'directory':
                    license_path.rmdir()
                elif kind != 'missing':
                    license_path.unlink()

    def test_version_bump_updates_artifact_receipt_and_source_urls(self):
        (self.root / 'VERSION').write_text('1.0.1\n')
        self.info['CFBundleVersion'] = self.info['CFBundleShortVersionString'] = '1.0.1'
        self.write_info()
        artifact = self.package()  # mock checks both URLs in the actual image payload
        self.assertEqual(artifact.name, 'Jauria_1.0.1_aarch64_unsigned.dmg')
        receipt = json.loads((self.output / (artifact.name + '.receipt.json')).read_text())
        self.assertEqual(receipt['version'], '1.0.1')


if __name__ == '__main__':
    unittest.main()
