# Pulso: proyectos, fases y continuidad

Pulso es el espacio de planificación dentro de Jauria 1.3.0. Cada proyecto representa un plan completo y tiene una pestaña de tablero con cuatro columnas fijas: **Por hacer, En curso, En espera y Hecho**. Jira puede conservar las especificaciones y el seguimiento de equipo.

## Empezar desde una sesión

1. Abre Claude Code o Codex como siempre, incluso desde tu carpeta personal y sin Git.
2. Entra a Pulso y pulsa el **+** (Nuevo proyecto) junto a las pestañas de tableros, en la barra superior. Escribe **Nombre del proyecto**. Si hay sesión actual, **Usar «…» como sesión principal** aparece marcada; puedes desmarcarla. La casilla conserva la sesión que nombra aunque cambies de terminal antes de crear el proyecto. Pulsa **Crear proyecto** para abrir su pestaña de tablero.
3. Usa **Añadir fase** en Por hacer, En curso o En espera. Escribe el título y confirma **Añadir tarjeta**: se crea directamente en esa columna. Hecho no tiene captura inline.
4. Arrastra el agarre de una tarjeta con el puntero hasta otra columna o abre su menú **…** (Mover a Por hacer, En curso, En espera o Hecho), también con el teclado. Ambas acciones cambian el estado y conservan el orden de fases. No hay reordenación dentro de una columna, columnas personalizadas ni traslado entre proyectos.
5. Pulsa el título de una tarjeta para ver el detalle derecho. Edita título, notas y estado; consulta **Último avance** y **Siguiente paso** cuando existe un checkpoint. **Guardar avance** está plegado hasta que quieras registrar continuidad. Abrir la tarjeta no crea ni inicia un PTY.
6. Abre **Plan y sesiones** en la barra del proyecto para editar el plan opcional, cambiar la sesión principal y vincular sesiones. **Configurar permisos…** abre el acceso manual de una sesión existente. La principal no cambia automáticamente cuando termina.

La pestaña fija **Pendientes** muestra tarjetas independientes sin proyecto, incluidas las que están en Hecho. Usa **Añadir pendiente** en las tres primeras columnas. No necesita repositorio ni sesión.

Crear un proyecto de Pulso no crea ramas ni worktrees. Jauria ya no tiene Repositorios ni tareas Git desde 1.4; los datos de esa función en un perfil anterior se conservan y se ignoran.

## Lectura del tablero

El endpoint `board` es exclusivo de la UI y obtiene un snapshot atómico bajo el mutex del servicio Pulso: revisión, las cuatro columnas, hasta 20 tarjetas iniciales por columna y sus contadores totales. No amplía el alcance del agente ni es una nueva operación disponible mediante su permiso CLI. `ifRevision` permite responder sin reconstruir columnas cuando no hay cambios.

**Ver más tarjetas** usa `items` con `status`, `expectedSnapshotRevision` y páginas de hasta 50. El servicio comprueba revisión, cuenta y consulta bajo el mismo mutex. Rechaza una revisión obsoleta antes de usar el offset; consulta el tablero actual ante un conflicto para no mezclar páginas de revisiones diferentes. Los contadores incluyen las tarjetas aún no cargadas.

Desde el runner 1.4 cada tarjeta de `board` añade dos claves (capacidad `pulsoBoardCardsVersion: 1` en `status`; `pulsoBoardVersion` sigue en 1 y no hay argumentos nuevos):

- `session`: `{"id","source"}` o `null`. `source` es `"link"` si sale del vínculo de fase más reciente y `"checkpoint"` si no hay vínculo y sale del checkpoint más reciente que nombra una sesión. Un vínculo al proyecto no cuenta para la tarjeta.
- `checkpointCount`: número total de checkpoints de la fase, no solo los 10 del detalle.

Se calculan con una sola consulta para toda la página (como mucho 80 tarjetas) sobre el índice de fases existente. Solo cambian las tarjetas de `board`: `item`, `items` y lo que ve un agente siguen igual.

### Resumen de la barra lateral y revisión en `status`

