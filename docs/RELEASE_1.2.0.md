# Jauria 1.2.0 — tablero de proyectos y estado explícito

Entrega local verificada para macOS Apple Silicon. Código propio **GPL-3.0-only**. Instalador sin firma Developer ID ni notarización; no se publicó ni se sustituyó la app del perfil habitual. Los resultados y límites están en [la validación de 1.2.0](PULSO_VALIDATION_1.2.0.md).

## Cambios visibles

- Cada proyecto tiene una pestaña de tablero con **Por hacer, En curso, En espera y Hecho**. La pestaña fija **Pendientes** incluye tarjetas independientes terminadas.
- **Nuevo proyecto** pide nombre y ofrece usar la sesión actual como principal, con casilla marcada cuando está disponible. Crear abre la pestaña del proyecto.
- **Añadir fase** captura inline en las tres primeras columnas; en Pendientes se llama **Añadir pendiente**. No hay captura inline en Hecho.
- Arrastrar el agarre con el puntero entre columnas o usar **Mover** con el teclado cambia el estado conservando el orden de fases. Reordenación dentro de columna, columnas personalizadas y traslado entre proyectos quedan pendientes.
- **Abrir** una tarjeta muestra el drawer derecho con edición de título, notas y estado, último avance y siguiente paso. **Guardar avance** se despliega para añadir un checkpoint inmutable. Abrir no inicia un PTY.
- **Plan y sesiones** en la barra del tablero reúne plan opcional, principal, vínculos y permisos fuera de las columnas. El contexto de fase sigue siendo editable y copiable; abrir una sesión nueva la deja vacía, sin envío automático al PTY.

## Datos, permisos y señales

`board` es una operación exclusiva de UI: snapshot atómico bajo mutex del servicio, cuatro columnas, 20 tarjetas iniciales por columna y contadores totales. `items` permite filtrar `status` y cargar páginas de hasta 50 con `expectedSnapshotRevision`; una revisión obsoleta se rechaza antes de usar el offset. No hay polling de Pulso oculto. Se mantienen almacenamiento, presupuestos, revisiones e idempotencia de 1.1.

Los permisos para agentes siguen usando la CLI local con alcance explícito por proyecto y políticas revocables. No amplían los permisos de la CLI nativa. MCP y reanudación nativa Codex continúan pendientes. Claude mantiene el intento manual por ID reservado y los bloqueos de escritor/conversación de 1.1; no se promete historial conservado por el proveedor ni reanudación automática.

La vista viva escucha **OSC 7501** pasivamente: payload de hasta 1.024 bytes UTF-8, solo `state` raíz con `working`, `blocked`, `error`, `done`, `idle` o `clear`. Ignora `msg`, `title`, `progress` y otros campos; rechaza registros `id` de hijos, consultas y entradas ambiguas sin responder. No instala hooks ni configura agentes. Sin emisión explícita no hay estado de programa.

El estado es cosmético, efímero y se reinicia al reconectar; el replay no aplica señales ni produce avisos. Los refrescos se agrupan y los avisos relevantes se limitan a uno por sesión cada cinco segundos. No hay escrituras de fase por señales del terminal: `done` no prueba validación ni completa una tarjeta.

La [revisión de Herdr](HERDR_REVIEW.md) fija commits y decisiones. Se adoptan separación vista/runtime, estado explícito y retorno directo a sesión; se difieren mods JavaScript sin sandbox, SSH remoto, telemetría y reanudación automática. No se copia código ni se añade dependencia Herdr.

## Validación y entrega

- Runner: 437 aprobadas; bridge: 40; Node general: 82 aprobadas y 4 omitidas; Pulso en Chromium/WebKit: 85; regresiones de terminal: 15; Python: 16.
- Dos benchmarks release aprobados con 2/8 PTY y 500 tarjetas; entrega completa y controles bajo un segundo. Son mediciones locales del eco del hijo, no tiempos de pintura ni del proveedor.
- Versión 1.2.0 y recursos de licencia del bundle comprobados; 8 regresiones contra el runner empaquetado aprobadas. El DMG se montó en solo lectura y coincidieron los hashes de app y runner.
- Revisión visual: tablero, temas y drawer aprobados en el alcance inspeccionado. El hallazgo F1 sobre Deshacer se corrigió; su revisor confirmó ese ajuste en ambos motores/temas a 760 px con el editor abierto.
- Captura sintética actual: [tablero 1.2.0](screenshots/pulso-1.2.0.png).
- Instalador: `Jauria_1.2.0_aarch64_unsigned.dmg`, checksum y recibo; código fuente correspondiente adjunto a la entrega local. Sin push ni release remota de esta versión.
- El proceso nativo de ejemplo arrancó y conectó con su perfil separado. La automatización del escritorio devolvió `cgWindowNotFound` también para Finder: no se pudo confirmar la ventana nativa en primer plano. Las capturas son de la shell real con frontera nativa sintética, no capturas nativas de ese proceso.

La revisión y los fixtures no equivalen a auditoría integral ni certificación. No se probaron conversaciones o credenciales reales del proveedor ni se alteró el perfil habitual.

## Actualizar y recuperar

Instalar una interfaz nueva no sustituye un runner ya ejecutándose. Resuelve el trabajo activo antes de **Información → Diagnóstico → Reiniciar runner…**; este documento no autoriza detener sesiones automáticamente. Usa perfiles temporales para la validación de la entrega y conserva el perfil real.

Antes de manipular datos, sigue [el respaldo consistente de SQLite](PULSO.md#respaldo-local). Pulso conserva sus límites de almacenamiento y no añade exportación/restauración desde UI. Importación del Site y sincronización en la nube siguen fuera del alcance.

Consulta [uso de Pulso](PULSO.md), [instalación](INSTALLATION.md) y [desarrollo](DEVELOPMENT.md).
