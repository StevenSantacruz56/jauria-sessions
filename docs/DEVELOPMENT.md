# Desarrollo y validación

La raíz contiene documentación curada y scripts portables. La aplicación permanece en `experiments/tauri-vertical/desktop`; el proceso runner en `experiments/tauri-vertical/runner`. Los imports compartidos `#[path]` dependen de esta disposición.

```sh
python3 scripts/build-macos.py --check-only
python3 scripts/build-macos.py
```

El primer comando realiza frontend y tests del runner y del bridge nativo sin generar el bundle Tauri. Ambos ejecutan los tests Rust del runner y las suites `rpc`, `storage_retention`, `terminal_stream_rpc`, `app_settings`, `session_preferences_rpc`, `pulso_rpc`, `native_resume_rpc` y los benchmarks opt-in `listener_latency`/`pulso_latency` (ignorados por defecto), además de `cargo test --locked` en `desktop/src-tauri` para el bridge nativo. Los tests existentes crean fixtures temporales y procesos de prueba; no necesitan login de proveedores. No se incluyen los harnesses locales de pruebas con proveedores ni los registros originales.

El fixture `runner/tests/fixtures/protocol.synthetic.jsonl` contiene exclusivamente mensajes construidos para pruebas: dos solicitudes de aprobación, 24 fragmentos de mensaje y tres terminaciones de turno. La prueba `replay_synthetic_protocol_offline` conserva las aserciones del replay: dos denegaciones, tres terminaciones y más de veinte eventos normalizados. No es una transcripción nativa ni demuestra comportamiento real del proveedor.

El workflow `.github/workflows/macos.yml` configura Node 24 para ejecutar los tests TypeScript con el soporte nativo de borrado de tipos; no implica que los tests locales se hayan ejecutado en Node 24. Usa Rust estable, macOS Apple Silicon, permisos de repositorio de solo lectura y acciones fijadas a SHA. No instala CLI de proveedores, no realiza login, no firma, no publica ni sube perfiles o evidencia. Referencia del runner: https://docs.github.com/en/actions/reference/runners/github-hosted-runners .

Los resultados deben verificarse sobre el snapshot final: una compilación anterior al freeze no valida cambios posteriores. El DMG local se genera y verifica con `scripts/package-macos.py`; no se publica automáticamente. La firma Developer ID, la notarización, la distribución del instalador en GitHub, Intel y otras plataformas quedan pendientes.

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


## Historial y continuidad de las terminales

Las sesiones PTY nativas publican frames ordenados en memoria antes de intentar archivarlos. `terminalStreamVersion: 1` identifica el protocolo `terminal_live`; cada sesión conserva una generación y un índice de frame. Los bloques de archivo usan eventos `provider` etiquetados `jauria/terminalFrames` dentro del esquema existente. El `seq` global sigue sirviendo para paginar el historial; la interfaz deduplica archivo y vivo por generación e índice. Las conversaciones estructuradas mantienen su ledger y sus requisitos de persistencia antes del envío.

El lector del PTY no espera a SQLite. Un escritor independiente agrupa hasta 64 KiB de salida cruda o 250 ms y respeta barreras de geometría y estado. La salida en vivo no espera a ese temporizador. Los bloqueos transitorios de SQLite se reintentan durante un plazo acotado; no se convierten de inmediato en pérdida global. Los cambios de tamaño se conservan en los frames y solo actualizan el checkpoint de metadatos al cambiar el ciclo de vida, evitando una fila exenta por cada ajuste de ventana. El presupuesto contable del ring es 4 MiB por sesión y 8 MiB global; el de archivo pendiente es 8 MiB por sesión y 16 MiB global, incluyendo el bloque en vuelo. También se limitan los números de frames. Estos presupuestos no son una medición ni un límite exacto del RSS del proceso: estructuras, metadatos y buffers de serialización añaden memoria. La cola permite conservar la regresión existente de dos ráfagas simultáneas de 5 MiB; saturaciones mayores se declaran explícitamente.

