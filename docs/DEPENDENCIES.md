# Dependencias directas

El código propio usa GPL-3.0-only. Las licencias de la tabla pertenecen a cada biblioteca y conservan sus términos; no quedan reemplazadas por la licencia de Jauria. Los lockfiles conservan las versiones transitivas. Las herramientas de build descargan los paquetes de sus registros con sus licencias originales. Este repositorio no incluye código vendorizado ni distribuye binarios.

| Biblioteca | Versión | Licencia declarada (SPDX) | Fuente |
| --- | --- | --- | --- |
| @tauri-apps/api | 2.12.4 | Apache-2.0 OR MIT | [registro](https://www.npmjs.com/package/@tauri-apps/api/v/2.12.4) |
| @tauri-apps/plugin-notification | 2.8.1 | Apache-2.0 OR MIT | [registro](https://www.npmjs.com/package/@tauri-apps/plugin-notification/v/2.8.1) |
| @xterm/addon-fit | 0.10.0 | MIT | [registro](https://www.npmjs.com/package/@xterm/addon-fit/v/0.10.0) |
| @xterm/xterm | 5.5.0 | MIT | [registro](https://www.npmjs.com/package/@xterm/xterm/v/5.5.0) |
| @tauri-apps/cli | 2.12.4 | Apache-2.0 OR MIT | [registro](https://www.npmjs.com/package/@tauri-apps/cli/v/2.12.4) |
| playwright | 1.65.0 | Apache-2.0 | [registro](https://www.npmjs.com/package/playwright/v/1.65.0) |
| esbuild | 0.25.12 | MIT | [registro](https://www.npmjs.com/package/esbuild/v/0.25.12) |
| typescript | 5.9.3 | Apache-2.0 | [registro](https://www.npmjs.com/package/typescript/v/5.9.3) |
| vite | 6.4.6 | MIT | [registro](https://www.npmjs.com/package/vite/v/6.4.6) |
| tauri | 2.12.5 | Apache-2.0 OR MIT | [registro](https://crates.io/crates/tauri/2.12.5) |
| tauri-build | 2.7.4 | Apache-2.0 OR MIT | [registro](https://crates.io/crates/tauri-build/2.7.4) |
| tauri-plugin-dialog | 2.8.4 | Apache-2.0 OR MIT | [registro](https://crates.io/crates/tauri-plugin-dialog/2.8.4) |
| tauri-plugin-notification | 2.8.1 | Apache-2.0 OR MIT | [registro](https://crates.io/crates/tauri-plugin-notification/2.8.1) |
| anyhow | 1.0.104 | MIT OR Apache-2.0 | [registro](https://crates.io/crates/anyhow/1.0.104) |
| base64 | 0.23.1 | MIT OR Apache-2.0 | [registro](https://crates.io/crates/base64/0.23.1) |
| libc | 0.2.191 | MIT OR Apache-2.0 | [registro](https://crates.io/crates/libc/0.2.191) |
| portable-pty | 0.9.0 | MIT | [registro](https://crates.io/crates/portable-pty/0.9.0) |
| rusqlite | 0.42.0 | MIT | [registro](https://crates.io/crates/rusqlite/0.42.0) |
| serde_json | 1.0.154 | MIT OR Apache-2.0 | [registro](https://crates.io/crates/serde_json/1.0.154) |
| sha2 | 0.10.9 | MIT OR Apache-2.0 | [registro](https://crates.io/crates/sha2/0.10.9) |
| tempfile | 3.27.0 | MIT OR Apache-2.0 | [registro](https://crates.io/crates/tempfile/3.27.0) |
| serde | 1.0.229 | MIT OR Apache-2.0 | [registro](https://crates.io/crates/serde/1.0.229) |

`esbuild` se declara directamente como dependencia de desarrollo para los tests de regresión sobre la implementación instalada de xterm; su uso transitivo por Vite no sustituye esa declaración.

`playwright` es una dependencia de desarrollo para regresiones DOM/rueda con xterm instalado. Sus navegadores de prueba se instalan explícitamente; no forman parte del bundle ni usan perfiles de usuario. Playwright WebKit no equivale a una prueba nativa de WKWebView.

## Alertas revisadas para macOS Apple Silicon

Vite se actualiza de 6.4.1 a 6.4.6; `npm audit` no reporta vulnerabilidades en el snapshot actualizado. Es una herramienta de desarrollo y compilación, no un servidor incluido en el bundle release.

El lockfile Rust contiene GLib 0.18.5, afectado por [GHSA-wrw7-89jp-8q8g](https://github.com/advisories/GHSA-wrw7-89jp-8q8g) / [RUSTSEC-2024-0429](https://rustsec.org/advisories/RUSTSEC-2024-0429.html). GTK 0.18.2 y WebKitGTK requieren GLib `^0.18`; subir solo esa biblioteca a 0.20 no constituye una corrección compatible. Esas dependencias están condicionadas a Linux/BSD y no forman parte del grafo soportado `aarch64-apple-darwin`, que usa WebKit de macOS. Se conserva la alerta, sin declararla corregida ni ocultarla para futuras plataformas. La evidencia y el alcance están en [PUBLICATION_READINESS.md](PUBLICATION_READINESS.md).

## Verificación de declaraciones transitivas

La revisión del SBOM y de los manifests encontró tres identificadores de licencia mal normalizados. Se contrastaron con los archivos originales, sin reemplazarlos por una interpretación automática del carácter `/`:

| Paquete | Declaración original | Avisos que se conservan |
| --- | --- | --- |
| dbus 0.9.12 | `Apache-2.0/MIT` | LICENSE-APACHE y LICENSE-MIT; el README declara licencia dual. |
| libdbus-sys 0.2.7 | `Apache-2.0/MIT` | Ambos avisos para los bindings. Su código vendorizado tiene condiciones diferentes: COPYING de dbus indica AFL-2.1 o GPL-2.0-or-later y menciona herramientas GPL. No se asigna una sola licencia a todo el paquete. |
| brotli-decompressor 6.3.1 | `BSD-3-Clause/MIT` | LICENSE con BSD de tres cláusulas y aviso MIT en src/context.rs; se conservan ambos sin convertir la declaración en `OR`. |

El grafo macOS revisado incluye cinco crates declarados MPL-2.0: cssparser, cssparser-macros, selectors, dtoa-short y option-ext. No se encontró un aviso concreto que marque ese código como incompatible con licencias secundarias; el texto de Exhibit B dentro de una copia de MPL no demuestra por sí solo que tal aviso se haya aplicado al código. Se mantienen los términos y avisos MPL correspondientes. Esto es una revisión acotada de declaraciones, no una certificación legal de todas las dependencias.
