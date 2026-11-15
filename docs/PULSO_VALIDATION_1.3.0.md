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

La interfaz 1.3.0 se abrió contra el mismo runner 1.2.0 existente: ambas sesiones siguieron vivas y la generación del runner no cambió. El servicio de automatización de escritorio dejó de responder antes de comprobar visualmente la ventana final; esta comprobación nativa queda pendiente. Las capturas publicadas son sintéticas de la shell real en navegador, sin datos del usuario. Las pruebas de navegador no sustituyen esa comprobación nativa.

## Paquete local

El DMG se montó en solo lectura: versión, ejecutable de interfaz y runner coinciden con el bundle final. SHA-256 del DMG: `2b0f1537c65c628643cfed2c4cb001ec02393e0f2fd9d15c2d3cf891c69c8c27` (consulta `SHA256SUMS` de la entrega para el valor definitivo). El archivo fuente correspondiente se adjunta a la entrega local tras el commit.

## Alcance

Sin push ni release remota. Instalador local sin Developer ID ni notarización. No se reinició el runner del usuario, no se instalaron hooks y no se cambió configuración nativa de proveedores. Las mejoras usan los endpoints existentes de 1.2.0 y no requieren detener las sesiones activas. Codex conserva historial/contexto, sin reanudación nativa. No es una certificación de seguridad.
