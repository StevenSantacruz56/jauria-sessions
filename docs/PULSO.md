# Pulso: proyectos, fases y continuidad

Pulso es el espacio de planificación dentro de Jauria 1.1.0. Un proyecto representa un plan completo y puede vincular la sesión donde lo planteaste. Sus fases muestran qué está por hacer, en curso, en espera o hecho. Jira sigue siendo el lugar para especificaciones y seguimiento de equipo.

## Empezar desde una sesión

1. Abre Claude Code o Codex como siempre. También puedes trabajar desde tu carpeta personal, sin Git.
2. Entra a **Pulso · Proyectos y fases**. Captura un título y elige **Proyecto**.
3. Al elegir **Proyecto**, si hay una sesión actual, aparece marcada **Usar «…» como sesión principal**. Déjala marcada para vincular esa conversación al crear el plan; desmárcala si no corresponde. Después puedes elegir o cambiar la principal en el detalle. El texto del plan es opcional; no necesitas repetir una especificación de Jira.
4. Añade sus fases, en el orden del trabajo. Cada fase necesita solo un título y puede tener una nota breve.
5. Vincula otras sesiones al proyecto o a una fase cuando participen. La principal no cambia automáticamente si termina.

Un **pendiente independiente** no necesita proyecto, repositorio ni sesión. El **proyecto de Pulso** organiza un plan de trabajo o de negocio; **Repositorios** organiza carpetas Git y tareas técnicas. Crear un plan no crea ramas ni worktrees. **Registrar repositorio… / Nueva tarea Git** conserva el flujo Git anterior.

## Recuperar el trabajo

| Acción | Qué hace |
| --- | --- |
| Enfocar sesión viva | Vuelve a la misma terminal y proceso. |
| Ver historial | Consulta la salida local de una sesión terminada; no la reinicia. |
| Continuar desde una fase | Prepara contexto editable a partir del plan, la fase y su último punto de continuidad. Puedes copiarlo y abrir otra sesión; Jauria no lo pega ni lo envía. |
| Intentar reanudar conversación | Para una conversación Claude cuya identidad reservó Jauria, inicia la CLI con ese ID exacto. No garantiza que Claude haya conservado su historial. |
| Volver a conversación reanudada | Enfoca la continuación administrada que ya está viva para esa misma identidad. |

La reanudación conserva metadatos de origen y añade un vínculo de la nueva sesión al proyecto o fase desde donde se solicitó. Si el vínculo falla después del inicio, la interfaz lo avisa y puedes añadirlo manualmente. La sesión principal original se conserva.

Las fases organizan el trabajo; no son puntos para rebobinar una conversación. La reanudación nativa continúa su estado actual. Para otro camino desde una fase, usa su contexto guardado en una sesión nueva.

Jauria no adivina conversaciones por la carpeta o por cuál fue la última. Las conversaciones antiguas sin identidad registrada y las de Codex en terminal conservan historial local y continuidad por contexto; la reanudación nativa de Codex queda pendiente. No se cambia Codex al modo de conversación estructurada.

Los bloqueos existentes siguen vigentes: no se inicia otro escritor sobre un worktree ocupado ni otra sesión administrada de la misma conversación Claude activa o incierta. Un error de reanudación queda visible; no se convierte silenciosamente en una conversación nueva.

## Guardar una fase

En el detalle registra qué quedó listo y la siguiente acción. Los puntos de continuidad (checkpoints) son inmutables: se añaden al historial y no reemplazan los anteriores. El detalle muestra los 10 más recientes; **Ver puntos anteriores** carga otros 10 cada vez. Pueden apuntar a una sesión concreta. Evita copiar secretos o transcripciones completas: basta el estado necesario para continuar.

Cambiar una fase a **Hecho** registra avance de agenda. No implica pruebas aprobadas, aceptación de código, merge ni modificación de Jira. Terminar una sesión o un turno tampoco completa una fase automáticamente.

## Permitir que los agentes registren planes

El acceso empieza desactivado. En el proyecto, selecciona una sesión viva y pulsa **Permitir registrar planes**. Esto concede acceso al proyecto seleccionado y permite crear planes propios de esa sesión; no comparte toda tu agenda ni los pendientes independientes. Incluye actualizar fases y marcarlas Hecho.

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
- La vista consulta cambios cada dos segundos mientras está visible; no consulta por tarjeta ni introduce trabajo en el bucle de teclado/salida de las terminales.

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
