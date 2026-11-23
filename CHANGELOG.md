# Changelog

Los cambios de cada versión de Jauria se registran aquí. El trabajo pendiente se mantiene en `Unreleased` hasta preparar una entrega.

## [Unreleased]

## [1.4.0] - 2026-11-23

Rediseño de la ventana, paleta de comandos, Pulso conectado con las sesiones y estado de los agentes guardado en el runner. Se retiran Repositorios y tareas Git. Capturas, compatibilidad y verificación en [las notas de 1.4.0](docs/RELEASE_1.4.0.md).

### Interfaz nueva

- **Barra lateral** de 264 px organizada en **Proyectos** y **Agentes**. Proyectos lista los tableros de Pulso con su avance (hechas/total) y Pendientes; muestra los 20 primeros y «Más proyectos…». Agentes tiene una fila de una línea por sesión con el icono del proveedor, la duración y un indicador de estado. La cabecera reúne la marca, la búsqueda (`⌘K`) y Nueva sesión (`⌘N`). En ventanas de 860 px o menos la barra es un cajón superpuesto.
- **Cada estado tiene su forma, no solo su color:** anillo giratorio (trabajando), punto con halo (te necesita), marca de verificación (terminó), guion (en espera) y aro vacío (sin reporte). El anillo giratorio solo aparece cuando el agente declara `working` de forma explícita (OSC 7501); un proceso abierto sin reporte muestra el aro vacío. El estado también está disponible como texto.
- Los agentes se agrupan **Por proyecto** (predeterminado: sesión principal y vínculos de proyecto o de fase de Pulso; el resto en «Sin proyecto») o **Por estado** (las secciones de Actividad: acción requerida, avisos, turnos terminados, trabajo en curso y espera), con un botón en la cabecera de Agentes. La elección se recuerda por perfil.
- **Barra superior** de 42 px en lugar de la cabecera de 62 px: una pestaña por sesión abierta (proveedor, nombre e indicador de estado; un clic la abre en el panel enfocado), «+» para nueva sesión, búsqueda, Dividir, la campana de avisos e Información. En Pulso muestra «Terminal» para volver, los tableros (Pendientes y proyectos) y «+» para nuevo proyecto.
- **Paneles como tarjetas** sobre el lienzo, con una **cabecera única** de 32 px: proveedor, nombre, carpeta, estado, Interrumpir y menú «…» (Cambiar nombre, Terminar sesión con su confirmación, Liberar carpeta). Una sesión del historial muestra la etiqueta visible «Historial · solo lectura».
- **Selector de sesión** propio en lugar del menú nativo: búsqueda por texto, grupos Abiertas e Historial, las sesiones del otro panel deshabilitadas, flechas, Inicio/Fin, Intro y Escape. Ninguna tecla llega al terminal y al cerrarlo el foco vuelve a él.
- **Barra de estado** de 28 px: «N te necesita», «N terminaron», «N trabajando», conexión, columnas × filas del panel enfocado y recursos. «Sin avisos» solo aparece con la campana a cero. El consejo «Cerrar la ventana deja las sesiones en ejecución» pasa a Información.
- **Sin barra de avisos fija** (la de 50 px desaparece): el aviso prioritario está en la etiqueta de estado de la cabecera del panel, en la campana —que abre una lista con Abrir, Ver en la lista, Marcar vistos y Abrir sesión— y en la barra de estado. Los avisos nuevos se anuncian en una región `aria-live` educada; los mensajes generales y los errores son una notificación flotante. Ningún aviso, estado ni capa flotante cambia el tamaño del terminal ni envía `resize`.
- El área útil del terminal cambia una sola vez con el rediseño: a 1220 × 800, de 118 × 33 a 115 × 38 con un panel y de 56 × 33 a 55 × 38 con dos; a 760 × 560, de 92 × 19 a 90 × 24 con uno y de 92 × 7 a 90 × 10 con dos (apilados).
- **Sistema visual:** paleta neutra clara y oscura sin tinte azul, cuatro colores de estado, ámbar reservado a la acción principal y a la marca, y un acento frío para el foco. Inter en 11, 12, 13 y 16 px (20 px en títulos de diálogo), radios de 6, 8 y 10 px y un único estilo de pestaña elevada. Fondo del terminal `#16191d` en CSS y en xterm. En modo oscuro la barra lateral toma la tinta del logotipo; el texto tenue y secundario cumple AA.
- **Configuración** con filas compactas, ayuda de una línea, «Más detalles» y un indicador «Sin guardar» junto a Guardar. Los permisos, el acceso automático a Pulso y sus textos de alcance no cambian.

### Paleta de comandos