`sidebar_summary {ifRevision?}` es también exclusivo de la UI: un permiso de agente recibe `unauthorized` aunque llame a la operación directamente. Devuelve en una lectura los primeros 50 proyectos no archivados, en el mismo orden que `projects`, con fases hechas y totales (sin archivadas), el número de Pendientes abiertos y los pares sesión → proyecto. Un par sale de un vínculo al proyecto o de un vínculo a una de sus fases, incluidas las archivadas; si una sesión tiene los dos, aparece una vez con `via: "project"`. Los pares se ordenan por proyecto y sesión y se cortan en 2.048 (o 256 KiB) con `linksTruncated`; ya no hay tope de 100 vínculos por proyecto. Con `ifRevision` igual a la revisión actual responde `{"revision","unchanged":true}` sin consultar documentos. Capacidad: `pulsoSummaryVersion: 1`.

`status` del runner incluye `pulsoRevision`, la revisión global de Pulso confirmada más reciente, y `pulsoRevisionVersion: 1`. Se lee de memoria, sin SQLite, y se actualiza tras cada `COMMIT`, venga de la UI o del MCP de un agente (ambos escriben a través del socket del runner). Un reintento con el mismo `requestId`, una escritura rechazada o un rollback no la mueven. Si Pulso no está disponible, los dos campos no aparecen.

Con un runner 1.4 la interfaz usa esa revisión en lugar de sondear:

- **Barra lateral:** relee `sidebar_summary` (una llamada, con `ifRevision`) solo cuando `pulsoRevision` cambia y la ventana está visible; si está oculta queda pendiente y se relee al volver. Los demás disparadores (foco, sesiones, salir del tablero) solo leen si el resumen ya no tiene la revisión del runner. Ya no relee al terminar un turno. Agrupa por proyecto las sesiones vinculadas al proyecto y a sus fases; muestra 20 proyectos y «Más proyectos…».
- **Tablero visible:** cada `status` compara su revisión con la del tablero cargado y solo entonces vuelve a leer `projects` y `board`. Un cambio en las sesiones o en la conexión vuelve a pintar tarjetas, sesiones vinculadas y etiquetas de programa sin leer Pulso. Con un borrador, un error, una escritura, un arrastre o una navegación en curso espera al siguiente `status`.
- **Pie de tarjeta:** sesión vinculada con su estado en vivo y «n checkpoints». Abre la sesión viva o su historial; con un borrador está deshabilitado. Si la sesión ya no está en este perfil se muestra «Sesión no disponible», sin acción. El estado se actualiza con cada `status` sin volver a leer `board`.

Con un runner 1.3.x, mientras Pulso está visible y sin borrador, error, escritura o arrastre en curso, comprueba revisiones cada dos segundos, y la barra lateral hace sus lecturas por proyecto en los eventos de antes, incluido el fin de turno. En ambos casos no consulta por tarjeta; la vista oculta o el documento oculto detienen las lecturas. No introduce trabajo de planificación en el bucle de teclado/salida de las terminales.

La paleta de comandos ofrece en **Fases** las fases del tablero de proyecto ya cargado; elegir una abre su detalle con las mismas guardas de borrador. No hace lecturas mientras escribes.

## Recuperar el trabajo

Al volver a Pulso se restaura el último tablero de este perfil. Solo se guarda su identificador: no se ejecutan agentes ni se restauran permisos al abrirlo. Si el proyecto fue archivado o ya no existe, se muestran los Pendientes.

En la barra del proyecto, **Abrir sesión principal** vuelve a la sesión viva. Si terminó y Jauria registró su identidad Claude, **Continuar sesión principal** intenta abrir esa misma conversación (desde 1.4.0 el verbo es siempre «continuar»; antes, «Reanudar»). Si la continuación ya está abierta, **Abrir conversación activa** la enfoca, incluso con todas las plazas ocupadas. Puedes cerrar el detalle para usar la acción de la barra.

Desde una fase se prioriza la sesión de su último checkpoint; después su vínculo y finalmente la principal. Continuar retoma el estado actual del proveedor, no rebobina hasta esa fase. Si no existe identidad registrada, consulta **Ver historial** o prepara el contexto para una sesión nueva; para Codex en terminal, Pulso dice que no permite continuar la conversación y ofrece **Empezar de nuevo aquí** (Nueva sesión con la misma carpeta, herramienta y nombre). Una comprobación fallida muestra **Reintentar comprobación** y nunca inicia otra sesión automáticamente.

