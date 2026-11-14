#!/usr/bin/env python3
"""Package an existing Jauria app without signing, accounts, or GUI automation."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import platform
import plistlib
import re
import shutil
import subprocess
import sys
import tempfile
from xml.parsers.expat import ExpatError

ROOT = Path(__file__).resolve().parents[1]
DEVELOPER_ID = 'anchor apple generic and certificate leaf[field.1.2.840.113635.100.6.1.13] exists'


class PackageError(Exception):
    pass


def command(argv, required=True):
    """Capture tool diagnostics: never publish account names from codesign output."""
    try:
        result = subprocess.run([str(arg) for arg in argv], capture_output=True,
                                text=True, check=False, timeout=300)
    except (OSError, subprocess.TimeoutExpired):
        if required:
            raise PackageError('No se pudo ejecutar ' + str(argv[0])) from None
        return None
    if required and result.returncode:
        raise PackageError('Falló la verificación o ejecución de ' + str(argv[0]))
    return result


def passed(result):
    return result is not None and result.returncode == 0


def release_version(root):
    version = (root / 'VERSION').read_text(encoding='utf-8').strip()
    if not re.fullmatch(r'(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)', version):
        raise PackageError('VERSION debe ser una versión estable X.Y.Z válida')
    return version


def regular_file(path, parent):
    if path.is_symlink() or not path.is_file():
        raise PackageError('Falta un archivo regular requerido del bundle')
    if not path.resolve().is_relative_to(parent):
        raise PackageError('Un archivo requerido sale del bundle')


def validate_app(app, version):
    if not app.is_absolute() or app.is_symlink() or app.suffix != '.app' or not app.is_dir():
        raise PackageError('--app debe ser una ruta absoluta a un .app existente, sin symlink en su raíz')
    app = app.resolve()
    info_path = app / 'Contents/Info.plist'
    regular_file(info_path, app)
    try:
        with info_path.open('rb') as stream:
            info = plistlib.load(stream)
    except (ValueError, TypeError, plistlib.InvalidFileException, ExpatError):
        raise PackageError('Info.plist inválido') from None
    if not isinstance(info, dict) or info.get('CFBundleName') != 'Jauria':
        raise PackageError('El producto del bundle debe ser Jauria')
    if info.get('CFBundleDisplayName', 'Jauria') != 'Jauria':
        raise PackageError('El nombre visible del bundle debe ser Jauria')
    if info.get('CFBundleShortVersionString') != version or info.get('CFBundleVersion') != version:
        raise PackageError('La versión del bundle no coincide con VERSION')
    executable = info.get('CFBundleExecutable')
    if not isinstance(executable, str) or not executable or executable in ('.', '..') or any(c in executable for c in '/\\\0'):
        raise PackageError('CFBundleExecutable inválido')
    for binary in (app / 'Contents/MacOS' / executable,
                   app / 'Contents/Resources/bin/aw-runner'):
        regular_file(binary, app)
        if not os.access(binary, os.X_OK):
            raise PackageError('Un binario requerido no es ejecutable')
        if command(['lipo', '-archs', binary]).stdout.strip().split() != ['arm64']:
            raise PackageError('Los binarios deben ser Mach-O exclusivamente arm64')
    # Framework symlinks inside the bundle are legitimate; dangling or escaping
    # links must never pull user files into the distribution.
    for directory, directories, files in os.walk(app, followlinks=False):
        for name in directories + files:
            entry = Path(directory) / name
            if entry.is_symlink():
                try:
                    resolved = entry.resolve(strict=True)
                except (OSError, RuntimeError):
                    raise PackageError('Symlink roto en el bundle') from None
                if not resolved.is_relative_to(app):
                    raise PackageError('Symlink fuera del bundle')
    return app


def signature_status(app):
    valid = passed(command(['codesign', '--verify', '--deep', '--strict', app], required=False))
    developer_id = valid and passed(command(
        ['codesign', '--verify', '--deep', '--strict', '-R', DEVELOPER_ID, app], required=False))
    # These checks inspect only the provided app. No keychain identities, login,
    # certificate import, signing operation, or credential lookup is performed.
    assessed = passed(command(['spctl', '--assess', '--type', 'execute', app], required=False)) if developer_id else False
    stapled = passed(command(['xcrun', 'stapler', 'validate', app], required=False)) if developer_id else False
    return {'signed': valid, 'developerIdSigned': developer_id,
            'notarized': developer_id and assessed and stapled,
            'gatekeeperAccepted': assessed, 'stapleValidated': stapled}


def output_directory(output, app):
    output = Path(os.path.abspath(output))
    if output == Path(output.anchor) or output == app or output.is_relative_to(app):
        raise PackageError('El destino no puede ser la raíz ni estar dentro del bundle')
    for entry in (output, *output.parents):
        if entry.is_symlink():
            raise PackageError('El destino no puede atravesar symlinks')
        if entry.exists() and not entry.is_dir():
            raise PackageError('El destino debe ser un directorio')
    return output


def sha256(path):
    digest = hashlib.sha256()
    with path.open('rb') as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b''):
            digest.update(chunk)
    return digest.hexdigest()


def package(app, output=None, require_notarized=False, root=ROOT):
    if platform.system() != 'Darwin' or platform.machine() != 'arm64':
        raise PackageError('Esta distribución requiere macOS Darwin/arm64')
    version = release_version(root)
    app = validate_app(Path(app), version)
    output = output_directory(output if output is not None else root / 'dist/macos', app)
    installation = root / 'docs/INSTALLATION.md'
    if not installation.is_file() or installation.is_symlink():
        raise PackageError('Falta docs/INSTALLATION.md')
    status = signature_status(app)
    if require_notarized and not status['notarized']:
        raise PackageError('Se requiere Developer ID válido, evaluación Gatekeeper y ticket stapled válido')
    label = 'notarized' if status['notarized'] else ('signed' if status['developerIdSigned'] else 'unsigned')
    filename = 'Jauria_{}_aarch64_{}.dmg'.format(version, label)
    names = [filename, 'SHA256SUMS', filename + '.receipt.json']
    # lexists also refuses dangling destination symlinks.
    if any(os.path.lexists(output / name) for name in names):
        raise PackageError('El destino ya contiene un artefacto, checksum o recibo; no se sobrescribe')
    output.mkdir(parents=True, exist_ok=True)
    published = []
    try:
        with tempfile.TemporaryDirectory(prefix='.jauria-package-', dir=output) as temporary:
            temporary = Path(temporary)
            payload = temporary / 'image'
            payload.mkdir()
            bundled_app = payload / 'Jauria.app'
            command(['ditto', app, bundled_app])
            # Validate the actual copied bundle, not just its source. Do not
            # transfer a successful signing label to a changed staging copy.
            validate_app(bundled_app, version)
            if signature_status(bundled_app) != status:
                raise PackageError('El estado de firma cambió al copiar el bundle')
            (payload / 'Applications').symlink_to('/Applications')
            shutil.copyfile(installation, payload / 'INSTALAR.txt')
            for relative in ('NOTICE.md', 'THIRD_PARTY_NOTICES.txt', 'THIRD_PARTY_NOTICES.md', 'docs/DEPENDENCIES.md'):
                notice = root / relative
                if notice.is_file() and not notice.is_symlink():
                    shutil.copyfile(notice, payload / notice.name)
            dmg = temporary / filename
            command(['hdiutil', 'create', '-volname', 'Jauria', '-srcfolder', payload,
                     '-format', 'UDZO', dmg])
            regular_file(dmg, temporary)
            command(['hdiutil', 'verify', dmg])
            checksum = sha256(dmg)
            (temporary / 'SHA256SUMS').write_text('{}  {}\n'.format(checksum, filename), encoding='utf-8')
            receipt = {'product': 'Jauria', 'version': version, 'arch': 'aarch64',
                       'machOArch': 'arm64', 'artifact': filename, 'sha256': checksum,
                       'format': 'UDZO', 'imageVerified': True,
                       'signatureScope': 'embedded-app', **status,
                       'dmgSigned': False, 'dmgNotarized': False}
            (temporary / names[2]).write_text(json.dumps(receipt, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
            # Hard-link publication is atomic and exclusive: even a racing writer
            # or symlink cannot be overwritten. All three sources are on this FS.
            for name in names:
                destination = output / name
                os.link(temporary / name, destination)
                published.append(destination)
    except BaseException:
        for destination in reversed(published):
            destination.unlink()
        raise
    return output / filename


def parser():
    result = argparse.ArgumentParser(description=__doc__)
    result.add_argument('--app', required=True, type=Path, help='Ruta absoluta del bundle Jauria.app')
    result.add_argument('--output', type=Path, help='Directorio de salida (predeterminado: ROOT/dist/macos)')
    result.add_argument('--require-notarized', action='store_true', help='Exigir firma Developer ID y notarización con ticket stapled')
    return result


def main(argv=None):
    args = parser().parse_args(argv)
    try:
        artifact = package(args.app, args.output, args.require_notarized)
    except (PackageError, OSError) as exc:
        # OSError filenames can contain account paths; keep the public diagnostic generic.
        print(str(exc) if isinstance(exc, PackageError) else 'Falló una operación de archivos del empaquetado', file=sys.stderr)
        return 1
    print('DMG verificado: ' + artifact.name)
    return 0


if __name__ == '__main__':
    sys.exit(main())
