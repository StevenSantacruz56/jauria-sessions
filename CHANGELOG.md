# Changelog

Los cambios de cada versión de Jauria se registran aquí. El trabajo pendiente se mantiene en `Unreleased` hasta preparar una entrega.

## [Unreleased]

### Sin publicar · 1.4.0 entrega A: sistema visual y barra lateral

- Paleta neutra clara y oscura de la propuesta 1.4: superficies sin tinte azul, un borde translúcido, cuatro colores de estado unificados (`--state-working`, `--state-attention`, `--state-ready`, `--state-paused`), texto tenue `--dim` y un acento de foco frío `--focus`. El ámbar queda en la acción principal (`.primary`) y la marca; el panel enfocado, el anillo de teclado, las tarjetas, las pestañas y el interruptor de Configuración usan el foco frío.
- Escala única: letra de 11, 12, 13 y 16 px (20 px en títulos de diálogo y bienvenida), pesos 400/500/600 en Inter, radios de 6 px en controles, 8 px en filas y tarjetas y 10 px en paneles, columnas y diálogos. Un solo estilo de pestaña elevada para Abiertas/Historial y los tableros de Pulso.
- El fondo del terminal pasa a `#16191d` en CSS y en el tema de xterm a la vez.
- Barra lateral de 264 px: cabecera con marca, búsqueda (⌘K) y nueva sesión (⌘N); sección **Proyectos** con los tableros de Pulso, su avance (hechas/total) y Pendientes; sección **Agentes** con filas de 30 px de una línea, icono del proveedor, duración e indicador de estado. Solo un reporte `working` explícito (OSC 7501) muestra el anillo giratorio; un proceso abierto sin reporte muestra un aro vacío. El estado también está disponible como texto.
- Cada estado tiene su forma: anillo giratorio (trabajando), punto con halo (te necesita), marca de verificación (terminó), guion (en espera) y aro vacío (sin reporte).
- Los agentes se agrupan **Por proyecto** (predeterminado; sesión principal y vínculos de proyecto de Pulso, el resto en «Sin proyecto») o **Por estado** (las secciones de Actividad), con un botón en la cabecera de Agentes. La elección se recuerda por perfil. La barra muestra los 20 primeros proyectos y «Más proyectos…».
- El resumen de Pulso se relee al conectar, al recuperar el foco de la ventana, al salir o cambiar de tablero, al cambiar las sesiones y cuando un agente informa `done`/`idle`; no hay sondeo periódico. Los cambios de agentes por MCP pueden tardar hasta uno de esos eventos; la revisión de Pulso en el estado del runner queda para una entrega posterior.
- La entrada de Repositorios y tareas Git se oculta de la barra lateral; el código de tareas, revisión, verificación y relevo no cambia.
- Pulso: columnas sin borde con punto de estado, tarjetas de radio 8 con un solo borde, sin el título «Pulso» repetido ni el eslogan permanente. El selector «Mover» se mantiene.
- Sin cambios en el runner, la barra de avisos de 50 px, la cabecera de los paneles ni el inset del terminal (la entrega B los sustituye). Al ensanchar la barra lateral, el terminal pierde unas columnas en ventanas anchas; por debajo de 860 px la barra sigue superpuesta.

### Sin publicar · 1.4.0 entrega B: terminal y Pulso