- `⌘⇧P` (Ctrl+Shift+P fuera de macOS) o el botón de búsqueda de la barra superior abre un diálogo de 560 px cerca del borde superior. Abrirlo no cambia el tamaño del terminal.
- Resultados en grupos: **Te necesitan**, **Sesiones** abiertas (con su indicador y su proyecto), **Proyectos** de Pulso (con Pendientes), **Fases** del tablero de proyecto ya cargado y **Acciones**. La búsqueda ignora mayúsculas y acentos, admite subcadenas e iniciales y ordena por coincidencia y después por prioridad de estado. Escribir no hace lecturas nuevas. Elegir una fase abre Pulso y su detalle.
- Acciones: nueva sesión, abrir la sesión que más te necesita, marcar avisos como vistos, dividir/unificar, enfocar el otro panel, ir a Pulso o volver a la terminal, nuevo proyecto, buscar en la lista de agentes, agrupar por proyecto/estado, Abiertas/Historial, Información, Configuración, apariencia y, sobre la sesión del panel enfocado, cambiar nombre, interrumpir y terminar. Las no disponibles aparecen deshabilitadas con el motivo. Terminar y Cambiar nombre abren su confirmación o formulario de siempre; Interrumpir solo enfoca su botón. La paleta nunca escribe en un terminal ni concede permisos de Pulso.
- Teclado y accesibilidad: patrón combobox + listbox con grupos con nombre, flechas, Inicio/Fin, Intro, Escape o clic fuera, y anuncio del número de resultados. Ninguna tecla escrita en la paleta llega al terminal o a un campo de Codex, tampoco el propio atajo, su repetición al mantenerlo pulsado ni una composición IME. Al cerrar, el foco vuelve a donde estaba o, si ese control ya no existe, al terminal del panel enfocado. No se abre sobre otro diálogo y, en Pulso, respeta las guardas del borrador.
- `⌘K` no cambia: sigue enfocando la búsqueda de la lista de agentes. `⌘N`, `⌘K`, `⌘I`, `⌘,` y `⌘⇧P` comparten un registro único de atajos.

### Pulso

- Los tableros son pestañas de la barra superior y «Nuevo proyecto» es su «+». La barra del proyecto ocupa una línea: título, «n de m fases hechas», Plan y sesiones y la única acción ámbar. Las cuatro columnas caben a 1220 px.
- Cada tarjeta tiene un menú **«…» → Mover a** Por hacer / En curso / En espera / Hecho, accesible con teclado, en lugar del selector visible; conserva la semántica, el deshacer y el orden de fases. El arrastre por el agarre sigue igual.
- **Pie de tarjeta** con la sesión vinculada (indicador de estado en vivo, proveedor y nombre) y «n checkpoints» (oculto si es 0). Pulsarlo abre esa sesión: la viva se enfoca y la cerrada muestra su historial; no abre el detalle ni inicia un arrastre, y se deshabilita con un borrador. Si sale del último checkpoint lo indica («Sesión del último checkpoint»); una sesión que la ventana no conoce aparece como «Sesión no disponible», sin acción.
- **La barra lateral y el tablero se actualizan cuando un agente edita Pulso** por MCP, en un segundo o menos y sin sondeo: siguen la revisión de Pulso que el runner publica en cada `status`. Con la ventana oculta, el cambio queda pendiente hasta volver. Sin cambios, ni la barra lateral ni el tablero leen Pulso; el tablero ya no consulta su revisión cada 2 s y la barra lateral hace una sola lectura en lugar de varias por proyecto.
- «Por proyecto» agrupa también las sesiones vinculadas a una **fase**; la sesión principal tiene prioridad. Desaparece el tope de 100 vínculos por proyecto; si el runner recorta los vínculos (más de 2.048), el grupo «Sin proyecto» lo indica.

### Estado de los agentes guardado en el runner

