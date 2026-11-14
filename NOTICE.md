# Licencia y avisos de terceros

El código original de Jauria se distribuye bajo **GNU General Public License, versión 3 únicamente** (`GPL-3.0-only`), conforme a [LICENSE](LICENSE). Copyright (C) 2026 Jauria contributors. Jauria se ofrece sin garantía, según las condiciones de esa licencia.

La licencia del código propio no cambia los términos de bibliotecas, fuentes ni los derechos sobre la identidad de marca. Los archivos originales de terceros conservan sus licencias y avisos.

## Dependencias

Las dependencias se descargan desde npm y crates.io durante la compilación. Las bibliotecas directas, sus versiones e identificadores SPDX están en [DEPENDENCIES.md](docs/DEPENDENCIES.md); los lockfiles enumeran las dependencias transitivas. El repositorio no incluye código vendorizado ni adjunta binarios a sus releases actuales.

## Fuentes tipográficas

Bricolage Grotesque, Inter y JetBrains Mono se incluyen bajo SIL Open Font License 1.1. Sus textos originales se conservan en `experiments/tauri-vertical/desktop/public/brand/fuentes/LICENCIA-BricolageGrotesque-OFL.txt`, `LICENCIA-Inter-OFL.txt` y `LICENCIA-JetBrainsMono-OFL.txt`.

## Identidad de marca

La concesión GPLv3 del código no concede derechos de marca sobre el nombre Jauria, logotipos o símbolos de identidad. Los activos gráficos de `experiments/tauri-vertical/desktop/public/brand/`, salvo las fuentes identificadas arriba, conservan sus permisos originales; no se les asigna GPLv3 mediante este aviso. Para redistribuir esos activos o usarlos como identidad de otro producto, solicita autorización al titular correspondiente o sustitúyelos por una identidad propia.

Los activos originales conservan metadatos C2PA. Su índice de procedencia usa nombres portables y hashes. No se afirma que el cambio de licencia del código elimine metadatos ni modifique derechos de terceros.

## Distribución de binarios

El bundle incorpora `licenses/LICENSE` y `licenses/NOTICE.md`; el empaquetador DMG incluye la licencia, los avisos y una referencia a la fuente de la versión. Antes de redistribuir un binario, proporciona el código fuente correspondiente y los materiales de compilación de esa versión conforme a GPLv3. Un enlace a un repositorio privado que el destinatario no puede consultar no basta para ofrecer acceso a ese código.
