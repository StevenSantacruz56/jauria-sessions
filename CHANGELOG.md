# Changelog

Los cambios de cada versión de Jauria se registran aquí. El trabajo pendiente se mantiene en `Unreleased` hasta preparar una entrega.

## [Unreleased]

Sin cambios pendientes registrados.

## [1.3.2] - 2026-11-18

### Documentación y distribución

- Se renuevan capturas sintéticas de Actividad, Pulso y Configuración con la interfaz actual. Las vistas de Actividad muestran una terminal de demostración para dar contexto a la acción requerida y al trabajo en curso.
- README en español e inglés, guía de instalación y notas de entrega actualizados para identificar la versión y los tres archivos de GitHub Release: DMG, SHA-256 y recibo de verificación.
- Se publica por primera vez el DMG Apple Silicon en GitHub Releases. Es una compilación estable verificada localmente, **sin firma Developer ID ni notarización**; macOS puede bloquear su apertura. No se recomienda desactivar Gatekeeper ni quitar la cuarentena.
- La compilación Rust remapea las rutas del equipo de build y el empaquetador rechaza un bundle que todavía contenga rutas absolutas de usuario macOS. Se detectó y descartó un primer DMG antes de publicarlo.
- La actividad y los avisos mantienen las reglas implementadas en 1.3.1; no se cambian permisos, estado de Pulso ni lanzamiento de proveedores.

## [1.3.1] - 2026-11-17

### Actividad y avisos de sesiones

- Nueva vista **Actividad** ordenada por acción requerida, avisos, turnos terminados, trabajo en curso y espera. Cada sesión muestra un estado explícito; una terminal abierta sin OSC 7501 aparece como progreso no informado, sin fingir que está trabajando.
- El estado `blocked` o `error` permanece visible hasta que cambia el reporte del programa. El fin de un turno `working → done/idle` queda pendiente hasta abrir la sesión, incluso si el programa emite `idle` después de `done`. Verlo no responde permisos ni modifica fases de Pulso.
- La barra de avisos ofrece **Abrir sesión**; el tiempo de trabajo declarado aparece junto a la sesión. Los avisos nativos opcionales distinguen acción, fin y aviso con textos genéricos sin nombres ni rutas.
- Revisión de Herdr y Claude documentada, junto con pruebas sintéticas de estados, permisos, geometría y navegación en Chromium y WebKit. No se añaden hooks, telemetría ni procesos remotos.

### Documentación y verificación

- README y guía de Pulso actualizados: MCP local disponible en 1.3.0, registro opcional por proveedor, sesión nueva y permiso explícito por proyecto; se aclara la diferencia con Claude Desktop y el uso de la CLI en sesiones existentes.
- Guía de instalación aclarada para conservar una sola app en Aplicaciones sin borrar perfiles. Revisión acotada de exposición y dependencias registrada antes de integrar 1.3.0 en `main`.

## [1.3.0] - 2026-11-14

### Continuidad y configuración

- Acción directa en el tablero para continuar la sesión principal o reanudar su conversación Claude registrada. Si ya existe una continuación viva, vuelve a ella sin consumir otra plaza.
- Corregida la consulta de identidad al terminar una sesión mientras el detalle estaba abierto: el refresco automático ya no omite la acción de reanudación. Fallos de consulta muestran reintento explícito.
- La recuperación de una fase prioriza su último checkpoint y su sesión vinculada antes de la principal del proyecto. Se conservan la principal original y el historial.
- Configuración centraliza permisos de agentes, políticas recordadas y revocación, junto con avisos de macOS. El tablero enlaza a esta sección sin duplicar formularios. El alcance sigue limitado por proyecto, herramienta y carpeta; recordar requiere elección explícita.
- Pulso recuerda el último tablero por perfil mediante su identificador local. Restaurar la vista no inicia agentes ni concede permisos.
- Se conserva una sola campana de avisos; Configuración permite abrir la lista que requiere atención.

## [1.2.0] - 2026-11-14

### Tablero de Pulso

- Rediseño tras el rechazo del flujo de 1.1: pestañas por proyecto, Pendientes fija con terminados y cuatro columnas Por hacer / En curso / En espera / Hecho.
- Nuevo proyecto con nombre y casilla de sesión actual; captura inline en las tres primeras columnas. Arrastre por agarre mediante eventos de puntero y selector Mover accesible por teclado para cambiar de columna conservando el orden de fases.
- Abrir tarjeta muestra el drawer derecho con título, notas, estado, último checkpoint y siguiente paso; Guardar avance desplegable. Plan y sesiones reúne plan, principal, vínculos y permisos fuera del tablero. Abrir tarjeta no inicia un PTY; el contexto sigue siendo editable/copiable y la sesión nueva empieza vacía.
- API board exclusiva de UI: snapshot atómico bajo mutex del servicio, 20 tarjetas iniciales por columna y contadores; items filtrado por status con páginas de 50 y expectedSnapshotRevision para rechazar offsets obsoletos. Sin polling oculto.
- Estado explícito OSC 7501 pasivo: solo state raíz, payload hasta 1.024 bytes; working/blocked/error/done/idle/clear. Otros campos se ignoran, IDs de hijos y consultas se rechazan sin respuesta. Estado efímero solo en vista viva, replay silencioso, reset al reconectar y avisos agrupados con límite de uno cada 5 s por sesión. No instala hooks, cambia configuración ni escribe fases.
- Revisión de fuentes Herdr fijadas por commit y matriz de decisiones, sin copiar código ni añadir dependencias Herdr. Se adoptan separación vista/runtime, estado explícito y retorno directo a sesión.

### Alcance y validación

- Sin reordenación dentro de columna, columnas personalizadas ni traslado entre proyectos. Mods JavaScript sin sandbox, SSH remoto, telemetría y reanudación automática se difieren.
- Permisos CLI acotados y reanudación Claude mantienen los límites de 1.1; MCP y reanudación nativa Codex pendientes. GPL-3.0-only sin cambios.
- Build release e instalador local verificados; [pruebas y límites registrados](docs/PULSO_VALIDATION_1.2.0.md). Perfil de ejemplo separado, sin sustituir sesiones habituales ni publicar el instalador.

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
- Compilación release, pruebas, métricas y verificación del paquete local completadas para 1.1.0: [validación histórica](docs/PULSO_VALIDATION_1.1.0.md). No se activó la app instalada ni se probó el perfil real; los fixtures sintéticos no constituyen una auditoría integral.

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

[Unreleased]: https://github.com/StevenSantacruz56/jauria-sessions/compare/v1.3.2...HEAD
[1.3.2]: https://github.com/StevenSantacruz56/jauria-sessions/releases/tag/v1.3.2
[1.3.1]: https://github.com/StevenSantacruz56/jauria-sessions/tree/v1.3.1
[1.3.0]: https://github.com/StevenSantacruz56/jauria-sessions/tree/861bd59
[0.1.1]: https://github.com/StevenSantacruz56/jauria-sessions/releases/tag/v0.1.1
[0.1.0]: https://github.com/StevenSantacruz56/jauria-sessions/tree/a32f414

[1.0.0]: https://github.com/StevenSantacruz56/jauria-sessions/releases/tag/v1.0.0

[1.0.1]: https://github.com/StevenSantacruz56/jauria-sessions/releases/tag/v1.0.1

[1.1.0]: https://github.com/StevenSantacruz56/jauria-sessions/tree/b96fdfe

[1.2.0]: https://github.com/StevenSantacruz56/jauria-sessions/tree/676fd0b
