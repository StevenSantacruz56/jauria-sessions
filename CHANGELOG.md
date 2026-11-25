# Changelog

Los cambios de cada versión de Jauria se registran aquí. El trabajo pendiente se mantiene en `Unreleased` hasta preparar una entrega.

## [Unreleased]

### Uso y recursos

- **La CPU se muestra como porcentaje de todo el equipo**, no con 100 % por núcleo: en un Mac de 10 núcleos, lo que antes se leía «CPU 125 %» ahora es «12,5 %». La barra de estado añade cuánto de ese total es de las sesiones, por ejemplo «Jauría · CPU 12,5 % (sesiones 11,8 %) · RAM 3,2 GiB», y el diálogo dice la escala en una línea bajo la tabla. Una cifra pequeña que no es cero se muestra «< 0,1 %». El muestreo del runner y de la ventana publica el número de núcleos (`cpuCount`); si ninguno lo informa, se conserva la escala anterior.

## [1.4.0] - 2026-11-25

Rediseño de la ventana, paleta de comandos, Pulso conectado con las sesiones y estado de los agentes guardado en el runner. Se retiran Repositorios y tareas Git. Capturas, compatibilidad y verificación en [las notas de 1.4.0](docs/RELEASE_1.4.0.md).

### Interfaz

- **Barra lateral** de 264 px (ajustable de 220 a 420 px) organizada en **Proyectos** y **Agentes**, dos zonas con su propio desplazamiento y cabecera fija. Proyectos lista los tableros de Pulso con su avance (hechas/total) y Pendientes; muestra los 20 primeros y «Más proyectos…». Agentes tiene una fila de una línea por sesión con la marca del proveedor (Claude, OpenAI o terminal), la duración y un indicador de estado. La cabecera reúne la marca, la búsqueda (`⌘K`) y Nueva sesión (`⌘N`). En ventanas de 860 px o menos la barra es un cajón superpuesto.
- **Cada estado tiene su forma, no solo su color:** anillo giratorio (trabajando), punto con halo (te necesita), marca de verificación (terminó), guion (en espera) y aro vacío (sin reporte). El anillo giratorio solo aparece cuando el agente declara `working` de forma explícita (OSC 7501); un proceso abierto sin reporte muestra el aro vacío. El estado también está disponible como texto.
- Los agentes se agrupan **Por proyecto** (predeterminado: sesión principal y vínculos de proyecto o de fase de Pulso; el resto en «Sin proyecto») o **Por estado** (las secciones de Actividad: acción requerida, avisos, turnos terminados, trabajo en curso y espera), con un botón en la cabecera de Agentes. La elección se recuerda por perfil.
- **Barra superior** de 42 px en lugar de la cabecera de 62 px: una pestaña por sesión abierta (proveedor, nombre e indicador de estado; un clic la abre en el panel enfocado), «+» para nueva sesión, búsqueda, Dividir y la campana de avisos. En Pulso, la misma barra muestra «Terminal» para volver, las pestañas de tableros y los botones «+ Nuevo proyecto» e «Histórico» (ver Pulso).
- **Paneles como tarjetas** sobre el lienzo, con una **cabecera única** de 32 px: proveedor, nombre, carpeta, estado, Cancelar (Ctrl-C) y menú «…» (Cambiar nombre, Terminar sesión con su confirmación, Liberar plaza). Una sesión que termina en pantalla muestra la etiqueta visible «Terminada · solo lectura».
- **Selector de sesión** propio en lugar del menú nativo: búsqueda por texto, grupos Abiertas e «Interrumpidas · se pueden continuar» más «Nueva sesión…» (ver «Sesiones y ciclo de vida»), las sesiones del otro panel deshabilitadas, flechas, Inicio/Fin, Intro y Escape. Ninguna tecla llega al terminal y al cerrarlo el foco vuelve a él.
- **Barra de estado** de 28 px: «N te necesita», «N terminaron», «N trabajando», conexión, columnas × filas del panel enfocado y recursos. «Sin avisos» solo aparece con la campana a cero. El consejo «Cerrar la ventana no detiene las sesiones» está en la bienvenida y en Configuración → Sesiones.
- **Sin barra de avisos fija** (la de 50 px desaparece): el aviso prioritario está en la etiqueta de estado de la cabecera del panel, en la campana —que abre una lista con Abrir, Ver en la lista, Marcar vistos y Abrir sesión— y en la barra de estado. Los avisos nuevos se anuncian en una región `aria-live` educada; los mensajes generales y los errores son una notificación flotante. Ningún aviso, estado ni capa flotante cambia el tamaño del terminal ni envía `resize`.
- El área útil del terminal cambia una sola vez con el rediseño: a 1220 × 800, de 118 × 33 a 115 × 38 con un panel y de 56 × 33 a 55 × 38 con dos; a 760 × 560, de 92 × 19 a 90 × 24 con uno y de 92 × 7 a 90 × 10 con dos (apilados).
- **Sistema visual:** paleta neutra clara y oscura sin tinte azul, cuatro colores de estado, ámbar reservado a la acción principal y a la marca, y un acento frío para el foco. Inter en 11, 12, 13 y 16 px (20 px en títulos de diálogo), radios de 6, 8 y 10 px y un único estilo de pestaña elevada. Fondo del terminal `#16191d` en CSS y en xterm. En modo oscuro la barra lateral toma la tinta del logotipo; el texto tenue y secundario cumple AA.
- **Configuración** reorganizada por tareas: **Apariencia**, **Barra lateral**, **Sesiones**, **Pulso y agentes**, **Avisos** y **Acerca de y diagnóstico**. Cada opción dice en lenguaje llano qué pasa al cambiarla y, donde ayuda, su valor actual («Hasta 4 sesiones a la vez»). **Un solo modelo de guardado: todo se aplica y se guarda al momento**, con confirmación en el pie («Guardado: …»); desaparecen el botón Guardar y el estado «Sin guardar». Si un guardado falla, el control vuelve al valor del runner y lo dice; un cambio hecho mientras otro se guarda se envía una vez después. El contrato de `set_settings` no cambia (mismas formas, también con runners 1.3.x).
- **Máximo de sesiones** como lista de 1 al máximo del runner: explica qué ocurre al alcanzarlo y que bajarlo no cierra sesiones abiertas.
- **Acceso automático a Pulso**: el texto de alcance es más claro y dice más que antes (todos los proyectos, plan, fases y checkpoints, crear proyectos, no Pendientes, lo que lea puede llegar al proveedor, a quién aplica, que se retira al terminar y que desactivarlo corta al momento el acceso automático también de las sesiones abiertas). Los permisos y su semántica no cambian.
- **Acceso a mano para una sesión ya abierta** (antes «Acceso manual para sesiones existentes»): explicación visible de para qué sirve, pasos numerados, etiquetas llanas (Sesión que recibe el acceso, Qué puede hacer, Dar acceso, Quitar el acceso de esta sesión, Accesos recordados, Olvidar este acceso) y un estado vacío cuando no hay sesiones de Claude Code o Codex abiertas.
- **Avisos**: explica qué avisa Jauría y dónde (campana, barra de estado, número del Dock); el botón de avisos de macOS dice que se piden en cada apertura y que macOS no confirma a Jauría si los muestra (dónde revisarlo). Sale de Configuración «Ver sesiones que necesitan atención», que no era un ajuste.
- **Opciones nuevas**: **tamaño de letra del terminal** (11–18 px, 13 por defecto, por perfil; al cambiarlo cada terminal visible se reajusta una sola vez; no afecta al modo de conversación de Codex), **agrupación de Agentes** y **restablecer la barra lateral**.
- **Se retira el panel Información** (botón ⓘ, `⌘I` y su acción de la paleta). Lo útil se reubica: versión de la app y del runner con aviso si no coinciden, comprobación de Claude Code y Codex (sin rutas), diagnóstico revisable y **Reiniciar runner…** (con su confirmación nativa) en **Configuración → Acerca de y diagnóstico**; carpeta completa, proveedor, tamaño del terminal, identificador, Nueva sesión en esta carpeta, Eliminar salida guardada y Compactar eventos en el menú «…» del panel; el aviso de que cerrar la ventana no detiene las sesiones, en la bienvenida y en Configuración. «Salir de la interfaz» se retira (Jauría → Salir sigue en el menú de la app). Los fixtures de prueba solo aparecen en perfiles smoke, desde la paleta. El caso «Información tapa parte del terminal» desaparece de la regla de «atendida».
- **Barra lateral ajustable**: divisor entre Proyectos y Agentes y borde derecho arrastrables, con teclado (flechas, Inicio/Fin, Intro o doble clic para el valor inicial), foco visible y sin seleccionar texto; cada zona se pliega con su cabecera. Reparto, ancho y plegado se recuerdan por perfil. Arrastrar el ancho mueve una guía y aplica el cambio al soltar: como mucho un `resize` por terminal visible.
- **Marcas de proveedor** en pestañas, filas, cabeceras, paleta, Pulso y Nueva sesión: el logotipo de Claude, el de OpenAI para Codex y un símbolo de terminal, en lugar de las insignias «C», «X» y «$». Las fuentes y su licencia están en `desktop/public/brand/proveedores/`.
- **Botones en tres niveles** en toda la ventana: primario ámbar para la acción principal de cada superficie, secundario con borde para el resto de acciones de texto y sin borde solo para controles de icono. Detalle en [DESIGN.md](DESIGN.md).
- **Paleta de comandos:** `⌘⇧P` (Ctrl+Shift+P fuera de macOS) o el botón de búsqueda de la barra superior abre un diálogo de 560 px cerca del borde superior. Abrirlo no cambia el tamaño del terminal.
- Resultados en grupos: **Te necesitan**, **Sesiones** abiertas (con su indicador y su proyecto), **Proyectos** de Pulso (con Pendientes), **Fases** del tablero de proyecto ya cargado y **Acciones**. La búsqueda ignora mayúsculas y acentos, admite subcadenas e iniciales y ordena por coincidencia y después por prioridad de estado. Escribir no hace lecturas nuevas. Elegir una fase abre Pulso y su detalle.
- Acciones: nueva sesión, abrir la sesión que más te necesita, marcar avisos como vistos, dividir/unificar, enfocar el otro panel, ir a Pulso o volver a la terminal, nuevo proyecto, buscar en la lista de agentes, agrupar por proyecto/estado, Abiertas/Historial, restablecer, plegar o desplegar las zonas de la barra lateral, Configuración, apariencia y, sobre la sesión del panel enfocado, cambiar nombre, interrumpir y terminar. Las no disponibles aparecen deshabilitadas con el motivo. Terminar y Cambiar nombre abren su confirmación o formulario de siempre; Interrumpir solo enfoca su botón. La paleta nunca escribe en un terminal ni concede permisos de Pulso.
- Teclado y accesibilidad: patrón combobox + listbox con grupos con nombre, flechas, Inicio/Fin, Intro, Escape o clic fuera, y anuncio del número de resultados. Ninguna tecla escrita en la paleta llega al terminal o a un campo de Codex, tampoco el propio atajo, su repetición al mantenerlo pulsado ni una composición IME. Al cerrar, el foco vuelve a donde estaba o, si ese control ya no existe, al terminal del panel enfocado. No se abre sobre otro diálogo y, en Pulso, respeta las guardas del borrador.
- `⌘K` no cambia: sigue enfocando la búsqueda de la lista de agentes. `⌘N`, `⌘K`, `⌘,` y `⌘⇧P` comparten un registro único de atajos.

