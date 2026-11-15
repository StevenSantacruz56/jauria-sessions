# Pulso: proyectos, fases y continuidad

Pulso es el espacio de planificación dentro de Jauria 1.3.0. Cada proyecto representa un plan completo y tiene una pestaña de tablero con cuatro columnas fijas: **Por hacer, En curso, En espera y Hecho**. Jira puede conservar las especificaciones y el seguimiento de equipo.

## Empezar desde una sesión

1. Abre Claude Code o Codex como siempre, incluso desde tu carpeta personal y sin Git.
2. Entra a Pulso y pulsa **Nuevo proyecto**. Escribe **Nombre del proyecto**. Si hay sesión actual, **Usar «…» como sesión principal** aparece marcada; puedes desmarcarla. La casilla conserva la sesión que nombra aunque cambies de terminal antes de crear el proyecto. Pulsa **Crear proyecto** para abrir su pestaña de tablero.
3. Usa **Añadir fase** en Por hacer, En curso o En espera. Escribe el título y confirma **Añadir tarjeta**: se crea directamente en esa columna. Hecho no tiene captura inline.
4. Arrastra el agarre de una tarjeta con el puntero hasta otra columna o cambia el selector **Mover** con el teclado. Ambas acciones cambian el estado y conservan el orden de fases. No hay reordenación dentro de una columna, columnas personalizadas ni traslado entre proyectos.
5. Pulsa el título de una tarjeta para ver el detalle derecho. Edita título, notas y estado; consulta **Último avance** y **Siguiente paso** cuando existe un checkpoint. **Guardar avance** está plegado hasta que quieras registrar continuidad. Abrir la tarjeta no crea ni inicia un PTY.
6. Abre **Plan y sesiones** en la barra del proyecto para editar el plan opcional, cambiar la sesión principal y vincular sesiones. **Configurar permisos…** lleva a Configuración con el proyecto elegido; allí debes seleccionar expresamente la sesión que recibirá acceso. La principal no cambia automáticamente cuando termina.

La pestaña fija **Pendientes** muestra tarjetas independientes sin proyecto, incluidas las que están en Hecho. Usa **Añadir pendiente** en las tres primeras columnas. No necesita repositorio ni sesión.

**Repositorios** organiza carpetas Git y tareas técnicas. Crear un proyecto de Pulso no crea ramas ni worktrees; **Registrar repositorio… / Nueva tarea Git** conserva el flujo Git anterior.

## Lectura del tablero

El endpoint `board` es exclusivo de la UI y obtiene un snapshot atómico bajo el mutex del servicio Pulso: revisión, las cuatro columnas, hasta 20 tarjetas iniciales por columna y sus contadores totales. No amplía el alcance del agente ni es una nueva operación disponible mediante su permiso CLI. `ifRevision` permite responder sin reconstruir columnas cuando no hay cambios.

**Ver más tarjetas** usa `items` con `status`, `expectedSnapshotRevision` y páginas de hasta 50. El servicio comprueba revisión, cuenta y consulta bajo el mismo mutex. Rechaza una revisión obsoleta antes de usar el offset; consulta el tablero actual ante un conflicto para no mezclar páginas de revisiones diferentes. Los contadores incluyen las tarjetas aún no cargadas.

Mientras Pulso está visible y sin borrador, error, escritura o arrastre en curso, comprueba revisiones cada dos segundos. No consulta por tarjeta; la vista oculta o el documento oculto detienen ese polling. No introduce trabajo de planificación en el bucle de teclado/salida de las terminales.

## Recuperar el trabajo

Al volver a Pulso se restaura el último tablero de este perfil. Solo se guarda su identificador: no se ejecutan agentes ni se restauran permisos al abrirlo. Si el proyecto fue archivado o ya no existe, se muestran los Pendientes.

En la barra del proyecto, **Abrir sesión principal** vuelve a la sesión viva. Si terminó y Jauria registró su identidad Claude, **Reanudar sesión principal** intenta abrir esa misma conversación. Si la continuación ya está abierta, **Abrir conversación activa** la enfoca, incluso con todas las plazas ocupadas. Puedes cerrar el detalle para usar la acción de la barra.

Desde una fase se prioriza la sesión de su último checkpoint; después su vínculo y finalmente la principal. Reanudar continúa el estado actual del proveedor, no rebobina hasta esa fase. Si no existe identidad registrada, consulta **Ver historial** o prepara el contexto para una sesión nueva. Una comprobación fallida muestra **Reintentar comprobación** y nunca inicia otra sesión automáticamente.

