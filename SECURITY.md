# Seguridad y privacidad

Jauria ejecuta herramientas locales en las carpetas elegidas por el usuario. Los permisos guardados de Codex y Claude Code conservan el alcance que define cada proveedor; Jauria no copia aprobaciones entre proyectos ni convierte una autorización temporal en permanente.

## Reportar una vulnerabilidad

Consulta primero la versión actual de [VERSION](VERSION) y [las notas de entrega](CHANGELOG.md). Si GitHub muestra **Security → Report a vulnerability**, usa ese canal privado. Si todavía no está habilitado, contacta con el responsable del repositorio por un canal privado previamente acordado. No publiques detalles explotables ni secretos en issues.

Incluye versión, plataforma, impacto y una reproducción mínima con datos ficticios en un repositorio desechable. No adjuntes credenciales, bases SQLite, perfiles de proveedores, prompts, transcripciones ni logs sin revisar. No se ofrece un plazo de respuesta o SLA de seguridad.

## Datos que deben permanecer locales

Los tokens del runner, la autenticación de proveedores, el historial de sesiones y los datos del usuario quedan fuera del repositorio y del instalador. `.gitignore` previene incorporaciones accidentales; no elimina datos que ya formen parte del historial Git.

Antes de cambiar la visibilidad, revisa historial, etiquetas, archivos y artefactos de CI. La autoría de commits puede incluir información personal aunque no contenga credenciales. El [registro de preparación para publicación](docs/PUBLICATION_READINESS.md) delimita la revisión realizada y sus límites.

## Dependencias y alcance de plataforma

Las alertas de desarrollo y las de código incluido en el producto se evalúan por separado, sin asumir que una alerta del lockfile sea alcanzable en todos los targets. La versión soportada actualmente es macOS Apple Silicon; no se distribuye Linux, BSD, Intel ni Windows.

Vite 6.4.6 reemplaza la versión afectada 6.4.1. La alerta de GLib 0.18.5 sigue documentada: el stack GTK/WebKitGTK que la introduce está excluido del grafo de `aarch64-apple-darwin`. No se declara corregida para otras plataformas ni se suprime globalmente. Si se añade un target nuevo, se debe reevaluar el grafo antes de soportarlo.

Una revisión de exposición, un resultado de escáner o las pruebas funcionales no certifican la ausencia de vulnerabilidades. Firma Developer ID y notarización de Apple son verificaciones distintas, pendientes para una distribución pública del instalador.
