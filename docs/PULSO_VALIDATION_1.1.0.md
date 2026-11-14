# Validación local de Pulso en Jauria 1.1.0

Fecha: 2026-11-14. Entorno: macOS Apple Silicon, build release arm64. Todas las pruebas usan datos sintéticos y perfiles temporales; no se detuvieron sesiones reales ni se activó el runner instalado.

## Resultado funcional

- Runner: 431 pruebas aprobadas; 8 optativas omitidas en la ejecución ordinaria. Dos benchmarks optativos se ejecutaron por separado y aprobaron. Las otras 6 pruebas optativas permanecen fuera de este cierre.
- Bridge Tauri: 38 aprobadas.
- TypeScript/Vite: compilación de producción aprobada; Node: 69 aprobadas, 4 omitidas por sus condiciones explícitas de entorno.
- Pulso en Chromium/WebKit: 37 comprobaciones aprobadas, incluyendo captura, fase, historial paginado, recuperación, conflictos, reintentos tras respuesta incierta, permisos, revocación, borradores y sesión que termina sin cambiar el plan.
- Shell completa en ambos motores: misma instancia xterm y posición de lectura al entrar/salir de Pulso; sin input al proveedor, sin resize oculto y sin polling de Pulso oculto.
- Geometría de avisos: cuatro combinaciones de motor/tamaño (Chromium y WebKit, 1220×800 y 760×640) aprobadas; sin resize de PTY al mostrar/consumir avisos o reconectar.
- Regresiones de terminal: anclas con 42.000/50.000 bloques, scroll, resize, teclado y pegado concurrentes aprobados en ambos motores.
- Empaquetado/versionado: 16 pruebas Python aprobadas. Bundle 1.1.0 con runner coincidente por SHA-256 y recursos de licencia presentes; RPC core/Pulso del runner empaquetado aprobado en un perfil temporal; 8 regresiones adicionales de preferencias/streams aprobadas contra ese ejecutable. DMG montado en solo lectura: contenidos, licencias y hash del runner verificados.

## Latencia observada

La prueba envía comandos a un hijo PTY sintético y exige su línea exacta de respuesta: el eco del comando del kernel no cuenta. No mide la pintura de pantalla, latencia del modelo ni servicios remotos. Los tiempos son observaciones locales, no garantías ni umbrales portables de CI.

Comparación de 40 muestras, dos terminales, frente al runner base 1.0.1:

| p95 | Base 1.0.1 | 1.1.0 |
| --- | ---: | ---: |
| Input → eco del hijo | 1,151 ms | 1,060 ms |
| Acuse de input | 0,049 ms | 0,069 ms |
| Status | 0,539 ms | 0,844 ms |

Comparación del mismo binario 1.1.0, 80 ecos por ventana y 500 fases. La carga añade lecturas, 12/13 actualizaciones confirmadas por ventana y clientes lentos en el endpoint independiente de Pulso:

| Sesiones | Eco p95 sin carga | Eco p95 con Pulso | Entrega por ventana |
| --- | ---: | ---: | ---: |
| 2 | 2,967 ms | 3,052 ms | 80/80 |
| 8 | 2,769 ms | 3,090 ms | 80/80 |

Con carga, interrupt: 10,64/11,39 ms; resize: 0,37/0,59 ms; stop: 2,88/1,43 ms; shutdown del fixture: 71,29/116,25 ms. Sin pérdida observada. El p95 adicional del eco con 8 sesiones fue 0,321 ms. La prueba comprueba además un presupuesto de un segundo para controles.

## Revisión y límites

Gitleaks no encontró secretos en el diff completo preparado para el commit, con redacción total. Este resultado no sustituye la revisión de seguridad.

Claude Code revisó el diseño y el código en varias rondas. Se corrigieron bloqueo del lector PTY por políticas, reintentos de reanudación, revocación tardía, recreación de políticas, clientes lentos, credenciales ante fallo de almacenamiento, margen para recuperar permisos y consultas que recorrían todo el historial. Las regresiones relevantes tienen pruebas sintéticas.

La prueba de geometría de notificaciones anterior esperaba un banner automático; falló también sobre la base 1.0.1. Se ajustó al flujo vigente: campana primero, detalle al elegir el filtro. La ejecución corregida aprobó los cuatro casos en ambos motores. Se adaptó también la prueba al cierre del drawer en ventana estrecha.

Esta revisión es acotada; no es una auditoría integral ni certificación de seguridad. No se comprobó el historial real de un proveedor ni se importaron registros del Site. Codex conserva terminal y continuidad por contexto; su ID nativo y un adaptador MCP están pendientes. La app instalada y el perfil real se conservan.
