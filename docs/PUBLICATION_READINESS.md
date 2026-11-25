# Preparación para publicar el repositorio

Alcance de la revisión histórica de 1.0.1: licencia del código, dependencias y exposición de datos. En ese corte no se cambió la visibilidad del repositorio ni se publicó el instalador. La reparación de CI es un trabajo separado; una preparación de estos puntos no acredita CI aprobado. Las revisiones posteriores (1.3.0, 1.3.2 y la preparación de 1.4.0) se registran al final.

## Licencia

El titular eligió GPLv3 para el código original. Se incorpora GNU GPL versión 3 únicamente (`GPL-3.0-only`), con el texto íntegro obtenido de [GNU](https://www.gnu.org/licenses/gpl-3.0.txt), metadatos npm/Cargo y [NOTICE](../NOTICE.md). Las bibliotecas, tipografías y derechos de marca conservan condiciones separadas. Las etiquetas anteriores mantienen su contenido histórico; la licencia explícita se incorpora en 1.0.1.

## Dependencias

- Vite: 6.4.1 → 6.4.6; nueve alertas npm iniciales, incluidas dos altas, dejan de aparecer en `npm audit` del snapshot actualizado. Dependabot debe reevaluar el lockfile al recibir el cambio.
- GLib: 0.18.5 permanece en Cargo.lock por GTK/WebKitGTK de Linux/BSD. `cargo tree --offline --locked --target aarch64-apple-darwin -i glib` no encuentra dependientes; el grafo resuelto de macOS tampoco contiene GTK. No se sustituye por una versión incompatible con GTK `^0.18` ni se suprime la alerta global. Si se amplían plataformas, esta justificación debe revisarse.
- Los metadatos SPDX del SBOM se contrastaron con las 491 dependencias de la unión de ambos lockfiles Rust, excluyendo los paquetes propios. Se revisaron las tres declaraciones mal normalizadas y los cinco crates MPL del grafo macOS; [DEPENDENCIES.md](DEPENDENCIES.md) delimita la evidencia. No se encontró una incompatibilidad concreta en ese alcance, pero esto no equivale a una certificación legal completa ni relicencia las dependencias bajo GPL.

## Historial, archivos y metadatos

Snapshot revisado inicialmente: `ee2d80e`, junto con sus ramas y etiquetas alcanzables. La revisión usa Gitleaks 8.30.1, reglas predeterminadas y redacción completa, más inspección de nombres, URLs y metadatos. No se ejecuta el código objetivo para buscar secretos ni se guardan valores de credenciales en este registro.

| Superficie | Alcance y resultado |
| --- | --- |
| Todas las refs locales del snapshot | 19 commits y 288 blobs; sin credenciales detectadas y sin blobs omitidos por tamaño. |
| `origin/main`, `v0.1.1` y `v1.0.0` | 16 commits y 283 blobs; sin credenciales detectadas. |
| Refs solo locales | Tres commits y cinco blobs adicionales; no se dan por publicados. |
| Mensajes y etiquetas | Sin credenciales detectadas. Hay una identidad de autor con nombre y correo en commits y etiquetas. |
| Recursos de marca y documentación | 38 archivos inspeccionados; 23 assets con C2PA. No se detectaron rutas personales ni identidad del propietario en esos metadatos. |
| Imágenes del README | Inspección visual: carpetas y datos de demostración; no se muestran sesiones privadas. |
| URLs, archivos y enlaces | Sin URLs con credenciales, nombres de archivos de credenciales ni symlinks/gitlinks detectados en el alcance revisado. |

La autoría Git no es una credencial. Publicar el repositorio expondría ese nombre y correo; corresponde al propietario decidir si los conserva. Esta revisión no reescribe commits ni etiquetas y no cambia la identidad de autor. Los valores personales no se reproducen en este documento.

Un escáner sin hallazgos no demuestra ausencia absoluta de secretos. Estos resultados se limitan a las refs, archivos y reglas descritos; no incluyen directorios ajenos al repositorio, datos de usuarios ni perfiles de proveedores.

## Releases y GitHub Actions

La consulta de GitHub del snapshot publicado encontró dos releases (`v0.1.1` y `v1.0.0`) sin assets adjuntos y cero artefactos de Actions. Se revisaron siete ejecuciones registradas, todas con `startup_failure` y cero trabajos creados. Los endpoints de logs de esas siete ejecuciones no ofrecieron archivos descargables. Esta ausencia no se presenta como validación de CI.

El DMG se mantiene local. No se adjuntan tokens, bases SQLite, perfiles, prompts, transcripciones ni evidencia privada a la publicación. Las comprobaciones futuras deben incluir cualquier nueva release, artefacto o ejecución que aparezca después de este snapshot.

## Pendientes antes del cambio de visibilidad

1. Decidir sobre la exposición de la identidad de autor ya presente en el historial.
2. Resolver o documentar por separado el fallo de arranque de Actions; no se afirma CI aprobado.
3. Confirmar que no se han añadido datos privados después de esta revisión.
4. Ejecutar el cambio de visibilidad solo con una instrucción explícita del propietario.

La firma Developer ID y la notarización afectan a la distribución del instalador macOS; no son requisitos para publicar el código fuente en GitHub.

## Revisión acotada antes de integrar 1.3.0 en main

Fecha: 17 de noviembre de 2026. Base revisada: `861bd59` y sus nueve commits desde `70e7c96` (último `main` antes de la integración). El repositorio de GitHub está **público**; el instalador 1.3.0 permanece local. Esta revisión se limita a exposición en el repositorio y a los límites de Pulso/MCP; **no es una auditoría completa del producto ni una certificación de ausencia de vulnerabilidades**. Los cambios posteriores en documentación se vuelven a escanear antes de publicarlos.

- Gitleaks 8.30.1 con reglas predeterminadas, `--all` y redacción completa: cero hallazgos en las refs locales. Los archivos rastreados no contienen el prefijo absoluto del perfil del desarrollador ni valores obvios de claves privadas. `.runtime`, bases SQLite, perfiles, logs y bundles se mantienen ignorados; la inspección de reglas y rutas no prueba que todo dato sensible sea detectable.
- El MCP `jauria-pulso` por `stdio` no contiene credenciales en su configuración. La sesión nueva recibe variables con la ruta del cliente y del permiso; el servicio local exige UID igual, token de cliente, sesión viva y alcance de proyecto. Los permisos recordados requieren acción explícita. Las operaciones de lectura filtran por proyecto antes de paginar y `board` se reserva a la UI. Los textos del servidor limitan errores devueltos. No se probó un ataque contra procesos del mismo usuario.
- La instrucción CLI copiada a una conversación incluye la ruta absoluta del archivo de permiso, no su token. Esa ruta se transmite al proveedor al pegarla; se documenta y se recomienda el MCP para sesiones nuevas si se quiere evitar incluirla en el prompt.
- `npm audit --package-lock-only --ignore-scripts --omit=dev` informó cero alertas. El análisis sin `--omit=dev` informó cuatro entradas altas derivadas de **una** advisory de `picomatch 4.0.7`, [GHSA-fc5q-39xc-vjpf](https://github.com/advisories/GHSA-fc5q-39xc-vjpf), sin parche declarado; está en la cadena de compilación Vite, no en `dependencies` de ejecución. No se fuerza el downgrade sugerido de Vite porque 6.4.6 corrige la [advisory crítica de su servidor de desarrollo](https://github.com/vitejs/vite/security/advisories/GHSA-p4f5-76q4-ffq7). El dev server de Jauria se limita a loopback. Se debe reevaluar la alerta cuando exista una versión corregida.
- `tauri 2.12.5` supera las versiones afectadas por [GHSA-w28w-mhc8-qvjv](https://github.com/tauri-apps/tauri/security/advisories/GHSA-w28w-mhc8-qvjv). GLib 0.18.5 sigue en el lockfile pero `cargo tree --offline --locked --target aarch64-apple-darwin -i glib` no encontró dependientes. La única alerta abierta de Dependabot consultada antes de integrar era GLib; GitHub puede reevaluar al actualizar `main`.

No se incorporaron al repositorio las credenciales de Claude Code, el perfil real, el permiso Pulso ni la copia local del instalador. El registro local de MCP en la cuenta del desarrollador es una configuración de uso, no un archivo del proyecto.

## Revisión acotada para la release 1.3.2

Fecha: 18 de noviembre de 2026. Alcance: cambios desde 1.3.1, nuevas capturas sintéticas y bundle/DMG Apple Silicon. Esta revisión de exposición no es una auditoría completa.

- La primera compilación release contenía rutas del equipo de build en ubicaciones de pánico de Rust. Se descartó ese DMG antes de publicar. `scripts/build-macos.py` ahora remapea rutas de fuente, Cargo y carpeta personal; `scripts/package-macos.py` rechaza rutas absolutas `/Users/<cuenta>/` en el bundle. El DMG definitivo se montó en solo lectura y la inspección del bundle encontró cero coincidencias de ese patrón.
- Las cinco imágenes nuevas fueron capturadas con un runner sintético. Se inspeccionaron visualmente: no muestran sesiones, proyectos ni carpetas personales. Ninguna contiene chunks PNG de texto o EXIF. Se eliminaron las cuatro capturas reemplazadas que ya no tenían referencias.
- Gitleaks con redacción completa no detectó secretos en el diff de código y documentación; se vuelve a escanear el commit completo antes de publicar. `npm audit --package-lock-only --ignore-scripts`, con y sin `--omit=dev`, informó cero alertas el día de la entrega.
- GitHub mantiene una alerta moderada para GLib en el lockfile Rust. `cargo tree --offline --locked --target aarch64-apple-darwin -i glib` no encontró ese paquete en el destino macOS soportado. La alerta no se declara corregida para Linux/BSD.
- El DMG verificado contiene LICENSE, NOTICE, la guía de instalación y referencia al código fuente de la misma versión. No incluye el perfil de datos del usuario. No hay firma Developer ID ni notarización, y no se probó Gatekeeper en otro Mac.

## Preparación de 1.4.0

Fecha: 23 de noviembre de 2026. Rama `feat/redesign-1.4`, con `VERSION` 1.4.0; sin fusionar en `main`, sin etiqueta, DMG ni release. Esta sección registra lo que cambió respecto a 1.3.3 y lo que **todavía no se ha verificado**; no declara la entrega lista.

- **Suites que ejecuta el build.** `scripts/build-macos.py` ejecuta los tests Python, `node --test tests/*.test.ts`, **todas las suites de navegador** mediante `scripts/browser-tests.py` (Chrome instalado y Playwright WebKit: `tests/browser/*`, `pulso-panel`, Configuración y permisos, `attention-consistency` y `terminal-stream` en los dos motores), los tests Rust del runner con las suites `rpc`, `storage_retention`, `terminal_stream_rpc`, `app_settings`, `session_preferences_rpc`, `pulso_rpc`, `native_resume_rpc`, `legacy_profile_rpc` y `agent_attention_rpc` (las mediciones quedan ignoradas) y `cargo test --locked` del puente nativo. `--skip-browser-tests` omite las de navegador y lo escribe en la salida; un build así no valida la interfaz. Los resultados de la rama antes del build y el marcador para los del build están en [las notas de 1.4.0](RELEASE_1.4.0.md#verificación-de-la-entrega).
- **CI sin verificar.** `.github/workflows/macos.yml` instala Playwright WebKit y ejecuta el mismo `build-macos.py`, pero **no se ha ejecutado aún con las suites de navegador**. Los antecedentes (los arranques fallidos registrados arriba y el bloqueo de facturación de 1.3.1 descrito en [las notas de 1.3.2](RELEASE_1.3.2.md#verificación-y-límites)) siguen siendo motivo para no dar el CI por aprobado sin la lista de checks de la ejecución.
- **Frontera sintética.** Las pruebas de interfaz simulan el puente Tauri; por eso no detectaron que la app 1.3.3 no podía guardar Configuración. 1.4.0 lo corrige y añade una tabla de contrato que se comprueba contra el puente y el runner, pero la validación en la app empaquetada (Guardar Configuración contra el runner real, avisos de macOS y visto automático con el cajón lateral) sigue pendiente.
- **Funciones retiradas.** Repositorios y tareas Git (registro, worktree por tarea, revisión, verificación con confirmación nativa y relevo) ya no existen: el runner responde `unknown operation` a esas operaciones y `status` deja de anunciarlas. Menos superficie expuesta; los datos antiguos del perfil se conservan sin leerse y no se borran worktrees ni ramas.
- **Datos nuevos.** `status` y `terminal_live` publican el estado declarado y los cursores de avisos de cada sesión, sin texto del terminal, títulos ni rutas. `sidebar_summary` y el pie de tarjeta de `board` quedan reservados a la credencial de la interfaz; un permiso de agente recibe `unauthorized`.
- **Capturas.** Las diez capturas `docs/screenshots/*-1.4.0*.png` se generaron con el frontend real y una frontera Tauri sintética (rutas `/Users/demo/…` y `/synthetic/…` inventadas), se inspeccionaron visualmente y no contienen chunks PNG de texto ni EXIF. Las capturas históricas se conservan.
- **Pendiente antes de publicar (cerrado el 25 de noviembre, ver «Publicación de 1.4.0»).** Gitleaks y `npm audit` no se habían vuelto a ejecutar sobre los cambios de 1.4. La alerta de Dependabot por GLib 0.18.5 sigue igual que en 1.3.3 (grafo Linux/BSD; `cargo tree --offline --locked --target aarch64-apple-darwin -i glib` no encuentra dependientes). El DMG seguirá sin firma Developer ID ni notarización. Las revisiones de cada entrega con Codex no son una auditoría integral de seguridad.

## Publicación de 1.4.0

Fecha: 25 de noviembre de 2026. La rama `feat/redesign-1.4` se fusionó en `main` (commit de fusión `6db3a20`) y la entrega se etiquetó `v1.4.0`.

- **CI.** «macOS native checks» (job `native`, con las suites de navegador en Chrome y WebKit) pasó en sus dos ejecuciones, push y pull request, sobre `eae6670`. Antes hubo ejecuciones fallidas por cinco pruebas sensibles al tiempo del runner de GitHub (paridad de xterm, eco de tecla, línea base de desplazamiento, foco al cerrar un diálogo y geometría inicial); se corrigieron las pruebas, no el producto. La ejecución de `main` sobre el commit de fusión `6db3a20` falló en `terminal-scroll` por la misma causa (una lectura única del desplazamiento tras una pausa fija); la prueba ahora espera la condición, y la etiqueta `v1.4.0` se pone sobre un commit con sus checks en pass.
- **Secretos.** Gitleaks con redacción completa sobre los 171 commits de `v1.3.3..6db3a20`: sin hallazgos.
- **Dependencias.** `npm audit --package-lock-only --ignore-scripts`, con y sin `--omit=dev`: cero alertas. `cargo tree --offline --locked --target aarch64-apple-darwin -i glib` sigue sin encontrar GLib en el destino macOS, en el runner y en el puente; la alerta de Dependabot no se declara corregida para Linux/BSD.
- **Paquete.** `Jauria_1.4.0_aarch64_unsigned.dmg`, SHA-256 `ff21cd4f7ea1ed9137993d7cd8a76061a5efa3ac93d6eded833788eb52db32b3`, con `SHA256SUMS` y recibo JSON. Contiene la app, LICENSE, NOTICE, la guía de instalación, la referencia al código fuente y `docs/DEPENDENCIES.md`; no incluye ningún perfil de datos. Sin firma Developer ID ni notarización; no se probó Gatekeeper en otro Mac.
- **App real.** Con el build empaquetado instalado, una sesión de Claude Code y otra de Codex registraron «Trabajando» y «Turno terminado». Siguen sin comprobar en la app real: «Te necesita» ante un permiso, el clic en una notificación de macOS, Guardar Configuración contra el runner real y la lectura de ajustes por un runner 1.3.3.
- Las revisiones con Codex de esta entrega no son una auditoría integral de seguridad.