### Sesiones y ciclo de vida

- **Cuatro estados** en todas las superficies: **Abierta**, **Sin confirmar — ocupa plaza** (antes «Requiere atención»), **Interrumpida** (antes también «Falló»; el detalle dice «El runner se reinició» o «No llegó a iniciarse») y **Terminada** (antes «Cerrada», «Detenida» o «Carpeta liberada»). Una única definición (`session-lifecycle.ts`) sustituye las listas de estados cerrados repetidas en el cliente.
- **Un panel es para trabajar:** su selector y **Dividir** solo ofrecen sesiones Abiertas (Sin confirmar marcadas), «Interrumpidas · se pueden continuar» y la fila **Nueva sesión…**; ya no hay grupo Historial. Dividir elige una Abierta que no esté en el otro panel o deja el segundo panel vacío (antes podía poner la sesión más antigua aunque estuviera cerrada). Las pestañas tampoco abren una Terminada.
- **Recuperar una Interrumpida:** encima del terminal, sin cambiar su tamaño, **Continuar conversación** (Claude Code con identidad registrada; Codex estructurado con turnos) o **Empezar de nuevo aquí** (Codex en terminal, Terminal o una sesión que no llegó a iniciarse: abre Nueva sesión con la misma carpeta, herramienta y nombre), **Ver salida** y **Descartar** («La pasa a Terminadas; no borra nada»). Antes solo se podía continuar una conversación de Claude desde Pulso.
- **Continuar conversación** solo cuenta cuando la sesión nueva sigue abierta en dos lecturas seguidas del estado; un arranque fallido no retira la original. Usa un único camino desde el panel, la vista Historial, la barra lateral, la paleta y Pulso: comprueba la plaza, abre la sesión nueva en el mismo panel y marca la original como continuada (pasa a Terminadas). **La sesión nueva hereda el vínculo de proyecto o fase de Pulso de la original**, con un aviso visible. Nada se pega ni se envía al terminal.
- **Interrumpidas a la vista:** tras una caída del runner aparecen arriba de **Abiertas**, en su propia sección, con **Descartar**. Lo descartado y lo continuado se recuerda por perfil (`jauria:session-dismissed:<perfil>`, hasta 2.000 sesiones).
- **Vista Historial:** elegir una Terminada (barra lateral, paleta, avisos, Pulso) la abre en el lugar de los paneles, como Pulso, nunca en un panel de trabajo: buscar en la salida, copiar la salida, nueva sesión en esta carpeta, **Continuar conversación** como acción secundaria cuando la conversación lo permite (también para una Claude terminada con Terminar), y en «…» borrar la salida guardada o compactar eventos. **Volver a las sesiones** (o Escape) devuelve los paneles tal como estaban, sin reajustar ningún terminal. Una sesión que termina mientras está en pantalla sigue en su panel con «Terminada · solo lectura» y Cerrar.
- **De la más reciente a la más antigua** en el Historial, las Interrumpidas, el selector y la paleta (el runner no da fechas: se invierte el orden de creación).
- **Textos:** «Interrumpir» pasa a **Cancelar (Ctrl-C)** («Cancela lo que está haciendo; la sesión sigue abierta»), «Liberar carpeta…» a **Liberar plaza…**, «Reanudar…» a **Continuar…** (también en Pulso y en Codex estructurado), e «Interrumpir turno» de Codex a **Cancelar turno**.

