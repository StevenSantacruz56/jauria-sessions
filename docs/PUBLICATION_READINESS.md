# Preparación para publicar el repositorio

Alcance de esta revisión: licencia del código, dependencias y exposición de datos. No se cambia la visibilidad del repositorio ni se publica el instalador. La reparación de CI es un trabajo separado; una preparación de estos puntos no acredita CI aprobado.

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