- Barra superior de 42 px en lugar de la cabecera de 62 px: una pestaña elevada por sesión abierta (icono del proveedor, nombre, indicador de estado con las cinco formas de la barra lateral; clic = abrir en el panel enfocado), «+» para nueva sesión, Dividir, la campana de avisos e Información. En Pulso la misma barra muestra los tableros (Pendientes y proyectos) y un «+» para nuevo proyecto.
- Sin barra de avisos de 50 px: el aviso prioritario está en la etiqueta de estado de la cabecera del panel, en la campana (que abre una lista con Abrir sesión y Marcar vistos) y en la barra de estado. Los avisos nuevos se anuncian en una región `aria-live` educada. Los mensajes genéricos y errores son una notificación flotante.
- Paneles como tarjetas sobre el lienzo (8 px de separación, radio 10, borde de 1 px; el foco cambia el color del borde y añade un anillo). Cabecera única de 32 px por panel: proveedor, nombre, carpeta, estado, Interrumpir y menú «…» (Cambiar nombre, Terminar sesión con su confirmación, Liberar carpeta).
- Selector de sesión propio en lugar del `<select>` nativo: búsqueda por texto, grupos Abiertas e Historial, sesiones del otro panel deshabilitadas, flechas, Intro y Escape; ninguna tecla llega al terminal y al cerrar el foco vuelve a él.
- Barra de estado de 28 px: «N te necesita», «N trabajando», conexión, columnas × filas del panel enfocado y recursos. El consejo «Cerrar la ventana deja las sesiones en ejecución» pasa a Información.
- El área útil del terminal cambia una vez: a 1220 × 800, de 118 × 33 a 115 × 38 con un panel y de 56 × 33 a 55 × 38 con dos; a 760 × 560, de 92 × 19 a 90 × 24 con un panel y de 92 × 7 a 90 × 10 con dos (apilados).
- Pulso: el selector «Mover» visible se sustituye por el menú «…» de cada tarjeta (Mover a Por hacer / En curso / En espera / Hecho, accesible con teclado), con la misma semántica, deshacer y orden de fases; el arrastre sigue igual. Barra de proyecto de una línea con título, «n de m fases hechas», Plan y sesiones y la única acción ámbar; «Nuevo proyecto» pasa al «+» de la barra superior y «Volver a terminal» desaparece.
- Configuración con filas compactas, ayuda de una línea y «Más detalles»; indicador «Sin guardar» junto a Guardar; sin tarjeta anidada. Permisos, acceso automático y sus textos de alcance no cambian.
- Modo oscuro: `--sidebar` pasa a `#0e1116`, la tinta del logotipo oscuro, para que no se vea su recuadro; el texto tenue y secundario siguen en AA (5,98:1 y 7,12:1).
- Tras la revisión: el menú «…» del panel ya no queda recortado por la cabecera; el contexto de relevo flota y se abre con «Contexto» en la barra superior; en Pulso, «Terminal» al inicio de la barra vuelve a la vista de terminal y el botón de Pulso alterna; la etiqueta «Historial · solo lectura» es visible; la barra de estado cuenta «N terminaron» y solo dice «Sin avisos» con la campana a cero; Tab sale del selector y del menú Mover sin perder el foco; Escape cierra los avisos desde la campana; las cuatro columnas de Pulso caben a 1220 px.
- Sin cambios en el runner ni en la persistencia. El pie de tarjeta con la sesión vinculada y los checkpoints queda para la entrega E: el tablero no trae esos datos.

### Sin publicar · 1.4.0 entrega D: retirada de Repositorios

- Retirado: Repositorios y tareas Git (registrar repositorio, nueva tarea, worktree propio por tarea, panel de tarea, revisión con veredicto humano, verificación de comandos con confirmación nativa, relevo y su botón «Contexto», archivar y cerrar/reabrir repositorios); los datos antiguos del perfil se conservan y se ignoran. No se borran worktrees ni ramas; sus carpetas se abren como sesión normal.
- Runner: sin las operaciones `register_project`, `close_project`, `reopen_project`, `create_task`, `prepare_task`, `revalidate_task`, `start_task`, `start_codex_task`, `workflow*`, `snapshot_task`, `review_task`, `handoff_task`, `open_handoff`, `archive_task`, `reopen_task`, `purge_workflow` ni las de verificación. `status` deja de anunciar sus capacidades y de enviar `projects`/`tasks`; acepta e ignora `workspaceAfter` para que una interfaz 1.3.x siga conectando.
- El esquema del perfil no cambia: las tablas antiguas se mantienen con la misma definición, sin recuperación ni limpieza, y un runner 1.3.x puede volver a abrir el perfil. Las reservas de relevo de versiones anteriores ya no bloquean sesiones nuevas; una verificación antigua sin terminar bloquea su carpeta solo mientras su comando siga vivo.
- Se mantienen el límite de plazas, la regla de un escritor por worktree Git, «Liberar carpeta» para sesiones inciertas, la eliminación y compactación del historial (ahora con su propia confirmación nativa), Pulso, MCP, permisos, avisos y Configuración. Los fixtures de prueba siguen visibles solo en modo smoke.
- Pruebas: se eliminan las de la función retirada y se añade `legacy_profile_rpc`, que abre un perfil sintético con datos antiguos.

### Sin publicar · 1.4.0 entrega C: paleta de comandos