La cuota de archivo por sesión es de 32 MiB codificados, además de las cuotas globales existentes. Al agotarlas, o al fallar una escritura, el proceso y sus controles permanecen activos. El estado del proceso y la integridad del historial se muestran por separado. Las acciones que requieren estado durable reconcilian primero las terminaciones observadas; las revisiones impiden que un checkpoint atrasado restablezca un estado antiguo. `complete` requiere un cierre y un checkpoint final durables; una sesión activa está `recording`, y una cola aún pendiente no es un archivo completo. Un fallo de E/S puede impedir guardar incluso el marcador de pérdida: el estado actual sigue disponible en memoria, y un reinicio conserva la incertidumbre del tramo final.

Los registros finales con checkpoint durable pueden salir de la caché de memoria; siguen disponibles mediante su archivo, y esa transición no interrumpe la conexión.

Un consumidor lento puede perder frames del ring. Si los frames siguen pendientes de archivo o están guardados, la interfaz espera la recuperación desde el archivo y suspende entrada y respuestas automáticas durante esa recuperación. Si el tramo ya no se puede recuperar, la respuesta indica el hueco; la interfaz reinicia su parser y mantiene un aviso de vista desincronizada. Esto no reconstruye el estado completo de una TUI. La aplicación no inyecta comandos, redibujados ni reinicios del proveedor. La reconstrucción exacta exige una secuencia completa; checkpoints completos de pantalla quedan fuera de esta versión.

La admisión nativa requiere metadatos durables y reserva de ciclo de vida, aunque la cuota de salida esté llena. Una base que no permite la inserción inicial sigue bloqueando nuevas sesiones. La purga permanece explícita y limitada a sesiones finales: espera a que no haya bloques de archivo en vuelo, sella temporalmente los checkpoints, registra la pérdida de forma atómica con la eliminación, elimina también la copia del ring y permite archivar sesiones nuevas si vuelve a haber capacidad. Las sesiones cuyo archivo ya quedó incompleto conservan esa condición. Tras una caída no se recupera autoridad sobre PIDs persistidos ni se reenvían instrucciones.

Validación adicional:

```sh
# Cuotas, errores de escritura y continuidad con PTYs reales de prueba
cargo test --locked --test terminal_stream_rpc
# Integración de archivo/vivo con xterm en Chrome instalado
TERMINAL_STREAM_BROWSER=1 node --test tests/terminal-stream.test.ts
```

El primer comando se ejecuta desde `experiments/tauri-vertical/runner` y el segundo desde `experiments/tauri-vertical/desktop`. Ambos usan fixtures temporales y no abren proveedores. Los tests unitarios del módulo de stream cubren además límites por bytes y frames, cola en vuelo, pérdida de rangos, orden, finalización y fallos de almacenamiento.

## Integración de avisos y Configuración

Las siguientes suites son opt-in; el glob de Node no las ejecuta en CI sin navegador instalado. Desde `experiments/tauri-vertical/desktop`:

```sh
SETTINGS_PANEL_BROWSER=1 node --test tests/settings-panel.test.ts
ATTENTION_CONSISTENCY_BROWSER=1 node --test tests/attention-consistency.test.ts
ATTENTION_CONSISTENCY_BROWSER=1 ENGINE=webkit node --test tests/attention-consistency.test.ts
TERMINAL_STREAM_BROWSER=1 TERMINAL_STREAM_ENGINE=webkit node --test tests/terminal-stream.test.ts
```

Configuración usa Chrome y WebKit en una misma ejecución; las otras suites seleccionan un motor por ejecución. Comprueban apertura y cierre de diálogos, guardado explícito, compatibilidad con un runner anterior, renombrado desde el menú real, separación de abiertas e historial, avisos detrás de un diálogo y coherencia del Dock. La suite de streams incluye backfill durante escritura sin duplicar salida ni enviar respuestas de terminal históricas.

`JAURIA_TEST_RUNNER=/ruta/absoluta/Jauria.app/Contents/Resources/bin/aw-runner` permite ejecutar `session_preferences_rpc` y `terminal_stream_rpc` contra el runner empaquetado, desde la carpeta del runner. Estas pruebas siguen creando perfiles desechables. Consulta [la validación de 1.0.1](RELEASE_1.0.1.md) y [la entrega original 1.0.0](RELEASE_1.0.0.md).

## Preferencias y nombres de sesión

