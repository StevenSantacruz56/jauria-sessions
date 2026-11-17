# Validación local de Jauria 1.3.0

Fecha inicial: 2026-11-14; revisión final: 2026-11-15. macOS Apple Silicon. Pruebas funcionales con perfiles y datos sintéticos; no se concedieron ni revocaron permisos en el perfil del usuario.

## Comprobaciones

- Compilación TypeScript/Vite y bundle Tauri release arm64: aprobados.
- Node general: 89 aprobadas, 5 omitidas por condiciones explícitas de entorno; las suites Pulso y Configuración se ejecutaron aparte con navegador habilitado.
- Configuración y permisos en Chromium/WebKit: 46 aprobadas. Incluyen paginación, alcance explícito, recordar opcional, revocación, respuestas tardías, borradores y foco del diálogo superpuesto.
- Recuperación, tablero, shell completa y persistencia por perfil: 144 aprobadas en Chromium/WebKit y preferencias. Incluyen cierre con consulta de identidad sin caché previa, continuación existente con plazas ocupadas, respuesta obsoleta tras reconexión y restauración sin comandos al proveedor. Tras el último ajuste se ejecutaron además dos casos de abandono explícito de una restauración fallida (Chromium/WebKit), ambos aprobados. Los totales de Node incluyen entradas padre de las suites.
- Regresiones de terminal y avisos en navegador: 15 aprobadas; conservación de xterm, scroll, anclas, geometría y entrada. La primera ejecución de geometría WebKit coincidió con un cambio de fuente y un reload de Vite; se desactivó HMR en ese fixture y sus tres entradas aprobaron al repetirlas con la fuente estable. Las pruebas de shell comprueban que navegar a Pulso no envía entrada ni redimensiona el PTY oculto.
- Runner: 23 pruebas de integración aprobadas para reanudación exacta, permisos, Pulso y configuración. No hay cambios funcionales de Rust en esta entrega; se incrementó la versión.
- Bridge Tauri: 40 aprobadas. Python de versión/empaquetado: 16 aprobadas.

## Fluidez

Benchmark release optativo aprobado con perfiles sintéticos de 2 y 8 sesiones, 500 tarjetas y clientes Pulso lentos. En 8 sesiones, eco del proceso hijo p95: 2,758 ms en reposo y 2,856 ms con carga Pulso; 80/80 entradas recibidas en cada condición. Interrumpir, redimensionar, detener y apagar permanecieron por debajo de 98 ms. Son observaciones locales de RPC/PTY, no medidas de pintura de pantalla ni latencia de Claude o Codex.

## Sesión real y límites visuales

Antes de la entrega se recuperó mediante la interfaz la conversación Claude «test» usando su identidad registrada, sin tocar la otra sesión viva. Se conservó la principal original y se enlazó la continuación. No se leyó ni copió el contenido de esa conversación a la documentación.

La interfaz 1.3.0 se abrió contra el mismo runner 1.2.0 existente: ambas sesiones siguieron vivas y la generación del runner no cambió. En la primera sesión de validación, el servicio de automatización de escritorio dejó de responder antes de comprobar visualmente la ventana final. Las capturas publicadas son sintéticas de la shell real en navegador, sin datos del usuario.

### Revisión nativa posterior y ajustes de claridad

En una sesión nueva, Computer Use abrió el paquete original contra el perfil existente. El tablero de prueba enfocó la conversación Claude ya reanudada con las dos plazas ocupadas; el contador siguió en 2 de 2 y no apareció una sesión adicional. Se observaron Configuración con los permisos Pulso en una sola sección, alcance por proyecto o creación propia, recordar desmarcado, avisos de macOS desactivados, navegación Pulso/terminal, foco al abrir y cerrar diálogos y scroll del terminal con regreso al final. No se concedieron ni revocaron permisos ni se interrumpieron las sesiones.

La revisión encontró problemas de claridad: el acceso a sesiones que necesitan atención cerraba Configuración aunque no hubiera ninguna; el detalle del proyecto repetía el enlace a la misma conversación activa en cada historial vinculado; y el botón de acceso a Pulso no anticipaba el paso de copiar un comando a la sesión elegida. El código y el paquete local `Jauria-1.3.0-ux-fixes.app` incluyen el estado vacío de avisos, una sola acción de apertura de la conversación, etiquetas distintas para historiales con el mismo título y una explicación del alcance y los pasos del permiso. Los botones de recuperación nombran la acción real: abrir una sesión viva o reanudar una conversación cerrada.