### Pulso

- La barra superior de Pulso separa tres cosas: **Terminal** (volver, con divisor), las pestañas, que son solo tableros (Pendientes y proyectos abiertos), y dos botones con borde siempre visibles: **+ Nuevo proyecto** (ya no un «+» igual al de nueva sesión) e **Histórico** con su contador. La barra del proyecto ocupa una línea: título, «n de m fases hechas», **Proyecto**, **Sesiones** y la única acción ámbar. Las cuatro columnas caben a 1220 px.
- En Pulso los **botones en tres niveles** dejan sin borde solo los iconos, el «…» de una fase y «+ Añadir fase» (con borde punteado). Ninguna acción queda como texto suelto; «Cancelar» va junto al botón principal en la misma fila. «Dar por terminado» pierde su borde verde (el verde es el estado Hecho). El cajón se nombra por su título; los controles de la barra miden 32 px.
- **Dos cajones en lugar del único que había para el proyecto (antes «Plan y sesiones»).** **Proyecto**: nombre y plan, que se guardan solos (tras una pausa breve, al salir del campo y al cerrar), como Configuración; sin «Guardar proyecto» ni «Descartar borrador». Un fallo de guardado se ve, conserva lo escrito y ofrece reintentar, revisar el conflicto o, si sigue fallando, descartar tus cambios con confirmación. Lo pendiente se envía al ocultar o cerrar la ventana, y salir del tablero lo guarda y continúa en un solo gesto. **Sesiones**: la sesión principal se aplica al elegirla; las sesiones vinculadas con sus acciones (abrir, continuar, ver historial) y «Vincular sesión». La sección «Acceso de agentes» sale de estos cajones y del detalle de una fase: el acceso automático viene activo y el manual sigue en Configuración → Pulso y agentes.
- **Nuevo proyecto** pregunta además si quieres **empezar una sesión nueva para este proyecto**: abre Nueva sesión y la sesión que arranque queda como principal del proyecto. Si cancelas, el proyecto queda creado sin sesión. Al crear, el tablero abre la primera fase en Por hacer, lista para escribir.
- **Añadir fase** está justo debajo de la última fase de cada columna, también en Hecho, y en un tablero vacío queda a la misma altura en las cuatro columnas, con una sola indicación del primer paso en Por hacer. Los textos dicen siempre «fase» en proyectos y «pendiente» en Pendientes, nunca «tarjeta».
- **Dar por terminado:** cuando todas las fases están en Hecho, la barra del proyecto lo ofrece y, tras confirmar, archiva el proyecto (`project_update` con `archived`). Desde **Proyecto → Terminar o archivar** se puede archivar también con fases abiertas. Un proyecto archivado sale de las pestañas, de la barra lateral y de sus agrupaciones; **Histórico** los lista, el más reciente primero, diciendo si se terminó («Terminado el …») o se archivó con trabajo abierto («Archivado sin terminar el …»), abre su tablero en solo lectura y permite **Reabrir**.
- **El runner hace de solo lectura un proyecto archivado**, también para los agentes: rechaza (código `project archived`) escrituras sobre él, sus fases, checkpoints y vínculos, salvo reabrirlo. Guarda `archivedAt` al archivar y lo quita al reabrir; los archivados antes de este cambio muestran «fecha no registrada». La interfaz y el MCP explican el rechazo y ofrecen reabrir.
- Cada fase tiene un menú **«…» → Mover a** Por hacer / En curso / En espera / Hecho, accesible con teclado, en lugar del selector visible; conserva la semántica, el deshacer y el orden de fases. El arrastre por el agarre sigue igual.
- **Pie de cada fase** con la sesión vinculada (indicador de estado en vivo, proveedor y nombre) y «n checkpoints» (oculto si es 0). Pulsarlo abre esa sesión: la viva se enfoca y la cerrada muestra su historial; no abre el detalle ni inicia un arrastre, y se deshabilita con un borrador. Si sale del último checkpoint lo indica («Sesión del último checkpoint»); una sesión que la ventana no conoce aparece como «Sesión no disponible», sin acción.
- **La barra lateral y el tablero se actualizan cuando un agente edita Pulso** por MCP, en un segundo o menos y sin sondeo: siguen la revisión de Pulso que el runner publica en cada `status`. Con la ventana oculta, el cambio queda pendiente hasta volver. Sin cambios, ni la barra lateral ni el tablero leen Pulso; el tablero ya no consulta su revisión cada 2 s y la barra lateral hace una sola lectura en lugar de varias por proyecto.
- «Por proyecto» agrupa también las sesiones vinculadas a una **fase**; la sesión principal tiene prioridad. Desaparece el tope de 100 vínculos por proyecto; si el runner recorta los vínculos (más de 2.048), el grupo «Sin proyecto» lo indica.

