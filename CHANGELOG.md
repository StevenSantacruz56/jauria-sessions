# Changelog

Los cambios de cada versión de Jauria se registran aquí. El trabajo pendiente se mantiene en `Unreleased` hasta preparar una entrega.

## [Unreleased]

Sin cambios pendientes registrados.

## [1.1.0] - 2026-11-14

### Proyectos y continuidad

- Pulso integrado dentro de Jauria: un plan completo como proyecto, fases ordenadas y pendientes independientes sin exigir Git.
- Sesión principal con captura de la sesión actual marcada por defecto cuando está disponible, sesiones relacionadas y checkpoints inmutables con siguiente acción. Contexto editable/copiable para abrir una sesión nueva vacía, sin envío automático.
- CLI local para que agentes autorizados creen y actualicen sus planes/fases, con revisiones, reintentos idempotentes, atribución y acceso explícito por proyecto.
- Políticas de acceso recordadas por herramienta/carpeta mediante casilla inicialmente desmarcada, con credenciales nuevas por sesión, gestión y revocación.
- Intento de reanudación por ID exacto de conversaciones Claude cuya identidad reservó Jauria, sin garantizar historial del proveedor ni saltar bloqueos de escritor. Acciones separadas para sesión viva e historial, seguimiento de continuación viva y vínculos/metadatos de origen conservados.

### Fluidez y seguridad

- SQLite, mutex, credencial y endpoint Pulso propios; la consulta de planes queda fuera del bucle de salida/teclado del terminal y se detiene con la vista oculta.
- Conservación de instancias xterm, paneles y lectura al navegar; sin fit a tamaño cero ni envío automático de contexto.
- Lookup de políticas después de iniciar lector y recolección del PTY, fuera de los gates de admisión; la revocación no espera SQLite.
- Consultas de proyectos e items paginadas en SQL; resúmenes sin transferir planes completos. El detalle carga los últimos 10 checkpoints y permite consultar anteriores de 10 en 10.
- Presupuesto de 64 MiB lógicos/100.000 filas, más 1 MiB/2.000 filas de margen solo para principales de permisos y políticas; límite físico de 128 MiB en la base Pulso. Lecturas disponibles al alcanzar el presupuesto, sin borrado automático ni exportación desde UI; guía de respaldo consistente de SQLite.
- Fixtures para permisos/revocación, corrupción, concurrencia, reintentos, reanudación con CLI simulada y navegación Chromium/WebKit.

### Alcance

- Codex conserva terminal, historial local y contexto; la captura de identidad y reanudación nativa no está disponible. MCP e importación del Site Pulso siguen pendientes; no hay importación automática ni sincronización en la nube.
- Instalador local; sin publicación de DMG ni reinicio de sesiones activas como efecto de esta entrega.
- Recuentos finales de pruebas, métricas y verificación del paquete pendientes del cierre de validación por la tarea principal. No se ha activado la app instalada ni se ha probado el perfil real; los fixtures sintéticos no constituyen una auditoría integral.

## [1.0.1] - 2026-11-13

### Seguridad y licencias

- Vite actualizado de 6.4.1 a 6.4.6; el análisis npm del snapshot actualizado no reporta vulnerabilidades.
- Alerta de GLib documentada como dependencia Linux/BSD excluida del target soportado macOS Apple Silicon; no se declara corregida globalmente ni se suprime.
- Código propio bajo GPLv3 únicamente (GPL-3.0-only), con LICENSE íntegro, metadatos npm/Cargo y avisos de terceros y marca separados.
- Bundle y DMG incluyen la licencia y avisos; el paquete agrega una referencia a la fuente exacta, sin afirmar cumplimiento automático de distribución.

### Documentación