La compilación TypeScript/Vite y el bundle Tauri release del paquete ajustado aprobaron. En el reintento con navegadores disponibles pasaron las suites afectadas: Configuración 28/28, Pulso 117/117 y shell integrada 12/12; 157 casos aprobados y cero fallos en total, incluidos tres casos puros de Pulso. La primera ejecución detectó que el ajuste había ocultado la reanudación de una conversación histórica desde una fase; se corrigió y se repitió la suite afectada completa en Chromium y WebKit. Los 335 casos aprobados arriba corresponden al paquete anterior y no se suman a estos resultados. Computer Use volvió a rechazar la apertura del paquete ajustado sin dar un motivo específico; su revisión visual nativa sigue pendiente.

La revisión de seguridad fue acotada al flujo de permisos: la interfaz no concede por sí sola y el runner exige sesión viva, proyecto existente o creación propia y política recordada ligada a proveedor y carpeta. No se hizo una auditoría de seguridad completa. La acción de avisos lee el estado de UI ya calculado y el detalle de proyecto deja de consultar el vínculo por cada fila histórica. No se repitió el benchmark de latencia para el paquete ajustado.

### Revisión final de claridad, seguridad y fluidez

Se instaló `design-taste-frontend` (Taste Skill 2.5.1) y se usaron sus criterios aplicables a una app: textos concretos, jerarquía, foco visible y verificación visual. La referencia local de Herdr mantuvo la navegación directa al agente, la separación entre vista y runner y los estados informados explícitamente por el programa. Claude Code hizo una revisión independiente de solo lectura y señaló una preselección de permisos que podía apuntar a la última terminal usada, el refresco disruptivo del detalle y la falta de señal para ajustes sin guardar.

La entrega `Jauria-1.3.0-entrega-local.app` requiere elegir una sesión y un alcance antes de conceder acceso. Al abrir los permisos desde un proyecto se conserva el proyecto como contexto, pero no se preselecciona una terminal ajena; crear proyectos propios exige escoger esa opción. Configuración conserva encabezado y acciones visibles en la ventana mínima mientras el contenido se desplaza. Pulso evita reconstruir un detalle si su registro no cambió y, cuando debe actualizarlo, conserva el scroll, los desplegables, el contexto preparado y el foco. La continuación principal y la de fase muestran una sola acción por sesión. Los errores de reanudación no exponen el mensaje crudo del runner. Tras una reconexión, Configuración conserva visible un comando ya concedido y avisa que se compruebe la sesión; cerrar con cambios pendientes conserva el borrador de forma explícita. Un borrador de Pulso impide abrir los avisos sin cerrar Configuración.

Pasaron TypeScript/Vite, el bundle Tauri release 1.3.0, Configuración/permisos 54/54, Pulso 129/129 y la shell integrada 12/12. Estas 195 entradas verifican los cambios afectados y no se suman a las 335 del paquete inicial. Los tests de permisos usaron respuestas sintéticas; no se concedió ni revocó un permiso real. La revisión de Claude Code dio lugar además a comprobaciones de selección estable de conversación, foco de recuperación, formularios abiertos durante el refresco y continuidad del comando tras reconectar. No se repitió el benchmark de PTY: la mejora de fluidez se observa en la prueba que evita consultas de proyecto y reconstrucción del detalle cuando no cambió.

Computer Use abrió un paquete intermedio y observó Pulso en modo oscuro, Configuración con su scroll interno y pie fijo, foco al cerrar, navegación desde avisos a historial y scroll del terminal con retorno al final. Ese lanzamiento usó el perfil predeterminado (0 de 2 plazas ocupadas), no el perfil `jauria-tablero-preview-0v_rjw0y`. El paquete anterior sí había superado la recuperación exacta con ambas plazas ocupadas y la suite sintética afectada volvió a aprobar. En el intento de abrir la compilación posterior con `AW_VERTICAL_HOME` apuntando al perfil indicado, el proceso de la app arrancó y el runner existente conservó su PID, pero Computer Use devolvió `cgWindowNotFound` y no permitió inspeccionar la ventana. La entrega final incorpora después los últimos ajustes de texto y reconexión, comprobados en navegador y compilación, sin revisión visual nativa de esos cambios. No se iniciaron ni detuvieron sesiones ni se reinició el runner del usuario.

## Paquete local

El DMG de esta entrega, `Jauria-1.3.0-entrega-local.dmg`, se montó en solo lectura: contiene la app 1.3.0 y el ejecutable de interfaz coincide con el bundle construido (SHA-256 `f65b70b535ea481530279742662ba15705beb161c8f592761ad424eb67cc1faf`). SHA-256 del DMG: `088ad7130d17da1b088446721895680f7a77d7e8f66f622224248cd9ed5304ac`. El resultado anterior en `VALIDACION.json` corresponde al paquete inicial de la versión 1.3.0.

## Alcance

