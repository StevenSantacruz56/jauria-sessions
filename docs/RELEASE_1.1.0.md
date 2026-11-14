# Jauria 1.1.0 — planes y continuidad dentro de una app

Entrega local para macOS Apple Silicon. Código propio GPL-3.0-only. El instalador sigue siendo local, sin firma Developer ID ni notarización.

## Cambios

- Pulso integrado: proyectos de plan, fases ordenadas y pendientes independientes, sin exigir Git.
- Sesión principal (la actual por defecto al crear el proyecto, si está disponible) y sesiones relacionadas; puntos de continuidad inmutables con siguiente acción, contexto editable y copia manual para una sesión nueva vacía.
- Acceso explícito para agentes mediante CLI local, con alcance por proyecto, casilla de recordar desmarcada al inicio, políticas y revocación.
- Credenciales y conexión Pulso separadas del canal de terminal, con almacenamiento independiente.
- Identidades reservadas para nuevas conversaciones Claude e intento de reanudación por ID exacto, respetando los bloqueos de workspace y los permisos nativos. La vista permite enfocar la continuación viva y conserva los vínculos y metadatos de origen.
- Conservación de xterm, scroll y paneles al entrar/salir de la vista de planificación; botones separados para sesión viva e historial.
- Consultas paginadas en SQL; detalle con los últimos 10 checkpoints y **Ver puntos anteriores** en páginas de 10.

## Alcance

Historial de terminal, conversación nativa y contexto de fase son mecanismos distintos. La reanudación puede fallar si el proveedor no guardó su conversación; no se selecciona la última ni se envían instrucciones automáticamente.

Codex sigue en terminal. La captura automática de su ID nativo, MCP, importación del Site Pulso y sincronización entre dispositivos quedan fuera de esta entrega. El registro de planes por agentes usa la CLI copiable de Pulso.

Pulso limita sus datos a 64 MiB lógicos o 100.000 filas, con 1 MiB/2.000 filas adicionales de margen solo para identidades de permisos y políticas, y un límite físico de 128 MiB para su base. Las lecturas continúan al alcanzar el presupuesto. No hay borrado automático ni exportación desde la interfaz; la guía describe un respaldo consistente de SQLite.

## Actualización y recuperación

La base core conserva su versión de esquema. Pulso añade su propio almacenamiento y las reservas nativas conservan sus IDs fuera del historial de salida. Un fallo del módulo no elimina datos ni bloquea las terminales. La interfaz detecta un runner anterior sin reiniciarlo.

Compilación release, pruebas y verificación del instalador local completadas. Consulta los recuentos y métricas en [la validación de 1.1.0](PULSO_VALIDATION_1.1.0.md). No se ha activado la app instalada ni se ha probado el perfil real del usuario. Los fixtures usan perfiles temporales y datos sintéticos; no prueban disponibilidad del historial real de Claude, rendimiento de proveedores remotos ni una auditoría integral de seguridad.

Consulta [uso de Pulso](PULSO.md), [plan y decisiones](PULSO_INTEGRATION_PLAN.md) e [instalación](INSTALLATION.md).