- El runner lee la salida de cada terminal y reconoce las mismas señales que la ventana —estado OSC 7501, BEL y notificaciones OSC 9/777—, aunque lleguen partidas. Guarda el **estado declarado**, la **duración del turno** y **lo que ya viste**, que sobreviven a cerrar la ventana, reconectar y recargar; si el runner se reinicia, un turno abierto queda como interrumpido. Barra lateral, pestañas, cabecera del panel, barra de estado, campana, pies de tarjeta, paleta y Dock muestran la misma información.
- El estado es **lo que declara la salida del terminal**, no una comprobación del agente: cualquier programa de la sesión puede emitirlo. El runner no guarda ni publica títulos, mensajes ni texto de las notificaciones. El modo estructurado de Codex no declara estado: aparece como progreso no informado, nunca como trabajando.
- **Un turno terminado sin ver se conserva:** sigue visible y contado aunque el agente ya haya empezado otro turno (la fila indica «Trabaja de nuevo»), hasta que lo veas.
- **«Te necesita» dura mientras se declara:** un bloqueo o error permanece mientras el agente lo declare; si se desbloquea solo, deja de pedir atención.
- **Qué cuenta como ver:** abrir la sesión (barra lateral, pestaña, lista de avisos, paleta o «N te necesita») o pulsar **Marcar vistos**. De forma automática, solo si estás mirando ese terminal —ventana visible y enfocada, vista de terminal, sesión del panel enfocado y nada que lo cubra: ningún diálogo ni el cajón lateral de las ventanas estrechas— y el aviso ya se pintó. El fin de un proceso y las solicitudes de permiso nunca se marcan solos. Marcar visto no responde permisos ni resuelve errores; un permiso de Codex pendiente sigue saliendo de su propio estado.
- **Al abrir la ventana**, lo pendiente aparece desde el primer momento en la campana, la barra de estado y el Dock, pero **macOS no notifica lo atrasado**: las notificaciones solo avisan de lo ocurrido después de conectar y no se repiten al reconectar. Con muchas sesiones, la lista de la campana termina con «y N más sin listar» y los totales siguen siendo exactos.
- Las notificaciones de macOS usan su categoría («Necesita tu atención», «Actividad finalizada» o «Aviso de sesión»), sin títulos, rutas ni salida del terminal.
- Durabilidad: lo que marcas como visto se confirma en disco; el resto de cambios se guarda en menos de 250 ms, así que una caída del runner puede perder ese último tramo. Al cerrar, el runner vacía lo pendiente con el mejor esfuerzo durante como mucho 3 s. Eliminar o compactar el historial no borra los avisos sin ver.

### Retirado

- **Repositorios y tareas Git:** registrar repositorio, nueva tarea, worktree propio por tarea, panel de tarea, revisión con veredicto humano, verificación de comandos, relevo y su botón «Contexto», archivar y cerrar o reabrir repositorios. Los datos antiguos del perfil **se conservan y se ignoran**. Jauria **no borra ningún worktree ni rama**; sus carpetas se abren como sesión normal.
- Las reservas de relevo de versiones anteriores ya no bloquean sesiones nuevas. Una verificación antigua sin terminar bloquea su carpeta solo mientras su comando siga vivo.
- Se mantienen el límite de plazas, la regla de un escritor por worktree Git, «Liberar carpeta» para sesiones inciertas, la eliminación y compactación del historial (ahora con su propia confirmación nativa), Pulso, MCP, permisos, avisos y Configuración.

### Corregido

- **Configuración → Guardar** fallaba siempre en la app 1.3.3 con su propio runner («Argumento no permitido»), también al cambiar solo el límite de sesiones: el puente nativo solo dejaba pasar `maxConcurrentSessions` y rechazaba `pulsoAutoAccess`. Ahora lo admite, estrictamente booleano, y una tabla compartida comprueba cada operación que envía la interfaz contra el puente y el runner.

### Compatibilidad y vuelta atrás