| Acción | Qué hace |
| --- | --- |
| Enfocar sesión viva | Vuelve a la misma terminal y proceso. |
| Ver historial | Abre la vista Historial (no un panel de trabajo) con la salida local de una sesión terminada; no la reinicia. |
| Preparar contexto | Prepara texto editable a partir del plan, la fase y su último checkpoint. Puedes copiarlo y abrir otra sesión; Jauria no lo pega ni lo envía. |
| Continuar conversación / sesión principal / sesión de la fase | Para una conversación Claude cuya identidad reservó Jauria, inicia la CLI con ese ID exacto en una sesión nueva. No garantiza que Claude haya conservado su historial. |
| Abrir conversación activa | Enfoca la continuación administrada que ya está viva para esa misma identidad. |

La continuación conserva metadatos de origen y añade un vínculo de la nueva sesión al proyecto o fase desde donde se solicitó. Si el vínculo falla después del inicio, la interfaz lo avisa y puedes añadirlo manualmente. La sesión principal original se conserva.

**Herencia del vínculo (1.4.0).** Continuar una conversación desde cualquier sitio (panel de una Interrumpida, vista Historial, barra lateral, paleta o Pulso) usa un único camino, y la sesión nueva hereda automáticamente los vínculos de la original, con un aviso visible: si la original era sesión principal o estaba vinculada a un proyecto, la nueva queda **vinculada a ese proyecto** (la sesión principal no se cambia); si estaba vinculada a una fase, a **esa fase**. Solo se usan operaciones existentes: `sidebar_summary` para saber qué proyectos nombran la sesión original y, para las fases, el pie de tarjeta de `board` (primera página de cada columna, la sesión más reciente vinculada a cada fase). Cada vínculo se escribe con el mismo identificador de petición que usa Pulso para su propio vínculo de continuación, así que repetirlo no lo duplica. Límites: una fase fuera de la primera página del tablero, cuya sesión más reciente no sea la original, o un pendiente sin proyecto no se encuentran (el aviso dice qué no se heredó); con un runner 1.3.x no se comprueba y el aviso lo dice. Nunca se pega ni se envía nada a la sesión.

Las fases organizan el trabajo; no son puntos para rebobinar una conversación. La reanudación nativa continúa su estado actual. Para otro camino desde una fase, usa su contexto guardado en una sesión nueva.

Jauria no adivina conversaciones por la carpeta o por cuál fue la última. Las conversaciones antiguas sin identidad registrada y las de Codex en terminal conservan historial local y continuidad por contexto; la reanudación nativa de Codex queda pendiente. No se cambia Codex al modo de conversación estructurada.

Los bloqueos existentes siguen vigentes: no se inicia otro escritor sobre un worktree ocupado ni otra sesión administrada de la misma conversación Claude activa o incierta. Un error de reanudación queda visible; no se convierte silenciosamente en una conversación nueva.

## Guardar una fase

En el drawer de la tarjeta despliega **Guardar avance** y registra qué quedó listo y la siguiente acción. **Sesión del checkpoint** empieza en **Sin sesión**; elige una si quieres vincular ese avance. Los puntos de continuidad (checkpoints) son inmutables: se añaden al historial y no reemplazan los anteriores. El detalle muestra los 10 más recientes; **Ver puntos anteriores** carga otros 10 cada vez. Evita copiar secretos o transcripciones completas: basta el estado necesario para continuar.

Cambiar una fase a **Hecho** registra avance de agenda. No implica pruebas aprobadas, aceptación de código, merge ni modificación de Jira. Terminar una sesión o un turno tampoco completa una fase automáticamente.

## Acceso de Claude Code y Codex a Pulso

En Jauría 1.3.3, **Configuración → Pulso y agentes → Acceso automático a Pulso** está activado de forma predeterminada. Cada sesión nueva de Claude Code o Codex iniciada desde Jauría recibe su propio servidor MCP local y un permiso privado para leer y editar todos los proyectos de Pulso y crear proyectos. No cambia los permisos nativos para archivos, comandos o red de cada proveedor. Los agentes iniciados fuera de Jauría no reciben la credencial. El permiso se revoca al terminar la sesión y el interruptor puede apagar el acceso automático en cualquier momento.