`get_settings` consulta la capacidad del perfil y `set_settings` guarda `maxConcurrentSessions` entre 1 y 8. Las admisiones y el guardado se serializan con el mismo bloqueo de mutaciones; reducir el límite no detiene procesos. El valor predeterminado sigue siendo 2. `settingsVersion: 1` y `sessionRenameVersion: 1` anuncian estas capacidades. Una interfaz nueva conserva el límite antiguo hasta actualizar el runner.

`rename_session` guarda únicamente el título local y su evento de metadatos en una transacción. Admite sesiones activas y finalizadas, incluso sin cuota para más salida. No cambia el identificador ni renombra conversaciones del proveedor. Los títulos se validan como texto y se presentan sin interpretación HTML.

## Latencia de entrada

El listener del runner espera legibilidad del socket con `poll`, en vez de agregar una espera fija a cada nueva conexión RPC. La interfaz consulta primero las terminales visibles; durante escritura nativa sincronizada espacía las lecturas del archivo a 150 ms. Replay, gaps, páginas pendientes y proveedores dependientes del archivo mantienen lectura inmediata. La entrada no añade eco local.

El benchmark opt-in `runner/tests/listener_latency.rs` usa dos PTYs desechables y exige la respuesta del proceso hijo, distinguiéndola del eco de comandos del kernel. Ejecuta `cargo test --locked --test listener_latency -- --ignored --nocapture` en el runner; `LISTENER_BASELINE_RUNNER` permite comparar con un ejecutable anterior de ruta absoluta. No utiliza perfiles reales ni impone umbrales de tiempo frágiles en CI. Las mediciones del runner no equivalen a latencia de renderizado WKWebView.

La compilación de escritorio usa ahora `release` de forma predeterminada. `--debug` conserva una compilación de desarrollo y debe pasarse también al launcher. El DMG se empaqueta aparte con `scripts/package-macos.py` para distinguir la distribución verificada de un artefacto local sin firma.

## Licencias y revisión antes de publicación

El código propio usa GPL-3.0-only en LICENSE y en los metadatos npm/Cargo. Las licencias de fuentes, bibliotecas y los derechos de marca se conservan por separado en NOTICE. No asignes GPL a archivos originales de terceros ni modifiques sus avisos para normalizar metadatos.

El bundle copia LICENSE y NOTICE a `Contents/Resources/licenses`. El empaquetador DMG exige LICENSE y agrega `SOURCE_REFERENCE.txt` con la versión exacta. Verifica tanto los avisos como la disponibilidad efectiva del código correspondiente antes de redistribuir un binario.

La revisión de exposición usa Gitleaks con redacción completa sobre historial, commits y etiquetas. No registra valores secretos ni pretende sustituir una auditoría completa. El alcance y las comprobaciones de GitHub Actions/assets se documentan en [PUBLICATION_READINESS.md](PUBLICATION_READINESS.md).

## Pulso: planificación y continuidad

Desde `experiments/tauri-vertical/desktop`, con Chrome y Playwright WebKit instalados:

```sh
PULSO_PANEL_BROWSER=1 PULSO_PANEL_WEBKIT=1 node --test tests/pulso-panel.test.ts
node --test tests/browser/pulso-workbench.test.ts
```

Los fixtures simulan solo la frontera nativa, sin datos personales ni proveedor. Cubren borradores, conflictos, reintentos, permisos, paginación y recuperación. La shell completa conserva xterm y posición de lectura. Para evitar recargas de Vite durante una regresión de terminal, no edites fuentes ni ejecutes varios servidores de estas suites sobre la misma caché al mismo tiempo.

Desde `experiments/tauri-vertical/runner`:

```sh
cargo test --locked --test pulso_rpc --test native_resume_rpc
cargo test --release --locked --test pulso_latency -- --ignored --nocapture
```

El segundo comando mide 2/8 PTY, 500 fases y clientes lentos de Pulso en perfiles temporales. No contacta proveedores ni mide pintura de pantalla. La CLI `--pulso-client` acepta `-` para leer JSON por stdin y evitar poner el texto del plan en argumentos del shell. Consulta [el contrato de uso](PULSO.md) y [los resultados locales de 1.1.0](PULSO_VALIDATION_1.1.0.md).