### Nueva sesión

- La ventana se ordena como se usa: **Herramienta → Carpeta de trabajo → Proyecto de Pulso (opcional) → Nombre de la sesión (opcional)**, con un solo subtítulo («Elige una herramienta y una carpeta para empezar.»). Desaparecen «sin crear un proyecto», «sin registrar un proyecto» y la nota de worktrees.
- El botón principal dice **Abrir sesión** («Iniciar sesión» sonaba a entrar con una cuenta) y muestra «Abriendo sesión…» sin permitir un doble envío. Cancelar es un botón secundario.
- Las herramientas muestran su marca (Claude, OpenAI, terminal). Una CLI que no está instalada queda deshabilitada con «CLI no instalada» y **Comprobar otra vez**; se vuelve a comprobar al abrir la sesión.
- **Carpeta de trabajo**: «Mi carpeta personal · ruta», **Elegir otra carpeta…** y **Recientes** (las cinco últimas, por perfil; solo en la vista, nunca en el diagnóstico). Si la carpeta ya no existe, lo dice junto al campo.
- **Proyecto de Pulso (opcional)**: la sesión nueva se vincula a ese proyecto sin cambiar su sesión principal. Desde Nuevo proyecto aparece fijo («Proyecto: «Nombre» · sesión principal»). Si la sesión se abre pero el vínculo falla, no se abre otra: **Reintentar vínculo**.
- El pie dice «3 de 8 plazas ocupadas · 5 disponibles» y, si no se puede abrir, el motivo exacto (con **Reconectar** sin conexión). Otra sesión de Claude Code en la misma carpeta es un aviso, no un bloqueo.
- Teclado: el foco empieza en la herramienta elegida, las flechas recorren el grupo, Enter solo envía un formulario válido y Escape cierra y devuelve el foco a quien abrió la ventana. A 760 × 560 no hay desplazamiento horizontal. El título no se puede seleccionar por accidente.