- Paleta de comandos con `⌘⇧P` (Ctrl+Shift+P fuera de macOS) o con el botón de búsqueda de la barra superior, que muestra el atajo. Es un diálogo modal de 560 px cerca del borde superior, fuera del flujo: abrirla no cambia el tamaño del terminal ni envía `resize`.
- Resultados agrupados: **Te necesitan** (acción requerida o aviso), **Sesiones** abiertas con su indicador de estado y su proyecto, **Proyectos** (tableros de Pulso del resumen ya cargado, con Pendientes) y **Acciones**. La búsqueda ignora mayúsculas y acentos, admite subcadenas e iniciales y ordena por coincidencia y después por prioridad de estado. Las fases de Pulso no se buscan todavía: el cliente no las tiene cargadas y la paleta no hace lecturas nuevas (entrega E).
- Acciones: nueva sesión, abrir la sesión que más te necesita, marcar avisos como vistos, dividir/unificar, enfocar el otro panel, ir a Pulso/volver a la terminal, nuevo proyecto, buscar en la lista de agentes, agrupar por proyecto/estado, Abiertas/Historial, Información, Configuración, apariencia y, sobre la sesión del panel enfocado, cambiar nombre, interrumpir y terminar. Terminar y Cambiar nombre abren su confirmación o formulario de siempre; Interrumpir solo enfoca su botón. Ninguna acción escribe en un terminal ni concede permisos de Pulso. Las no disponibles aparecen deshabilitadas con el motivo.
- Teclado y accesibilidad: patrón combobox + listbox con grupos con nombre, flechas, Inicio/Fin con la búsqueda vacía, Intro, Escape o clic fuera para cerrar, anuncio del número de resultados y foco devuelto al elemento anterior (normalmente el terminal). Ninguna tecla escrita en la paleta, ni el propio atajo, llega al PTY o a un campo de Codex, y los atajos globales se ignoran mientras está abierta. No se abre sobre otro diálogo modal; el selector de sesión, el popover de avisos y los menús se cierran antes.
- En Pulso, navegar desde la paleta (otro tablero, una sesión, volver a la terminal o nuevo proyecto) respeta las guardas del borrador.
- `⌘K` no cambia: sigue abriendo y enfocando la búsqueda de la lista de agentes (sus pruebas y su flujo dependen de ese campo). Los atajos `⌘N`, `⌘K`, `⌘I` y `⌘,` salen de `main.ts` a un registro único (`shortcuts.ts`, `app-commands.ts`) que usan el manejador de atajos y la paleta.
- Tras la revisión: mantener `⌘⇧P` pulsado (repetición de tecla) ya no abre y cierra la paleta ni devuelve las teclas siguientes al PTY o al campo de Codex; ningún atajo actúa durante una composición IME. Al cerrar, el foco vuelve al disparador del menú o selector que se cerró al abrirla (botón «…» de la tarjeta, nombre de sesión del panel) o, si ya no existe, al terminal del panel enfocado, nunca a `body`. Unificar paneles deja el teclado en el terminal que queda. Los tableros, las fases, «Nuevo proyecto» y «Volver a la terminal» aparecen deshabilitados con el motivo mientras Pulso tiene un borrador o un guardado fallido. Con la paleta abierta, cada `status` sin cambios no toca su lista ni su región `aria-live`.

### Sin publicar · 1.4.0 entrega E: Pulso en el runner

- `status` añade `pulsoRevision` (revisión de Pulso confirmada, leída de memoria sin SQLite y actualizada tras cada escritura de la UI o del MCP) y `pulsoRevisionVersion: 1`; no aparecen si Pulso no está disponible. También anuncia `pulsoSummaryVersion: 1` y `pulsoBoardCardsVersion: 1`. Ningún `*Version` existente cambia.
- Operación de Pulso `sidebar_summary {ifRevision?}`, solo para la UI: proyectos no archivados (hasta 50) con fases hechas/totales, Pendientes abiertos y pares sesión → proyecto por vínculo de proyecto o de fase (hasta 2.048, con `linksTruncated`). Se acaba el tope de 100 vínculos por proyecto. Un permiso de agente recibe `unauthorized`. El bridge la admite solo con `ifRevision` entero sin signo.
- Las tarjetas de `board` añaden `session` (`{id, source: "link"|"checkpoint"}` o `null`) y `checkpointCount` (total real). Una consulta por página; en release, unos 0,1-0,3 ms y 5-8 KB más con 80 tarjetas.
- Sin cambios de esquema en `pulso.sqlite` ni en `runner.sqlite`; todas las consultas usan índices existentes. La app 1.3.x ignora los campos nuevos. La interfaz que los usa llega en la sección siguiente.

### Sin publicar · 1.4.0 entrega E: Pulso en la interfaz