- Descripción y temas de GitHub, resumen y README en inglés, FAQ y CITATION.cff para descubrimiento y referencias, sin prometer indexación ni citas de asistentes.
- README aclarado: hasta 8 sesiones configurables, dos paneles de vista, instalador local y requisitos de CLI separados de los de compilación.
- Revisión del historial y archivos para exposición de credenciales, más inventario de releases, artefactos y disponibilidad de logs de Actions. Se documentan alcance y autoría personal sin publicar valores sensibles.
- Política de seguridad actualizada para la serie oficial y notas de preparación para publicación.

## [1.0.0] - 2026-11-13

Primera versión oficial de Jauria. Incorpora las correcciones que se prepararon localmente como 0.1.2, sin una publicación intermedia.

### Añadido

- Empaquetado DMG con acceso a Aplicaciones, instrucciones y verificación SHA-256; verificación estricta opcional de firma y notarización mediante `--require-notarized`.
- Compilación de escritorio optimizada en modo release por defecto, con debug opcional.
- Pestañas Abiertas e Historial con apariencia de navegador: pestaña activa elevada, esquinas superiores redondeadas, base común y contadores separados.
- Selector de sesiones con grupos separados para abiertas e historial y etiquetas sin repetir el proveedor.
- Un solo acceso a Información; Configuración y Diagnóstico tienen funciones separadas.
- Renombrar sesiones activas y del historial desde el menú de acciones, con nombres persistentes y sin alterar el proceso ni la conversación del proveedor.
- Campana con contador de avisos nuevos como indicador global; el resumen de avisos se concentra en su vista.
- Configuración accesible desde la navegación y con `⌘,`, con apariencia y límite de sesiones simultáneas entre 1 y 8.
- Preferencias de capacidad guardadas por perfil de forma atómica. Reducir el límite conserva las sesiones abiertas; las protecciones por worktree siguen vigentes.

### Corregido

- El listener del runner responde a nuevas conexiones sin la espera fija de 10 ms por RPC. La lectura de terminales prioriza la sesión activa y reduce las consultas al archivo durante escritura nativa.
- El límite del historial local se explica como información de guardado; se distingue de la cuota del proveedor y de un fallo de ejecución.
- El contador del Dock y el encabezado usan la misma selección de avisos nuevos; finalizar una terminal ya atendida no deja un aviso transitorio sin ver.

- Las sesiones nativas de Claude Code respetan el modo de permisos ya guardado, en lugar de forzar `default` al iniciar.
- Las sesiones nativas de Codex respetan la configuración guardada de aprobaciones y sandbox, sin reemplazarla con flags del lanzador. Los permisos temporales siguen limitados al alcance que define cada proveedor. Si la configuración guardada es más permisiva, ahora se respeta en lugar de aplicar las restricciones propias del lanzador.

### Validación

- Compilación optimizada release, pruebas de frontend, runner, almacenamiento y puente nativo; integración Chrome/WebKit con fixtures y comprobación nativa de Configuración y renombrado.
- Benchmark de 40 muestras con dos PTYs: entrada → eco del proceso de 25,256 a 1,766 ms de mediana tras cambiar el listener. No mide la respuesta del proveedor ni el renderizado completo.
- DMG local verificado y montado en solo lectura; hashes del ejecutable y runner contrastados con el bundle. Pruebas y límites en [las notas de 1.0.0](docs/RELEASE_1.0.0.md).

### Distribución

- Código y documentación publicados en GitHub; instalador mantenido localmente, sin adjuntos binarios.
- Paquete Apple Silicon sin firma Developer ID ni notarización. La actualización no reinicia runners o sesiones que ya estén en ejecución.

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

[Unreleased]: https://github.com/StevenSantacruz56/jauria-sessions/compare/v1.0.1...HEAD
[0.1.1]: https://github.com/StevenSantacruz56/jauria-sessions/releases/tag/v0.1.1
[0.1.0]: https://github.com/StevenSantacruz56/jauria-sessions/tree/a32f414

[1.0.0]: https://github.com/StevenSantacruz56/jauria-sessions/releases/tag/v1.0.0

[1.0.1]: https://github.com/StevenSantacruz56/jauria-sessions/releases/tag/v1.0.1