### Avisos

- El runner lee la salida de cada terminal y reconoce las mismas señales que la ventana —estado OSC 7501, BEL y notificaciones OSC 9/777—, aunque lleguen partidas. Guarda el **estado declarado**, la **duración del turno** y **lo que ya viste**, que sobreviven a cerrar la ventana, reconectar y recargar; si el runner se reinicia, un turno abierto queda como interrumpido. Barra lateral, pestañas, cabecera del panel, barra de estado, campana, pies de tarjeta, paleta y Dock muestran la misma información.
- El estado es **lo que declara la salida del terminal**, no una comprobación del agente: cualquier programa de la sesión puede emitirlo. El runner no guarda ni publica títulos, mensajes ni texto de las notificaciones. El modo estructurado de Codex no declara estado: aparece como progreso no informado, nunca como trabajando.
- **Un turno terminado sin ver se conserva:** sigue visible y contado aunque el agente ya haya empezado otro turno (la fila indica «Trabaja de nuevo»), hasta que lo veas.
- **«Te necesita» dura mientras se declara:** un bloqueo o error permanece mientras el agente lo declare; si se desbloquea solo, deja de pedir atención. Si el proceso termina, el aviso pasa a ser «Proceso terminó» (un proceso muerto ya no espera a nadie).
- **Clic en un aviso de macOS:** trae Jauría al frente y abre esa sesión; si el aviso agrupa varias, abre la lista de avisos. El aviso solo lleva un número aleatorio, ningún dato de la sesión. **Configuración → Avisos** añade «Abrir Ajustes de notificaciones» y el interruptor «Avisos de Claude Code y Codex» (activado): Jauría añade a cada sesión nueva de Claude Code y Codex un aviso de cuándo trabaja, te necesita o termina, sin cambiar su configuración.
- **Vista dividida:** el segundo panel visible también cuenta como «mirando»: sus avisos se dan por vistos y no generan notificación.
- **Un proceso que falla se distingue:** «Proceso falló (código N)» cuenta en «te necesita» (y en macOS como «Necesita tu atención»); un fin con código 0 sigue siendo «Proceso terminó». Solo se muestra el código; un proceso que murió por una señal dice «Proceso falló», sin código.
- **Codex estructurado** avisa al terminar un turno («Turno terminado», salvo si lo cancelaste) y al terminar su proceso.
- **Qué cuenta como ver:** abrir la sesión (barra lateral, pestaña, lista de avisos, paleta o «N te necesita»), pulsar **Marcar vistos** o **Descartar** una Interrumpida. De forma automática, solo si estás mirando ese terminal —ventana visible y enfocada, vista de terminal, sesión en un panel visible (con la vista dividida, los dos) y nada que lo cubra: ningún diálogo ni el cajón lateral de las ventanas estrechas— y el aviso ya se pintó; también el fin de un proceso que ocurrió en ese panel y el fin de turno de Codex estructurado que llegó mientras lo mirabas. **Terminar** una sesión no genera «Proceso terminó». Las solicitudes de permiso nunca se marcan solas. Marcar visto no responde permisos ni resuelve errores; un permiso de Codex pendiente sigue saliendo de su propio estado.
- **Al abrir la ventana**, lo pendiente aparece desde el primer momento en la campana, la barra de estado y el Dock, pero **macOS no notifica lo atrasado**: las notificaciones solo avisan de lo ocurrido después de conectar y no se repiten al reconectar. Con muchas sesiones, la lista de la campana termina con «y N más sin listar» y los totales siguen siendo exactos.
- Las notificaciones de macOS usan su categoría («Necesita tu atención», «Actividad finalizada» o «Aviso de sesión»), sin títulos, rutas ni salida del terminal.
- Durabilidad: lo que marcas como visto se confirma en disco; el resto de cambios se guarda en menos de 250 ms, así que una caída del runner puede perder ese último tramo. Al cerrar, el runner vacía lo pendiente con el mejor esfuerzo durante como mucho 3 s. Eliminar o compactar el historial no borra los avisos sin ver.
- Una sesión Interrumpida deja de estar en la campana y en «Te necesitan» de la paleta en cuanto la abres, pulsas Marcar vistos o la descartas; sigue en Interrumpidas. Antes se quedaba para siempre. «Sin confirmar» no cambia.
- Las reglas completas (qué avisa, qué cuenta como visto, macOS y el Dock) están en [docs/SESSION_ALERTS.md](docs/SESSION_ALERTS.md).