- Con `pulsoRevisionVersion: 1`, la barra lateral relee su resumen cuando `status.pulsoRevision` cambia y la ventana está visible; con la ventana oculta el cambio queda pendiente hasta volver. Los demás disparadores (foco, sesiones, salir del tablero, cambios propios) solo leen si la revisión del resumen ya no es la del runner. Se retira la heurística de releer cuando un agente informa `done`/`idle`: las ediciones por MCP llegan en ≤ 1 s sin depender del turno.
- El tablero visible deja de pedir `revision` cada 2 s: se actualiza con la revisión de cada `status`, y los cambios de sesiones o de conexión vuelven a pintar sin leer Pulso. Se mantienen las guardas de borrador, error, escritura, arrastre y navegación. Con nada cambiado, la barra lateral y el tablero hacen cero lecturas de Pulso por ciclo de `status`.
- Con `pulsoSummaryVersion: 1`, la barra lateral usa una sola lectura `sidebar_summary` (con `ifRevision`) en lugar de `projects` más tres lecturas por proyecto y dos de Pendientes. «Por proyecto» agrupa también las sesiones vinculadas a una **fase**; la sesión principal sigue teniendo prioridad. Se siguen mostrando 20 proyectos y «Más proyectos…»; si el runner recorta los vínculos, el grupo «Sin proyecto» lo indica en su título.
- Con `pulsoBoardCardsVersion: 1`, cada tarjeta muestra un pie con la sesión vinculada (indicador de estado en vivo con las cinco formas, insignia del proveedor y nombre truncado) y «n checkpoints» (oculto si es 0). Pulsar o Intro abre esa sesión: la viva se enfoca, la cerrada muestra su historial; no abre el detalle ni arrastra, y queda deshabilitado con un borrador. Si sale del último checkpoint lo dice su etiqueta («Sesión del último checkpoint»). Una sesión que el cliente no conoce se muestra como «Sesión no disponible», sin acción. El estado se actualiza con cada `status` sin volver a leer `board`.
- Paleta de comandos: grupo **Fases** con las fases del tablero de proyecto ya cargado (columna y proyecto como detalle). Elegir una abre Pulso y su detalle con las guardas habituales; escribir no hace lecturas.
- Con un runner 1.3.x (sin esas capacidades) la interfaz se comporta como antes: varias lecturas por proyecto, temporizador de 2 s, relectura al terminar un turno y tarjetas sin pie. Nueva suite `tests/browser/pulso-revision.test.ts` (Chrome y WebKit) con ambos modos.

### Sin publicar · 1.4.0 entrega E: atención de agentes en el runner

- El runner lee la salida de cada PTY y reconoce OSC 7501 raíz, BEL y notificaciones OSC 9/777 con las mismas reglas que la interfaz, aunque las secuencias lleguen partidas. Nunca guarda ni publica títulos, mensajes ni texto de las notificaciones. El estado es una declaración de la salida del terminal, no la verdad del agente. Vectores compartidos en `desktop/tests/fixtures/program-status-vectors.json`.
- Registro por sesión: estado declarado, turno (inicio, fin, duración monotónica, interrumpido) y avisos `needs`, `finished`, `bell`, `notify` (1 por segundo), `ended` (solo `exited`/`stopped`/`failed`) y `permission` (solo solicitudes de Codex nuevas), cada uno con su secuencia y, si viene del PTY, el frame que lo completó.
- `status` añade `agent` por sesión (primero las pendientes; como mucho 256, con `agentAttention.hasMore` y totales de pendientes) y `agentAttentionVersion: 1`; `terminal_live` añade el `agent` de la sesión. Ningún `*Version` existente cambia y los frames son los mismos: la app 1.3.x sigue igual.
- Operación nueva `mark_seen {items:[{id, through}]}` (hasta 64), monótona e idempotente, en el runner y en el bridge. No toma el cerrojo de mutaciones, no toca custodia y no responde permisos. Marcar lo pintado nunca oculta un aviso posterior.
- Persistencia en la tabla nueva `agent_attention` de `runner.sqlite`, sin cambiar `user_version` (5), sin FK, triggers ni prefijo `storage_`. `mark_seen` responde tras confirmar en disco (`durable`); el resto se confirma en menos de 250 ms y al cerrar el runner. Purgar o compactar el historial no borra la atención; los avisos sin ver nunca se descartan. Un runner 1.3.3 abre el perfil, purga y compacta sin tocar la tabla (comprobado con su binario).
- El escaneo ocurre fuera del candado de publicación: en una ráfaga de 50 MiB con `resize` cada 5 ms, `resize` p99 bajó de 2,8–7,7 ms a 0,3–0,7 ms y el drenaje no empeoró. La interfaz que consume este contrato llega aparte.

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

[Unreleased]: https://github.com/StevenSantacruz56/jauria-sessions/compare/v1.3.3...HEAD
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
