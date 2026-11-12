# Desarrollo y validación

La raíz contiene documentación curada y scripts portables. La aplicación permanece en `experiments/tauri-vertical/desktop`; el proceso runner en `experiments/tauri-vertical/runner`. Los imports compartidos `#[path]` dependen de esta disposición.

```sh
python3 scripts/build-macos.py --check-only
python3 scripts/build-macos.py
```

El primer comando realiza frontend y tests del runner y del bridge nativo sin generar el bundle Tauri. Ambos ejecutan los tests Rust del runner y las suites `rpc` y `storage_retention`, además de `cargo test --locked` en `desktop/src-tauri` para el bridge nativo. Los tests existentes crean fixtures temporales y procesos de prueba; no necesitan login de proveedores. No se incluyen los harnesses locales de pruebas con proveedores ni los registros originales.

El fixture `runner/tests/fixtures/protocol.synthetic.jsonl` contiene exclusivamente mensajes construidos para pruebas: dos solicitudes de aprobación, 24 fragmentos de mensaje y tres terminaciones de turno. La prueba `replay_synthetic_protocol_offline` conserva las aserciones del replay: dos denegaciones, tres terminaciones y más de veinte eventos normalizados. No es una transcripción nativa ni demuestra comportamiento real del proveedor.

El workflow `.github/workflows/macos.yml` configura Node 24 para ejecutar los tests TypeScript con el soporte nativo de borrado de tipos; no implica que los tests locales se hayan ejecutado en Node 24. Usa Rust estable, macOS Apple Silicon, permisos de repositorio de solo lectura y acciones fijadas a SHA. No instala CLI de proveedores, no realiza login, no firma, no publica ni sube perfiles o evidencia. Referencia del runner: https://docs.github.com/en/actions/reference/runners/github-hosted-runners .

Los resultados deben verificarse sobre el snapshot final: una compilación anterior al freeze no valida cambios posteriores. Firma, notarización, instalador de distribución, Intel y otras plataformas quedan fuera de esta preparación.

Los scripts originales de build/launch de laboratorio se sustituyen por `scripts/build-macos.py` y `scripts/launch-macos.py`; no se copian sus rutas de SDK, cachés, preferencias de perfil ni fallbacks a experimentos externos. La detección de ejecutables de proveedores en el backend no cambia en este paquete.

## Regresiones de terminal: viewport e interacción

Desde `experiments/tauri-vertical/desktop`:

```sh
npm ci
npm run build
node --test tests/*.test.ts
npx playwright install webkit
npm run test:terminal-browser
```

La suite de navegador usa Chrome instalado (`channel: chrome`) y Playwright WebKit con contextos efímeros. Sirve un fixture local vía Vite: xterm 5.5 real, CSS de producto y helpers de teclado/viewport; no abre proveedores, runner ni perfiles Jauria. Primero reproduce la rueda inerte: parsear salida con host desconectado, volver a adjuntar sin cambio de tamaño, `scrollTop=0` aunque `viewportY>0`. Después valida rueda arriba/abajo, movimiento de host, ancla de lectura al ajustar filas/columnas, salida mientras se lee y seguimiento al fondo. La rueda en pantalla alternativa conserva las secuencias de xterm. El marcador de ancla usa la API propuesta de xterm fijada a 5.5; se crea y elimina dentro de cada ajuste síncrono.

La medición de escritura/pegado compara un backend de eco simulado con espera fija de 150 ms frente a `InteractivePoll`. Mide planificación del frontend hasta callback de parseo xterm, no latencia nativa IPC/PTY ni presentación de un frame en WKWebView. No hay eco local en producto. El primer input se entrega sin debounce y solo se agrupa el backlog mientras un RPC anterior sigue en vuelo; cada frame conserva el límite de 16 KiB, orden y suspensión sin reintento tras fallo.

Para la comprobación nativa, el coordinador puede compilar el commit revisado y abrir otra instancia con un directorio creado por `mktemp -d` y las variables `AW_VERTICAL_HOME=<directorio absoluto nuevo>` y `AW_VERTICAL_SMOKE=1`. No reutilizar el perfil de una instancia con proveedores activos. Usar Información → Fixtures de prueba → Crear 2 fixtures, menú de sesión → Carga; pasar a una sola vista y alternar sesiones para provocar desconexión/adjunción del host. Con salida inactiva o leyendo filas anteriores, probar rueda arriba/abajo en el centro, selección de otra sesión y vuelta, Dividir, cambiar ancho/alto y abrir/cerrar Información. La línea lógica leída debe conservarse mientras siga retenida; la salida nueva no debe llevar al fondo. Para eco de escritura usar una shell desechable del mismo perfil, nunca sesiones Claude/Codex reales. La verificación nativa WKWebView y su medición de eco quedan separadas de los resultados de Playwright.