### Uso y recursos

- **Vista propia** en lugar del desplegable al pie de la barra lateral: la fila «Uso y recursos» (ahora un botón, como Configuración), el total de la barra de estado y la paleta («Abrir Uso y recursos») abren un diálogo con «Cerrar» y Escape; el foco vuelve a lo que lo abrió. La barra lateral ya no cambia de tamaño ni repite el título, y abrir la vista no cambia el tamaño de ningún terminal.
- **Cuotas arriba, en lenguaje llano:** por ventana, porcentaje libre con su barra y cuándo se reinicia («Semana: 92 % libre · se reinicia el 25 nov, 11:23»; «5 horas» en lugar de «5 h · codex»). Sin dato, una sola línea que dice por qué y qué hacer («Claude Code: Sin dato. Se actualiza cuando hay una sesión de Claude abierta en Jauría.»). Un dato vencido muestra «Dato vencido · hace 11 h» y no se presenta como vigente. Solo **Actualizar** consulta a Codex; abrir la vista no consulta a ningún proveedor.
- **Recursos por sesión:** una fila por sesión abierta con su nombre (no «CLI PID 1234»), sumando los procesos que lanzó, más Runner, Interfaz y **Total de Jauría**. La **Interfaz incluye ahora el motor web de la ventana** (WebKit WebContent, GPU y Networking, y otros servicios que macOS atribuye a la app): antes la cifra solo contaba el proceso principal y subestimaba el uso real unas tres veces. Solo cuentan como Interfaz los servicios del sistema (XPC de `/System/Library`); un trabajo que una sesión dejó en marcha al terminar, y que macOS sigue atribuyendo a Jauría, aparece aparte como «Otros procesos de Jauría». El motor web cuenta como incluido solo si aparece al menos un proceso de WebKit (WebContent, GPU o Networking). Si macOS no permite atribuirlos (la app lanzada desde una terminal) o no se encuentran, la vista lo dice en una línea y el total, en la vista y en la barra de estado, se marca «parcial». La atribución depende de una función de macOS no documentada y se puede desactivar con una sola constante (`RESPONSIBILITY_ATTRIBUTION`); desactivada, la vista dice que el motor web no se mide y el total sale parcial. Un proceso que no se pudo medir no desaparece: su fila dice «sin dato» y el total se marca «parcial». Con un runner 1.3.x, que no indica a qué sesión pertenece cada proceso, los procesos de las sesiones se suman sin desglose y la vista no afirma que no haya sesiones. La barra de estado muestra el mismo total que la vista («Jauría · CPU … · RAM …»).
- **Sin jerga:** fuera «Fuente: …», «RSS», «reparentados», «Primera muestra» y las notas técnicas. El método de medida y las fuentes de cuota pasan al diagnóstico (Configuración → Acerca de y diagnóstico).

### Retirado

- **Repositorios y tareas Git:** registrar repositorio, nueva tarea, worktree propio por tarea, panel de tarea, revisión con veredicto humano, verificación de comandos, relevo y su botón «Contexto», archivar y cerrar o reabrir repositorios. Los datos antiguos del perfil **se conservan y se ignoran**. Jauria **no borra ningún worktree ni rama**; sus carpetas se abren como sesión normal.
- Las reservas de relevo de versiones anteriores ya no bloquean sesiones nuevas. Una verificación antigua sin terminar bloquea su carpeta solo mientras su comando siga vivo.
- Se mantienen el límite de plazas, la regla de un escritor por worktree Git, «Liberar carpeta» (ahora «Liberar plaza…») para sesiones inciertas, la eliminación y compactación del historial (ahora con su propia confirmación nativa), Pulso, MCP, permisos, avisos y Configuración.

### Corregido

