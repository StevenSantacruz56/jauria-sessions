# Seguridad y privacidad

Jauria ejecuta herramientas locales en las carpetas elegidas por el usuario. Los permisos guardados de Codex y Claude Code conservan el alcance que define cada proveedor; Jauria no copia aprobaciones entre proyectos ni convierte una autorización temporal en permanente.

## Reportar una vulnerabilidad

Consulta primero la versión actual de [VERSION](VERSION) y [las notas de entrega](CHANGELOG.md). Si GitHub muestra **Security → Report a vulnerability**, usa ese canal privado. Si todavía no está habilitado, contacta con el responsable del repositorio por un canal privado previamente acordado. No publiques detalles explotables ni secretos en issues.

Incluye versión, plataforma, impacto y una reproducción mínima con datos ficticios en un repositorio desechable. No adjuntes credenciales, bases SQLite, perfiles de proveedores, prompts, transcripciones ni logs sin revisar. No se ofrece un plazo de respuesta o SLA de seguridad.

## Datos que deben permanecer locales

Los tokens del runner, la autenticación de proveedores, el historial de sesiones y los datos del usuario quedan fuera del repositorio y del instalador. `.gitignore` previene incorporaciones accidentales; no elimina datos que ya formen parte del historial Git.

## Pulso y su MCP local

Registrar `jauria-pulso` en Claude Code o Codex solo descubre herramientas: no concede acceso. El runner exige una sesión viva y un permiso explícito de **Configuración → Permisos de agentes**, limitado a un proyecto o a la creación de proyectos propios. El servidor usa un socket Unix local con comprobación del usuario del proceso; la UI, el cliente del agente y el runner usan credenciales separadas. Los archivos de permiso deben pertenecer al usuario y tener permisos privados; revocar o terminar la sesión invalida el acceso. Una política recordada requiere elección explícita y queda ligada al proveedor y a la carpeta canónica.

La configuración MCP contiene referencias a variables de entorno, no el valor del token. **Copiar instrucciones para el agente** sí incluye una ruta absoluta al archivo de permiso, sin su contenido; al pegarla en la conversación se comparte esa ruta con el proveedor. No compartas el archivo, el perfil, bases SQLite ni transcripciones. Las herramientas autorizadas pueden enviar al proveedor el contenido del proyecto al que concediste acceso. El MCP no es un aislamiento entre procesos del mismo usuario de macOS. Consulta [el alcance de Pulso](docs/PULSO.md#privacidad-permisos-y-límites).

Antes de cambiar la visibilidad, revisa historial, etiquetas, archivos y artefactos de CI. La autoría de commits puede incluir información personal aunque no contenga credenciales. El [registro de preparación para publicación](docs/PUBLICATION_READINESS.md) delimita la revisión realizada y sus límites.

## Dependencias y alcance de plataforma

Las alertas de desarrollo y las de código incluido en el producto se evalúan por separado, sin asumir que una alerta del lockfile sea alcanzable en todos los targets. La versión soportada actualmente es macOS Apple Silicon; no se distribuye Linux, BSD, Intel ni Windows.

Vite 6.4.6 reemplaza la versión afectada 6.4.1. En la revisión del 17 de noviembre, `npm audit --omit=dev` no reportó alertas; el análisis completo reportó cuatro entradas altas por la cadena de desarrollo Vite → `tinyglobby`/`fdir` → `picomatch 4.0.7`, asociadas a [GHSA-fc5q-39xc-vjpf](https://github.com/advisories/GHSA-fc5q-39xc-vjpf). La advisory no declara versión corregida. No hay evidencia de que esa librería forme parte del bundle de ejecución, pero la alerta de herramientas de desarrollo sigue abierta. El servidor Vite de desarrollo se liga a `127.0.0.1` en este proyecto; no se debe exponer a la red.

La alerta de [GLib 0.18.5](https://rustsec.org/advisories/RUSTSEC-2024-0429.html) sigue documentada: el stack GTK/WebKitGTK que la introduce está excluido del grafo de `aarch64-apple-darwin`. No se declara corregida para otras plataformas ni se suprime globalmente. Si se añade un target nuevo, se debe reevaluar el grafo antes de soportarlo. El `tauri 2.12.5` fijado en el lockfile supera las versiones afectadas por las advisories de [acceso IPC de canales](https://github.com/tauri-apps/tauri/security/advisories/GHSA-w28w-mhc8-qvjv) y [confusión de origen](https://github.com/tauri-apps/tauri/security/advisories/GHSA-7gmj-67g7-phm9).

Una revisión de exposición, un resultado de escáner o las pruebas funcionales no certifican la ausencia de vulnerabilidades. Firma Developer ID y notarización de Apple son verificaciones distintas, pendientes para una distribución pública del instalador.