| Acción | Qué hace |
| --- | --- |
| Enfocar sesión viva | Vuelve a la misma terminal y proceso. |
| Ver historial | Consulta la salida local de una sesión terminada; no la reinicia. |
| Preparar contexto | Prepara texto editable a partir del plan, la fase y su último checkpoint. Puedes copiarlo y abrir otra sesión; Jauria no lo pega ni lo envía. |
| Intentar reanudar conversación | Para una conversación Claude cuya identidad reservó Jauria, inicia la CLI con ese ID exacto. No garantiza que Claude haya conservado su historial. |
| Abrir conversación activa | Enfoca la continuación administrada que ya está viva para esa misma identidad. |

La reanudación conserva metadatos de origen y añade un vínculo de la nueva sesión al proyecto o fase desde donde se solicitó. Si el vínculo falla después del inicio, la interfaz lo avisa y puedes añadirlo manualmente. La sesión principal original se conserva.

Las fases organizan el trabajo; no son puntos para rebobinar una conversación. La reanudación nativa continúa su estado actual. Para otro camino desde una fase, usa su contexto guardado en una sesión nueva.

Jauria no adivina conversaciones por la carpeta o por cuál fue la última. Las conversaciones antiguas sin identidad registrada y las de Codex en terminal conservan historial local y continuidad por contexto; la reanudación nativa de Codex queda pendiente. No se cambia Codex al modo de conversación estructurada.

Los bloqueos existentes siguen vigentes: no se inicia otro escritor sobre un worktree ocupado ni otra sesión administrada de la misma conversación Claude activa o incierta. Un error de reanudación queda visible; no se convierte silenciosamente en una conversación nueva.

## Guardar una fase

En el drawer de la tarjeta despliega **Guardar avance** y registra qué quedó listo y la siguiente acción. **Sesión del checkpoint** empieza en **Sin sesión**; elige una si quieres vincular ese avance. Los puntos de continuidad (checkpoints) son inmutables: se añaden al historial y no reemplazan los anteriores. El detalle muestra los 10 más recientes; **Ver puntos anteriores** carga otros 10 cada vez. Evita copiar secretos o transcripciones completas: basta el estado necesario para continuar.

Cambiar una fase a **Hecho** registra avance de agenda. No implica pruebas aprobadas, aceptación de código, merge ni modificación de Jira. Terminar una sesión o un turno tampoco completa una fase automáticamente.

## Permitir que los agentes registren planes

El acceso empieza desactivado. Desde **Configuración → Permisos de agentes**, selecciona una sesión viva y elige explícitamente un proyecto **o** la opción **Crear proyectos propios**. Pulsa **Conceder acceso y ver comando**. El permiso queda limitado al alcance elegido: permite actualizar sus fases y marcarlas Hecho, sin compartir toda tu agenda ni los pendientes independientes.

La casilla **Recordar para futuras sesiones de esta herramienta en esta carpeta** empieza desmarcada. Puedes marcarla para guardar una política. Esa política solo se aplica al proveedor y a la ruta canónica elegidos. Cada sesión futura recibe una credencial nueva; detener una sesión invalida su acceso. Puedes gestionar y revocar los permisos recordados desde el mismo bloque de acceso.

Pulso proporciona un comando copiable, con una ruta a un permiso privado. Compártelo con esa conversación y pide, por ejemplo:

> Registra este plan como proyecto de Jauria. Crea sus fases en el orden acordado. Antes de cambiar de fase, guarda qué quedó listo y el siguiente paso. Consulta la revisión vigente antes de actualizar y no sobrescribas un conflicto.

El comando y su guía explican la API. No hace falta copiar un token al chat ni cambiar la configuración MCP de tus herramientas. La primera integración usa una CLI local; un adaptador MCP no forma parte de esta entrega.

Para sesiones ya iniciadas, utiliza el comando que muestra Pulso. Las nuevas también reciben `JAURIA_PULSO_CLIENT` y `JAURIA_PULSO_HANDLE` en su entorno, sin conceder acceso por el mero hecho de tener esas variables.

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
- El endpoint de planificación tiene credencial, socket y límite de conexiones propios. La CLI del agente utiliza un permiso acotado y no lee el token de administración del runner.
- Un permiso de Pulso no reemplaza los permisos de archivos, comandos, sandbox o MCP nativos de Claude/Codex. Tampoco aísla procesos del mismo usuario de macOS.
- Lo que una sesión lee puede llegar al proveedor de ese agente. Concede solo el contexto que quieras compartir.
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