- **«Inventario parcial; pueden faltar procesos» aparecía siempre**, también sin sesiones: el inventario de procesos tomaba como fallo cada proceso de otro usuario del sistema (macOS deniega esa lectura entre usuarios), y en reposo hay cientos. Ahora esos procesos y los que terminan durante la lectura quedan fuera sin marcar el inventario como parcial; el aviso solo aparece si de verdad puede faltar un proceso de Jauría y dice por qué.
- **Proyectos desaparecía con muchas sesiones:** las dos zonas de la barra lateral se encogían en proporción a su contenido, así que con un Historial largo Proyectos quedaba en su título (a 760 × 560, una fila). Ahora cada zona tiene su desplazamiento y Proyectos conserva al menos su cabecera y dos filas.
- **El menú «…» del panel no se cerraba al pulsar fuera** (ni con Escape). Todos los flotantes (menú «…», selector de sesión, lista de avisos, menú «…» de una fase de Pulso) siguen ahora una sola regla: se cierran al pulsar fuera —un clic sobre un terminal además lo enfoca—, con Escape (el foco vuelve a su botón), al mover el foco fuera o al abrir otro; solo hay uno abierto a la vez. La lista de avisos tampoco se cerraba al salir con Tab.
- **«Inicio solicitado. Esperando salida y estado reales» quedaba fijo sobre el terminal.** Abrir y terminar una sesión ya no muestran notificación flotante (la cabecera dice «Abriendo» / «Terminando…» y se anuncia a lectores de pantalla). Las confirmaciones cortas se retiran solas a los 5 s, los mensajes de progreso al terminar su condición y los errores quedan hasta cerrarlos (botón o Escape). Un mensaje nuevo sustituye al anterior.
- **Terminar una sesión dejaba el panel en el terminal muerto** (comportamiento heredado de 1.3.3). Al confirmarse el fin, el panel pasa a la siguiente sesión abierta por prioridad o a la bienvenida, con el foco en ella; la pestaña desaparece y la sesión queda en Historial. Una sesión que termina sola se queda en su panel con «Cerrar». Un cierre sin confirmar en 12 s o incierto lo dice en la cabecera en lugar de quedarse en «Terminando…».
- **Revisión de avisos (24-nov):** **Terminar** una sesión generaba un «Proceso terminó» sin ver (campana, Dock y macOS) por una acción de la propia persona, y un fin de proceso visto en el panel reaparecía como nuevo al cambiar de sesión. Un fallo al leer los permisos de Codex (`codex_state`) silenciaba en campana, Dock y macOS un aviso confirmado de la misma sesión. Una interrupción ocurrida con Jauría cerrada (p. ej. caída del runner) se abría como «vista»: ahora se recuerdan por perfil las interrupciones ya vistas y las demás cuentan como nuevas. **Descartar** no retiraba los avisos del runner de esa sesión. Con más de 128 sesiones con avisos, «y N más sin listar» podía subir al marcar uno visto y la barra de estado no contaba las no listadas (ahora dice «N sin listar»). Un segundo aviso idéntico no se anunciaba al lector de pantalla. Tras activar los avisos de macOS el texto ya no da a entender que macOS los permite: Jauría no puede saberlo.
- **Los avisos de Claude Code no llegaban nunca** (estados «Trabajando», «Te necesita» y «Turno terminado» de los hooks): Claude Code ejecuta sus hooks sin terminal de control y el hook escribía en `/dev/tty`, que ahí no existe. Ahora el runner da a cada sesión de Claude Code y Codex la ruta de su terminal (`JAURIA_SESSION_TTY`, validada) y, si falta, el hook usa el terminal de su proceso padre más cercano. Las sesiones ya abiertas no tienen la variable, pero sus hooks llaman al mismo `aw-runner` de la app: con la versión corregida instalada lo encuentran por el proceso padre.
- **Revisión de avisos-2 (25-nov):** apagar «Avisos de Claude Code y Codex» guardaba los ajustes en un formato que un runner 1.3.x no lee, y al volver a él se reactivaba el acceso automático a Pulso y el límite volvía a 2; ahora el apagado es un archivo aparte y los ajustes siguen siendo legibles por 1.3.x (un archivo ya escrito así se migra solo). El interruptor de Pulso aparecía como no disponible en ese caso. Claude anunciaba un permiso con unos seis segundos de retraso (ahora al aparecer, sin aprobar ni denegar nada) y, tras un error de la API, quedaba en «Trabajando» (ahora «te necesita»). Un `notify` propio de Codex escrito de otra forma válida (`'notify' = [...]`) podía quedar sustituido; ahora, ante cualquier duda, Jauría no añade el suyo. Una muerte por señal salía como «código 1». Un clic en un aviso de macOS antiguo no hacía nada (ahora abre la lista) y un aviso enviado mientras se registraba el clic no lo abría.
- **MCP de Pulso:** una herramienta desconocida y un estado de fase no válido devuelven un error claro en lugar de «reintenta con el mismo idempotencyKey»; el socket de Pulso responde «invalid status» en lugar de «invalid request or storage unavailable».
- **Revisión de Codex de la barra lateral y Configuración:** un Terminar que el runner rechazaba dejaba la sesión en «Terminando…» con la entrada deshabilitada; tras «No se pudo confirmar el cierre» se podía lanzar un segundo Terminar mientras el primero seguía pendiente (ahora espera su respuesta). Un guardado fallido de Configuración descartaba un cambio elegido mientras estaba en curso. Escape, `pointercancel` o perder la captura del puntero al arrastrar el divisor Proyectos/Agentes no restauraban el reparto (se guardaba en cada movimiento) o lo dejaban bloqueado. El foco quedaba en ninguna parte al elegir con el teclado una opción del menú «…», al retirarse el último aviso con la lista abierta y al cerrar un aviso flotante con su botón.
- **Configuración → Guardar** fallaba siempre en la app 1.3.3 con su propio runner («Argumento no permitido»), también al cambiar solo el límite de sesiones: el puente nativo solo dejaba pasar `maxConcurrentSessions` y rechazaba `pulsoAutoAccess`. Ahora lo admite, estrictamente booleano, y una tabla compartida comprueba cada operación que envía la interfaz contra el puente y el runner.

