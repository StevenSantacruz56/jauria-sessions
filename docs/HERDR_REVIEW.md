# Herdr: revisión de fuentes y decisiones para Pulso 1.2.0

Revisión acotada de código y documentación de clones locales de los tres repositorios. Describe los commits indicados, no el estado futuro de sus ramas. No es una auditoría de seguridad ni una prueba de ejecución de Herdr.

## Fuentes primarias fijadas

| Componente | Commit revisado | Evidencia |
| --- | --- | --- |
| `herdr-app`, aplicación de escritorio | `5216e6f9f8c0c281a65e09816c66e4319e671784` | [README](https://github.com/herdrdev/herdr-app/blob/5216e6f9f8c0c281a65e09816c66e4319e671784/README.md), [welcome](https://github.com/herdrdev/herdr-app/blob/5216e6f9f8c0c281a65e09816c66e4319e671784/defaults/frame/welcome/main.js), [layouts y mods](https://github.com/herdrdev/herdr-app/blob/5216e6f9f8c0c281a65e09816c66e4319e671784/docs/mods.md), [seguridad y privacidad](https://github.com/herdrdev/herdr-app/blob/5216e6f9f8c0c281a65e09816c66e4319e671784/docs/security.md) |
| `herdr-core`, runtime y CLI `hc` | `c84d6e76156a6c2aac1da20efbe800f10acfe897` | [README: runtime, API y estado explícito](https://github.com/herdrdev/herdr-core/blob/c84d6e76156a6c2aac1da20efbe800f10acfe897/README.md), [implementación de estado](https://github.com/herdrdev/herdr-core/blob/c84d6e76156a6c2aac1da20efbe800f10acfe897/crates/herdr-core/src/status.rs) |
| `herdr`, cliente TUI y servidor | `ee5bfb5041bb3e4a49d591c72308aae3c81ecdde` | [README](https://github.com/herdrdev/herdr/blob/ee5bfb5041bb3e4a49d591c72308aae3c81ecdde/README.md), [documentación de estado y restauración en docs/next](https://github.com/herdrdev/herdr/blob/ee5bfb5041bb3e4a49d591c72308aae3c81ecdde/docs/next/website/src/content/docs/session-state.mdx) |

## Qué se encontró

La app de escritorio organiza espacios, pestañas y paneles; el core ejecuta terminales y conserva su vida independientemente de la ventana. Su lista de agentes permite volver directamente a un agente o verlo en una vista temporal. El core documenta estados declarados mediante OSC 7501 y ausencia de estado cuando el programa no informa. Estas son referencias para separar navegación, ejecución y señales explícitas, según los README fijados arriba.

No se encontró un tablero Trello incorporado en las fuentes revisadas. El welcome de **herdr-app** sugiere pedir a un agente un tablero de agentes u otros paneles como personalización mediante mods; no demuestra que exista un gestor de proyectos con columnas y fases ya incluido. La búsqueda y esta conclusión se limitan a los clones fijados, no a todas las extensiones que pudieran existir.

**herdr TUI y herdr-app son superficies distintas.** El README del TUI describe un binario Rust que funciona dentro de otra terminal; la app usa layouts y mods JavaScript. La documentación `docs/next` del TUI distingue procesos vivos, restauración de layout, replay y reanudación nativa. Sus capacidades de restore no son evidencia de que Jauria las implemente ni de que la app tenga exactamente el mismo flujo.

La guía de seguridad de la app declara que los mods son código confiado con capacidad de ejecutar programas, leer archivos y usar red, sin sandbox. También documenta telemetría habilitada por defecto en releases. El acceso SSH está descrito por la app y el core. Se registran como diferencias de alcance, no como funciones adoptadas por Jauria.

## Matriz de decisiones

| Referencia | Decisión en Jauria 1.2.0 | Límite |
| --- | --- | --- |
| Separación ventana/runtime | Mantener Pulso como vista sobre el runner y conservar terminales al navegar. | Abrir una tarjeta solo abre el drawer; no inicia PTY. |
| Volver directamente al agente | Mantener retorno explícito a sesión viva e historial separado. | Consultar historial no reinicia procesos. |
| Estado declarado por el programa | Adoptar escucha pasiva del subconjunto raíz OSC 7501. | Solo cosmética viva; sin hooks, respuestas, configuración automática ni escrituras de fase. |
| Personalización de tableros | Implementar tablero propio de fases con cuatro columnas fijas. | Sin copiar mods o código; no se atribuye un Trello incorporado a Herdr. |
| Mods JavaScript sin sandbox | Diferir. | No se añade un runtime de extensiones con ejecución arbitraria. |
| Máquinas remotas por SSH | Diferir. | No se añade gestión de terminales remotas. |
| Telemetría | Diferir. | No se incorpora telemetría de Herdr. |
| Restore/reanudación automática | Diferir. | Claude conserva intento manual por ID reservado; Codex nativo y MCP siguen pendientes como en 1.1. |

## Decisión y colaboración

El usuario rechazó el flujo de Pulso 1.1 y pidió una interacción tipo Trello. Fable preparó la propuesta inicial; Claude Opus escribió código en un checkout aislado. Las 12 pruebas de ese módulo aprobaron antes de la integración. La integración y el instalador tienen su [validación separada](PULSO_VALIDATION_1.2.0.md); no se trasladan automáticamente los resultados de un módulo al producto completo. Astra aportó análisis y una checklist acotada; no se presenta como certificación o auditoría integral.

La decisión final se contrasta con el código actual: [pulso-panel.ts](../experiments/tauri-vertical/desktop/src/pulso-panel.ts) implementa el tablero y drawers; [program-status.ts](../experiments/tauri-vertical/desktop/src/program-status.ts), escrito por Claude, delimita el parser pasivo; [main.ts](../experiments/tauri-vertical/desktop/src/main.ts) integra las señales vivas y sus avisos; [pulso_store.rs](../experiments/tauri-vertical/runner/src/pulso_store.rs) proporciona snapshots y paginación por columna. Las propuestas no sustituyen esa fuente de comportamiento.

`claude-board-debate.json` y los registros de revisión de código son material privado de trabajo. Aquí solo se resume la decisión: no se copian logs, transcripciones ni contenido privado. No se copió código Herdr ni se añadió dependencia de Herdr. La licencia raíz de Jauria permanece **GPL-3.0-only**.

Consulta [el flujo real de Pulso](PULSO.md) y [los pendientes de entrega](RELEASE_1.2.0.md).

## Aplicación en 1.3.0

El retorno directo se concreta en la acción del tablero para continuar o reanudar la principal y enfocar una continuación existente. La vista recuerda el último tablero por perfil, sin ejecutar procesos al restaurar el layout. Los permisos y avisos se administran en Configuración; no se añaden mods ni capacidades remotas. La revisión con Claude detectó y permitió corregir acciones de recuperación obsoletas, caché de identidad tras cambios de sesiones y alcance de los permisos seleccionados. Los límites de reanudación del proveedor siguen vigentes.

## Actividad y avisos en 1.3.1

El 17 de noviembre se revisó de nuevo [herdr.dev](https://herdr.dev/) y, en los commits fijados arriba, [la vista de agentes de Herdr](https://github.com/herdrdev/herdr-app/blob/5216e6f9f8c0c281a65e09816c66e4319e671784/defaults/mods/agents/main.js), [su modelo de estados vistos](https://github.com/herdrdev/herdr-app/blob/5216e6f9f8c0c281a65e09816c66e4319e671784/src/model.rs) y [el estado OSC del core](https://github.com/herdrdev/herdr-core/blob/c84d6e76156a6c2aac1da20efbe800f10acfe897/crates/herdr-core/src/status.rs). El sitio describe la barra lateral y pestañas como lugares para ver qué agente trabaja, terminó o espera a la persona. La fuente ordena **Needs you → Done → Working → Idle**, mantiene el fin no visto y distingue el estado reportado de la apertura de un terminal. Claude hizo una lectura independiente, sin editar el checkout, y señaló que Jauria pintaba `running` como trabajo, perdía `done → idle` y podía ocultar `blocked` si se reportó mientras la sesión estaba enfocada.

Jauria adopta la jerarquía de información, no código ni servicios de Herdr. **Actividad** agrupa acción requerida, avisos explícitos, turnos terminados, trabajo declarado, espera y sesiones sin reporte. Las filas, la cabecera del terminal y la barra de avisos muestran causas concretas y una acción para abrir la sesión. El tiempo de trabajo empieza cuando esta interfaz observa un cambio a `working`; no es una medida histórica del proceso. Un `blocked/error` queda visible mientras se declara; `working → done/idle` queda pendiente hasta abrir la sesión. BEL y notificaciones OSC siguen separadas de la terminación de un turno. La lectura de salida cruda no produce estados. Los avisos de macOS continúan por consentimiento, agrupados y sin título de sesión ni ruta.

La diferencia técnica sigue explícita: Herdr conserva hechos de estado y visto en su core; Jauria los conserva solo en la ventana. Cerrar la interfaz o reconectar borra el estado OSC observado y no recupera turnos no vistos. Sin OSC 7501, Jauria solo sabe si el proceso está abierto; no inventa progreso, espera, porcentaje ni aceptación del trabajo. Los reportes no modifican fases, permisos ni la ejecución del agente. Consulta [los límites y pruebas de avisos](SESSION_ALERTS.md#actividad-y-avisos-desde-131).
