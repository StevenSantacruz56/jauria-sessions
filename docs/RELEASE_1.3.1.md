# Jauria 1.3.1 · Actividad y avisos

## Qué cambió

La barra lateral incorpora **Actividad** como vista priorizada de sesiones: acción requerida, avisos explícitos, turnos o procesos terminados, trabajo en curso, espera y procesos abiertos sin reporte del agente. La navegación de repositorios se oculta solo en Actividad y Avisos, para dar espacio a la lista. Cada fila muestra un estado legible; la cabecera del terminal presenta el estado que declaró el agente. Al trabajar, se indica desde cuándo esta interfaz observó `working`.

La campana conserva el contador de avisos sin ver y el Dock mantiene ese mismo número. La barra de avisos muestra una causa prioritaria y **Abrir sesión**. `blocked/error` permanece visible mientras lo informe el programa; `working → done/idle` conserva un turno terminado sin ver aunque llegue otro `idle`. Seleccionar la sesión marca visto ese turno. BEL y las notificaciones explícitas siguen siendo avisos separados. Los avisos nativos opcionales indican la categoría con texto genérico, sin nombres, rutas ni contenido de terminal.

Los reportes OSC 7501 siguen siendo pasivos y locales a la ventana: no cambian fases de Pulso, permisos, archivos ni procesos. Una sesión abierta sin reporte no se presenta como trabajo en curso. Cerrar la interfaz o reconectar pierde el estado y la marca de visto de esos reportes; no se afirma persistencia en el runner. [Reglas completas](SESSION_ALERTS.md#actividad-y-avisos-desde-131) y [comparación con Herdr](HERDR_REVIEW.md#actividad-y-avisos-en-131).

## Validación de esta entrega

- `python3 scripts/version.py --check` y 16 pruebas Python: aprobadas.
- `npm run build`: TypeScript y Vite aprobaron. 95 pruebas unitarias de frontend aprobaron; cinco suites de navegador optativas estaban omitidas en ese comando.
- Navegación real con xterm y límites Tauri sintéticos: 26 casos de Pulso/estado en Chromium y WebKit, ocho casos de consistencia de avisos en Chromium y seis casos de geometría en Chromium/WebKit aprobaron. La barra de mensajes conservó la altura del terminal.
- `cargo build --release --locked` del runner y `tauri build --bundles app --no-sign -- --locked` del escritorio aprobaron. El paquete macOS es local, sin firma Developer ID ni notarización.
- Se inspeccionaron capturas sintéticas en tema claro y oscuro, y se corrigió el espacio de la lista prioritaria. El detector de diseño señaló solo dos avisos sobre Inter, la tipografía existente de Jauria.

No se ejecutaron proveedores reales ni se probó la entrega de una notificación de macOS. La revisión de Claude fue de solo lectura y orientó las reglas de estado; no sustituye las pruebas. La ejecución de GitHub Actions puede seguir bloqueada por la facturación de la cuenta, independiente de esta validación local.