Sin push ni release remota. Instalador local sin Developer ID ni notarización. No se reinició el runner del usuario, no se instalaron hooks y no se cambió configuración nativa de proveedores. Las mejoras usan los endpoints existentes de 1.2.0 y no requieren detener las sesiones activas. Codex conserva historial/contexto, sin reanudación nativa. No es una certificación de seguridad.

## Terminal y MCP local

La entrega `Jauria-1.3.0-terminal-mcp-local.app` añade un adaptador MCP local del runner 1.3.0 y un texto copiable para pedir al agente que registre el plan. El adaptador solo publica ocho herramientas de Pulso; cada llamada vuelve a leer el permiso acotado de la sesión. No cambia los permisos nativos de Claude Code/Codex ni instala sus configuraciones.

- Runner end to end: `cargo test --offline --test pulso_rpc`, 10/10 aprobadas. En perfiles temporales, el comando mostrado en la UI ejecutado con `zsh` creó un proyecto, la CLI creó una fase y se verificaron los registros desde el servicio. Otro caso lanzó el binario MCP real por `stdio`, creó proyecto y fase, reintentó ambas solicitudes sin duplicados, actualizó una fase con revisión, guardó un checkpoint, verificó el alcance al pasar de creación propia a proyecto concreto, creó otra fase dentro de ese proyecto y rechazó la lectura tras revocar el permiso. La ampliación de este último caso se ejecutó otra vez y aprobó.
- Cliente MCP oficial de JavaScript 1.32.2 en un directorio temporal: inicialización, descubrimiento de ocho herramientas y rechazo de una llamada sin permiso. No se modificó el archivo MCP real de Claude Code ni el de Codex.
- Configuraciones aisladas de proveedor: `claude mcp add-json`/`get` confirmó conexión al servidor cuando se pasan las variables de una sesión; `codex mcp list` aceptó la entrada TOML y sus variables. Se usaron directorios temporales y un permiso inexistente, sin tocar configuraciones reales ni iniciar agentes.
- Configuración y permisos en Chromium/WebKit: 34/34 aprobadas; la copia incluye comando, proyecto elegido e instrucciones de reintento sin exponer el objeto de permiso. Shell integrada: 12/12 aprobadas. TypeScript/Vite, `cargo build --release --offline` y bundle Tauri aprobados. El DMG se verificó con `hdiutil`; la app contiene el mismo runner release por SHA-256. La captura sintética de Configuración se regeneró e inspeccionó con el texto nuevo.

Los resultados anteriores de 335 pruebas iniciales y 195 afectadas no se suman a estas ejecuciones. El MCP real dentro de Claude Code o Codex aún requiere configurar cada proveedor y abrir una nueva sesión con el runner 1.3.0. Se abrió el paquete final con `AW_VERTICAL_HOME` apuntando a un perfil temporal para una inspección nativa; Computer Use volvió a responder `cgWindowNotFound`, así que no se pudo certificar visualmente esta app. Se cerró únicamente ese proceso de prueba. Se mantuvieron vivos el runner 1.2.0 del perfil indicado y sus dos sesiones, sin conceder ni revocar permisos reales.

## Cambio entre sesiones

El 17 de noviembre se observó en la interfaz nativa 1.3.0 en ejecución que un clic sobre otra sesión podía perderse y dejar visible la anterior. La lista lateral se reconstruía al cambiar cualquier metadato de la respuesta periódica de estado. La corrección mantiene montados los botones mientras la composición de la lista sea la misma y actualiza sus etiquetas y avisos en el mismo elemento.

Una prueba integrada con respuestas sintéticas que cambian metadatos en cada consulta mantuvo el ratón presionado durante un refresco y verificó el cambio al soltarlo; también comprobó el selector del panel y la vista dividida, sin entrada al PTY. Aprobó en Chromium y WebKit (2/2). Las 26 pruebas de la shell Pulso y las 16 entradas de avisos/selección en ambos navegadores aprobaron; TypeScript/Vite aprobó. No se reinició ningún runner ni se cerró ninguna sesión real. El paquete nuevo se compiló aparte de las apps que siguen abiertas.

Computer Use abrió ese paquete con `AW_VERTICAL_HOME` en un perfil privado temporal y `AW_VERTICAL_SMOKE=1`. Creó dos fixtures, enfocó cada uno desde la lista lateral con la vista dividida, volvió a un panel y cambió otra vez; el encabezado y el selector coincidieron con la sesión enfocada, y el contador permaneció en 2 de 2. Al terminar se cerraron solo la app, el runner y los dos procesos fixture de ese perfil temporal. El DMG se verificó y montó en solo lectura; incluye la app 1.3.0 y el runner release esperado. La app real 1.3.0 que seguía abierta no se sustituyó.
