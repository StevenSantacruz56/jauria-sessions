# Validación local de Jauria 1.2.0

Fecha: 2026-11-14. macOS Apple Silicon; build release arm64. Los fixtures usan datos sintéticos y perfiles privados separados. No se detuvieron proveedores del usuario ni se modificó su perfil habitual.

## Resultado funcional

- Runner completo: **437 aprobadas**, 8 optativas omitidas en la ejecución ordinaria. Los dos benchmarks optativos se ejecutaron aparte y aprobaron; quedan 6 optativas fuera de este cierre.
- Bridge Tauri: **40 aprobadas**.
- TypeScript/Vite: compilación de producción aprobada. Node general: **82 aprobadas, 4 omitidas** por sus condiciones explícitas de entorno.
- Flujo Pulso en Chromium/WebKit: **85 comprobaciones aprobadas**, incluyendo shell completa, arrastre, menú de estado, creación, idempotencia, borradores, permisos, páginas, continuidad y estados de programa.
- Regresiones de terminal en Chromium/WebKit: **15 aprobadas**, con avisos, geometría, anclas, scroll y entrada concurrente.
- Runner empaquetado: **8 regresiones aprobadas** de preferencias/streams, además del smoke RPC core/tablero.
- Python de versiones/empaquetado: **16 aprobadas**.

Regresiones específicas: doble Esc y cierre nativo forzado conservan borrador, foco y acceso al reintento; un refresco tardío no reemplaza lo escrito; respuestas antiguas no devuelven tarjetas a un snapshot anterior; las columnas ampliadas conservan sus tarjetas mediante páginas de la misma revisión. La navegación fallida conserva el proyecto confirmado; salir durante una carga o arrastre no deja controles bloqueados ni produce un movimiento tardío.

Los estados OSC 7501 usan xterm real, fragmentación incluida: el historial no alerta, los campos no confiables no aparecen en el chrome y no se envían respuestas al PTY ni se cambian fases. Una alerta aplazada por frecuencia se entrega si la sesión sigue necesitando atención. Los cambios cosméticos del programa no recargan el tablero ni pliegan el editor.

La primera revisión visual encontró un aviso Deshacer que cubría Añadir fase a 760 px. Se corrigió colocando feedback persistente en el flujo del panel, y se añadieron comprobaciones con el editor abierto en ambos motores y temas. El revisor confirmó F1 resuelto en los cuatro casos de motor/tema a 760 px, con Deshacer visible y el editor abierto. El veredicto cubre ese hallazgo; las demás áreas ya habían pasado su revisión acotada.

## Latencia observada

Se exige la línea exacta del hijo PTY; el eco del comando del kernel no cuenta. Estas observaciones locales no miden pintura de pantalla, servicios del proveedor ni respuesta del modelo. No son garantías portables de tiempo.

Comparación A/B release, 40 muestras y dos terminales:

| p95 | Base 1.1.0 | 1.2.0 |
| --- | ---: | ---: |
| Input → eco del hijo | 1,337 ms | 1,131 ms |
| Acuse de input | 0,064 ms | 0,064 ms |
| Status | 0,683 ms | 0,767 ms |

Mismo binario 1.2.0, 500 tarjetas repartidas entre cuatro estados, 80 ecos por ventana, lecturas del endpoint **board**, escrituras concurrentes y clientes lentos en Pulso:

| Terminales | Eco p95 sin carga | Eco p95 con tablero | Entrega por ventana | Escrituras confirmadas |
| --- | ---: | ---: | ---: | ---: |
| 2 | 3,143 ms | 3,163 ms | 80/80 | 12 |
| 8 | 3,668 ms | 3,952 ms | 80/80 | 13 |

Con 8 terminales, el incremento observado fue 0,284 ms. Interrupt: 11,00/13,39 ms; resize: 0,074/0,579 ms; stop: 6,12/3,34 ms; shutdown del fixture: 67,59/117,90 ms. Los controles aprobaron su presupuesto explícito de un segundo. No hubo pérdida observada.

## Revisión y alcance

Claude Fable y GPT Astra revisaron el diseño. Se acotó el gesto a cambios de estado para preservar el orden del plan, sin introducir un segundo sistema de ranking. Claude Opus escribió el parser/tracker original de estados y revisó el código integrado; sus hallazgos de cierre, concurrencia, alertas y tamaño de respuesta se corrigieron con pruebas de regresión.

El tablero limita notas a vistas previas de 240 caracteres; detalle y almacenamiento conservan el texto completo. Una prueba con 80 tarjetas y controles C0 verifica que el JSON escapado con sobre/cierre cabe en 512 KiB. No se depende de que una prueba con emoji represente el peor caso.

La revisión de Herdr fue de fuentes fijadas, sin instalarlo ni ejecutar sus scripts. No se copió código ni se añadió dependencia. Consulta [fuentes y decisiones](HERDR_REVIEW.md).

El código mantiene los permisos nativos, el canal CLI acotado y la separación de runtime/vista. La revisión y los fixtures no son una auditoría integral ni certificación. No se comprobó historial real de proveedores, MCP, reanudación nativa Codex, sincronización o máquinas remotas.

El DMG se montó en solo lectura: ejecutable, runner y licencias verificados. El proceso nativo de ejemplo arrancó y publicó su layout de conexión; la automatización del escritorio falló con `cgWindowNotFound`, también en Finder, por lo que no se confirmó su ventana en primer plano. No se sustituye esa comprobación por las capturas del navegador. El escaneo del diff queda en el recibo de entrega local. El instalador se mantiene local, sin firma Developer ID ni notarización y sin publicación automática.