- El esquema del perfil sigue en `user_version` 5. `runner.sqlite` añade la tabla `agent_attention`, sin claves foráneas ni triggers; `pulso.sqlite` no cambia. Las tablas de Repositorios se mantienen con la misma definición, sin recuperación ni limpieza.
- **App 1.4 con un runner 1.3.x** (el que sigue vivo tras reemplazar la app): funciona en modo degradado, como 1.3.3. Estado y vistos solo en la ventana (se reinician al reconectar), Pulso con varias lecturas por proyecto, consulta de revisión cada 2 s y relectura al terminar un turno, y tarjetas sin pie. Para tener todo, termina el trabajo activo y reinicia el runner como indica [la guía de instalación](docs/INSTALLATION.md#actualizar-una-instalación-existente).
- **App 1.3.x con un runner 1.4:** conecta, no ofrece Repositorios y Diagnóstico muestra «runner anterior» por las capacidades retiradas (un aviso de más, no un fallo); una operación de tareas devuelve `unknown operation`. Deducido del código: no se probó con la app 1.3.x.
- **Vuelta atrás a 1.3.3:** su runner abre un perfil usado por 1.4, purga y compacta sin tocar `agent_attention` (comprobado con el binario de v1.3.3). Los avisos que nadie marque mientras tanto aparecen como pendientes al volver a 1.4. Con datos antiguos de Repositorios, el runner 1.3.x modifica al abrir las tareas y verificaciones a medio hacer; ese caso no se probó.

### Para desarrolladores

- `status` añade `pulsoRevision` y `pulsoRevisionVersion: 1` (solo con Pulso disponible), `pulsoSummaryVersion: 1`, `pulsoBoardCardsVersion: 1`, `agentAttentionVersion: 1`, `agentAttention` y `agent` por sesión (vivas o con avisos pendientes; como mucho 128, con `hasMore` y totales exactos). `terminal_live` añade el `agent` de su sesión. Ningún `*Version` existente cambia. Se retiran `workspaceVersion`, `workflowVersion`, `verificationVersion`, `recoveryVersion`, `handoffVersion` y `projectLifecycleVersion`, y `status` deja de enviar `projects`/`tasks` (acepta e ignora `workspaceAfter`).
- Operaciones nuevas: `sidebar_summary {ifRevision?}` de Pulso (solo UI; hasta 50 proyectos y 2.048 vínculos) y `mark_seen {items:[{id, epoch, through}]}` (hasta 64, monótona e idempotente, sin el cerrojo de mutaciones), también en el puente. Las tarjetas de `board` añaden `session` y `checkpointCount`. Se retiran `register_project`, `close_project`, `reopen_project`, `create_task`, `prepare_task`, `revalidate_task`, `start_task`, `start_codex_task`, `workflow*`, `snapshot_task`, `review_task`, `handoff_task`, `open_handoff`, `archive_task`, `reopen_task`, `purge_workflow` y las de verificación (`unknown operation`).
- Coste medido: el pie de tarjeta añade en release unos 0,1–0,3 ms y 5–8 KB a un `board` de 80 tarjetas; `agent` añade unos 33 KB a `status` con 8 sesiones vivas y 100 cerradas con avisos. El escaneo del PTY ocurre fuera del candado de publicación: en una ráfaga de 50 MiB con `resize` cada 5 ms, el p99 de `resize` bajó de 2,8–7,7 ms a 0,3–0,7 ms sin empeorar el drenaje. Las filas de sesiones terminadas con todo visto se limitan a 512 también en ejecución, y ni el sellado de sesiones del runner ni el mapa de estados de la interfaz crecen con el histórico. Contrato en [DEVELOPMENT.md](docs/DEVELOPMENT.md#capacidades-de-status) y reglas en [SESSION_ALERTS.md](docs/SESSION_ALERTS.md#estado-y-vistos-en-el-runner-14-e).
- `scripts/build-macos.py` y el CI ejecutan todas las suites de navegador (`scripts/browser-tests.py`, Chrome y Playwright WebKit) y las suites Rust `agent_attention_rpc` y `legacy_profile_rpc`; `--skip-browser-tests` omite las de navegador y lo deja escrito. Se retira el arnés `tests/attention-browser.mjs` del MVP.

## [1.3.3] - 2026-11-18

### Pulso para agentes

- Claude Code y Codex iniciados desde Jauría reciben el servidor MCP local `jauria-pulso` y acceso predeterminado a los proyectos de Pulso. Cada sesión usa una credencial privada y revocable; las sesiones iniciadas fuera de Jauría no reciben acceso.
- Configuración muestra un interruptor principal para el acceso automático. Los permisos manuales de sesiones anteriores quedan en una sección desplegable; las políticas recordadas más estrechas conservan su alcance.
- El ajuste persiste en el perfil con migración del esquema anterior. Desactivarlo corta las concesiones automáticas, sin modificar los permisos manuales ni las aprobaciones nativas de cada proveedor.
- La conexión estructurada de Codex permite exclusivamente el MCP local de Jauría; el resto de servidores continúa deshabilitado en ese modo.
- Se actualizan la guía, las capturas de Configuración y las pruebas de persistencia, autorización, MCP y accesibilidad del diálogo.

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

[Unreleased]: https://github.com/StevenSantacruz56/jauria-sessions/compare/v1.4.0...HEAD
[1.4.0]: https://github.com/StevenSantacruz56/jauria-sessions/releases/tag/v1.4.0
[1.3.3]: https://github.com/StevenSantacruz56/jauria-sessions/releases/tag/v1.3.3
[1.3.2]: https://github.com/StevenSantacruz56/jauria-sessions/releases/tag/v1.3.2
[1.3.1]: https://github.com/StevenSantacruz56/jauria-sessions/tree/v1.3.1
[1.3.0]: https://github.com/StevenSantacruz56/jauria-sessions/tree/861bd59
[0.1.1]: https://github.com/StevenSantacruz56/jauria-sessions/releases/tag/v0.1.1
[0.1.0]: https://github.com/StevenSantacruz56/jauria-sessions/tree/a32f414

[1.0.0]: https://github.com/StevenSantacruz56/jauria-sessions/releases/tag/v1.0.0

[1.0.1]: https://github.com/StevenSantacruz56/jauria-sessions/releases/tag/v1.0.1

[1.1.0]: https://github.com/StevenSantacruz56/jauria-sessions/tree/b96fdfe

[1.2.0]: https://github.com/StevenSantacruz56/jauria-sessions/tree/676fd0b
