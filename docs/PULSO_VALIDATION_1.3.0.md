# Validación local de Jauria 1.3.0

Fecha: 2026-11-14. macOS Apple Silicon. Pruebas funcionales con perfiles y datos sintéticos; no se concedieron ni revocaron permisos en el perfil del usuario.

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

## Paquete local

El DMG se montó en solo lectura: versión, ejecutable de interfaz y runner coinciden con el bundle final. SHA-256 del DMG: `2b0f1537c65c628643cfed2c4cb001ec02393e0f2fd9d15c2d3cf891c69c8c27` (consulta `SHA256SUMS` de la entrega para el valor definitivo). El archivo fuente correspondiente se adjunta a la entrega local tras el commit.

## Alcance

Sin push ni release remota. Instalador local sin Developer ID ni notarización. No se reinició el runner del usuario, no se instalaron hooks y no se cambió configuración nativa de proveedores. Las mejoras usan los endpoints existentes de 1.2.0 y no requieren detener las sesiones activas. Codex conserva historial/contexto, sin reanudación nativa. No es una certificación de seguridad.