### Limitaciones conocidas y compatibilidad

- El esquema del perfil sigue en `user_version` 5. `runner.sqlite` añade la tabla `agent_attention`, sin claves foráneas ni triggers; `pulso.sqlite` no cambia. Las tablas de Repositorios se mantienen con la misma definición, sin recuperación ni limpieza.
- **App 1.4 con un runner 1.3.x** (el que sigue vivo tras reemplazar la app): funciona en modo degradado, como 1.3.3. Estado y vistos solo en la ventana (se reinician al reconectar), Pulso con varias lecturas por proyecto, consulta de revisión cada 2 s y relectura al terminar un turno, y fases sin pie. Para tener todo, termina el trabajo activo y reinicia el runner como indica [la guía de instalación](docs/INSTALLATION.md#actualizar-una-instalación-existente).
- **App 1.3.x con un runner 1.4:** conecta, no ofrece Repositorios y Diagnóstico muestra «runner anterior» por las capacidades retiradas (un aviso de más, no un fallo); una operación de tareas devuelve `unknown operation`. Deducido del código: no se probó con la app 1.3.x.
- **Vuelta atrás a 1.3.3:** su runner abre un perfil usado por 1.4, purga y compacta sin tocar `agent_attention` (comprobado con el binario de v1.3.3). Los avisos que nadie marque mientras tanto aparecen como pendientes al volver a 1.4. Con datos antiguos de Repositorios, el runner 1.3.x modifica al abrir las tareas y verificaciones a medio hacer; ese caso no se probó.
- **1.4.0 no está publicada:** no hay etiqueta `v1.4.0`, release de GitHub ni DMG; la versión estable publicada sigue siendo 1.3.3.
- **DMG sin firma Developer ID ni notarización**, como en 1.3.3; no desactives Gatekeeper ni elimines la cuarentena.
- El estado de un agente es **lo que declara la salida del terminal** (OSC 7501), no una comprobación; macOS no notifica lo atrasado al abrir la ventana.
- Las pruebas de interfaz usan una **frontera Tauri sintética**: lo que depende del puente nativo real (Guardar Configuración, avisos de macOS) se valida en la app empaquetada. Lista completa en [las notas de 1.4.0](docs/RELEASE_1.4.0.md#límites-conocidos).

### Para desarrolladores

- `status` añade `pulsoRevision` y `pulsoRevisionVersion: 1` (solo con Pulso disponible), `pulsoSummaryVersion: 1`, `pulsoBoardCardsVersion: 1`, `agentAttentionVersion: 1`, `agentAttention` y `agent` por sesión (vivas o con avisos pendientes; como mucho 128, con `hasMore` y totales exactos). `terminal_live` añade el `agent` de su sesión. Ningún `*Version` existente cambia. Se retiran `workspaceVersion`, `workflowVersion`, `verificationVersion`, `recoveryVersion`, `handoffVersion` y `projectLifecycleVersion`, y `status` deja de enviar `projects`/`tasks` (acepta e ignora `workspaceAfter`).
- Operaciones nuevas: `sidebar_summary {ifRevision?}` de Pulso (solo UI; hasta 50 proyectos y 2.048 vínculos) y `mark_seen {items:[{id, epoch, through}]}` (hasta 64, monótona e idempotente, sin el cerrojo de mutaciones), también en el puente. Las fases de `board` añaden `session` y `checkpointCount`. Se retiran `register_project`, `close_project`, `reopen_project`, `create_task`, `prepare_task`, `revalidate_task`, `start_task`, `start_codex_task`, `workflow*`, `snapshot_task`, `review_task`, `handoff_task`, `open_handoff`, `archive_task`, `reopen_task`, `purge_workflow` y las de verificación (`unknown operation`).
- Coste medido: el pie de fase añade en release unos 0,1–0,3 ms y 5–8 KB a un `board` de 80 fases; `agent` añade unos 33 KB a `status` con 8 sesiones vivas y 100 cerradas con avisos. El escaneo del PTY ocurre fuera del candado de publicación: en una ráfaga de 50 MiB con `resize` cada 5 ms, el p99 de `resize` bajó de 2,8–7,7 ms a 0,3–0,7 ms sin empeorar el drenaje. Las filas de sesiones terminadas con todo visto se limitan a 512 también en ejecución, y ni el sellado de sesiones del runner ni el mapa de estados de la interfaz crecen con el histórico. Contrato en [DEVELOPMENT.md](docs/DEVELOPMENT.md#capacidades-de-status) y reglas en [SESSION_ALERTS.md](docs/SESSION_ALERTS.md#estado-y-vistos-en-el-runner-14-e).
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
