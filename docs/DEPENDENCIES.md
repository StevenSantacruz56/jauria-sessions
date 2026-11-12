# Dependencias directas

Las licencias declaradas pertenecen a cada biblioteca; no asignan licencia al código propio. Los lockfiles conservan las versiones transitivas. Las herramientas de build descargan los paquetes de sus registros con sus licencias originales. Este repositorio no incluye código vendorizado ni distribuye binarios.

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
| vite | 6.4.1 | MIT | [registro](https://www.npmjs.com/package/vite/v/6.4.1) |
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