El servidor se inyecta solo en el proceso de esa sesión. Jauría no modifica `~/.claude` ni `~/.codex/config.toml`, y no coloca el token en argumentos, variables de entorno ni mensajes. La configuración de inicio incluye la ruta del archivo privado del permiso; el servidor vuelve a validarlo en cada operación. Claude Code conserva sus otros servidores MCP. La conexión estructurada de Codex mantiene deshabilitados los servidores ajenos a Jauría en ese modo.

Una sesión que ya estaba abierta al actualizar la app no descubre el MCP nuevo. En **Configuración → Pulso y agentes → Dar o quitar acceso a una sesión ya abierta**, selecciona la sesión y elige un proyecto o **Crear proyectos propios**. Pulsa **Conceder acceso y ver comando** y usa **Copiar instrucciones para el agente**. El permiso manual conserva el alcance elegido; una política recordada para proveedor y carpeta sigue siendo más estrecha que el acceso predeterminado. Para evitar el comando manual, abre una sesión nueva después de instalar la actualización.

Por ejemplo, puedes pedir al agente:

> Registra este plan como proyecto de Jauria. Crea sus fases en el orden acordado. Antes de cambiar de fase, guarda qué quedó listo y el siguiente paso. Consulta la revisión vigente antes de actualizar y no sobrescribas un conflicto.

Si Claude pregunta qué es Pulso, indícale: «Pulso es el tablero local de proyectos, fases y avances de Jauría. Consulta las herramientas `jauria_*` y espera a que te indique el plan». No pegues tokens ni el contenido del archivo de permiso en el chat.

