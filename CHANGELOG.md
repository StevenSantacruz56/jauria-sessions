# Changelog

Los cambios de cada versión de Jauria se registran aquí. El trabajo pendiente se mantiene en `Unreleased` hasta preparar una entrega.

## [Unreleased]

Sin cambios pendientes registrados.

## [0.1.1] - 2026-11-13

### Corregido

- Las terminales nativas continúan funcionando cuando el historial alcanza su cuota o falla su almacenamiento. La entrada, la interrupción, el cambio de tamaño y la detención dejan de depender del archivo de salida.
- El guardado en segundo plano agrupa la salida y limita memoria y almacenamiento por sesión. Los bloqueos transitorios de SQLite se reintentan sin detener las sesiones.
- La reconexión recupera la salida guardada sin duplicarla ni aplicar geometría antigua. Los tramos irrecuperables se muestran como una vista desincronizada.
- Los estados de cierre y liberación se reconcilian con el estado observado del proceso; los checkpoints atrasados no pueden restaurar estados antiguos.
- La eliminación del historial actualiza su integridad de forma atómica y no permite que una escritura pendiente restaure salida eliminada.

### Añadido

- Avisos de cuota al 80 % y 95 %, y estados separados para el proceso y la integridad de su historial.
- Versión visible en Información y versión del runner en Diagnóstico.
- Archivo `VERSION`, sincronización de versiones y comprobación obligatoria durante la compilación.

### Validación

- Pruebas con PTYs desechables para cuotas, fallos de escritura, bloqueos y salida masiva; también ejecutadas contra el runner empaquetado.
- Pruebas de orden, límites de memoria, disco lleno y checkpoints, más integración de interfaz en Chrome y WebKit.

### Limitaciones

- Un hueco irrecuperable no permite reconstruir exactamente el estado anterior de una aplicación de terminal.
- Un fallo persistente puede detener el guardado del historial; la terminal y sus controles permanecen disponibles.
- Bundle local para macOS Apple Silicon, sin firma de distribución ni notarización.

## [0.1.0] - 2026-11-12

Primera base de desarrollo conservada antes de introducir este changelog.

### Incluido

- Sesiones de Codex, Claude Code y terminal zsh por carpeta, sin requerir un proyecto nuevo.
- Proyectos Git, tareas, worktrees, historial local y dos paneles de terminal.
- Uso de proveedores y recursos de CPU/RAM cuando están disponibles.
- Avisos de sesión, contador en el Dock y notificaciones opcionales de macOS.
- Correcciones de scroll, geometría, entrada y carga de configuración MCP de Claude Code.

[Unreleased]: https://github.com/StevenSantacruz56/jauria-sessions/compare/v0.1.1...HEAD
[0.1.1]: https://github.com/StevenSantacruz56/jauria-sessions/releases/tag/v0.1.1
[0.1.0]: https://github.com/StevenSantacruz56/jauria-sessions/tree/a32f414