El MCP local ofrece herramientas para listar y crear proyectos y fases, leer revisiones, actualizar fases y registrar checkpoints. Comprueba la conexión con `/mcp` en Claude Code o la lista MCP de Codex. [Claude Code](https://code.claude.com/docs/en/mcp) y [Codex](https://developers.openai.com/codex/mcp/) documentan sus clientes MCP.

### Ejemplo técnico sintético

El prefijo real lo proporciona Pulso. Tras ese prefijo puedes ejecutar:

```text
projects {"limit":50}
project_create {"id":"plan-demo","requestId":"create-plan-demo","title":"Plan sintético"}
item_create {"id":"phase-demo","requestId":"create-phase-demo","projectId":"plan-demo","title":"Validar integración"}
item {"id":"phase-demo"}
```

Pasa cada objeto JSON como un único argumento correctamente citado para tu shell. Para editar usa `item_update` con `expectedRevision` obtenido del registro actual; para guardar continuidad usa `checkpoint_create` con `itemId`, `expectedRevision` de la fase, `brief`, `nextAction`, un ID y un `requestId` estables. Los IDs del ejemplo son sintéticos; para registros nuevos genera UUID y conserva los mismos al reintentar. Un proyecto creado por un agente adopta su sesión como principal por defecto.

Si hay timeout, conserva el mismo `requestId`, ID y contenido al consultar/reintentar. Si hay conflicto de revisión, relee el registro y decide qué conservar; no sobrescribas a ciegas. Los errores de conexión no se encolan para ejecutarse después.

## Privacidad, permisos y límites

- Los datos se guardan en `pulso.sqlite` dentro del perfil local, separados del scrollback y sin depender del Site de Pulso. La aplicación web anterior permanece independiente; no se importan ni sincronizan automáticamente sus datos.
- El endpoint de planificación tiene credencial, socket y límite de conexiones propios. La CLI del agente usa el permiso de su sesión y no lee el token de administración del runner. Los permisos manuales pueden acotarse por proyecto; el acceso automático predeterminado abarca todos los proyectos de Pulso.
- Un permiso de Pulso no reemplaza los permisos de archivos, comandos, sandbox o MCP nativos de Claude/Codex. Tampoco aísla procesos del mismo usuario de macOS.
- El texto de **Copiar instrucciones para el agente** incluye una ruta absoluta al archivo de permiso, pero no el token guardado dentro. Al pegarlo en una conversación, el proveedor recibe esa ruta. Úsalo solo en la sesión elegida; el MCP de sesiones nuevas evita incluirla en el prompt. No publiques el archivo de permiso, el perfil, su base SQLite ni el historial.
- Lo que una sesión lee puede llegar al proveedor de ese agente. Si un proyecto contiene información que no quieres ofrecer a Claude Code o Codex, apaga el acceso automático antes de iniciar la sesión y usa el permiso manual de un solo proyecto.
- Título: hasta 240 caracteres; nota: 1.000; plan: 32.000; resumen de continuidad: 4.000; siguiente acción: 1.000. Proyectos y fases se consultan con páginas acotadas en SQL; el plan completo se solicita solo al abrir el proyecto.
- Pulso admite hasta **64 MiB lógicos o 100.000 filas**, contando registros, actividad y recibos, no solo tareas. Hay **1 MiB y 2.000 filas adicionales de margen para identidades de permisos y políticas**; no amplían la capacidad para planes. La base `pulso.sqlite` tiene además un límite físico de **128 MiB**, independiente del historial de terminal y del resto del perfil.
- Al alcanzar el presupuesto, las lecturas continúan y se rechazan nuevos cambios que lo excedan. El margen de permisos no elimina el límite físico. No hay borrado automático ni interfaz de exportación para liberar espacio. Si el módulo no puede abrirse, las terminales siguen disponibles y los datos se conservan para revisión.

## Estado de programa explícito: OSC 7501

La UI escucha pasivamente OSC 7501 en la salida de una sesión viva. El payload admite hasta **1.024 bytes UTF-8** y campos `clave=valor` separados por `:`. Solo interpreta el campo raíz `state`, con valores exactos `working`, `blocked`, `error`, `done`, `idle` o `clear`; este último borra la señal. No deduce estados a partir de texto, silencio o marca del agente.

Campos como `msg`, `title` o `progress` se ignoran: no se muestran ni ejecutan. Registros dirigidos a hijos mediante `id` y consultas se descartan sin respuesta. Payloads ambiguos, estados duplicados o inválidos y caracteres de control se rechazan. Es un subconjunto explícito, no una implementación completa del protocolo Herdr.

El estado es cosmético y efímero en la vista viva: no escribe fases, checkpoints ni estado persistido del runner. La reproducción del historial no aplica señales ni dispara avisos; al reconectar se reinicia el seguimiento. Si el agente no emite el protocolo, no aparece estado de programa. Jauria no instala hooks, responde al terminal ni modifica configuraciones para habilitarlo.

Las actualizaciones visuales se agrupan; las transiciones relevantes de sesiones no atendidas pueden producir avisos, con un límite de uno cada **5 segundos por sesión**. Una señal `done` indica lo declarado por el programa; no equivale a fase Hecho ni a pruebas aprobadas.

Consulta [la revisión de Herdr y matriz de decisiones](HERDR_REVIEW.md), [la entrega 1.3.0](RELEASE_1.3.0.md) y [su validación](PULSO_VALIDATION_1.3.0.md).

## Respaldo local

Esta es una guía manual, no una función de exportación de la app. Para una copia consistente usa la función de respaldo de SQLite; **no copies directamente `pulso.sqlite` mientras el runner lo tenga abierto**.

Con `sqlite3` disponible, sustituye las rutas por el perfil correcto y una carpeta privada existente fuera de ese perfil. Usa un destino nuevo:

```sh
umask 077
sqlite3 -readonly '/ruta/al/perfil/pulso.sqlite' ".backup '/ruta/privada/pulso-respaldo.sqlite'"
sqlite3 -readonly '/ruta/privada/pulso-respaldo.sqlite' 'PRAGMA quick_check;'
```

Comprueba que el respaldo termine sin errores y que la verificación devuelva `ok`. Si falla o la base está ocupada, conserva el original y vuelve a intentarlo. Esta copia incluye solo Pulso; no incluye salida de terminal, reservas de identidad Claude ni historial del proveedor. No reemplaces la base de un runner activo para restaurarla; resuelve antes las sesiones y detén el runner mediante el flujo habitual. No hay restauración desde la interfaz.

Una app nueva conectada a un runner antiguo muestra Pulso deshabilitado. Para activar el nuevo runner hay que resolver las sesiones activas por el flujo habitual; instalar o abrir la interfaz no autoriza detenerlas automáticamente.

Las tarjetas muestran una vista previa de la nota (hasta 240 caracteres). Abrir el detalle carga la nota completa; mover una tarjeta no reescribe su nota. Al refrescar, las columnas ya ampliadas se recuperan en páginas de la misma revisión, conservando lo que tenías cargado.
