# Desarrollo y validación

La raíz contiene documentación curada y scripts portables. La aplicación permanece en `experiments/tauri-vertical/desktop`; el proceso runner en `experiments/tauri-vertical/runner`. Los imports compartidos `#[path]` dependen de esta disposición.

```sh
python3 scripts/build-macos.py --check-only
python3 scripts/build-macos.py
```

El primer comando realiza frontend y tests del runner y del bridge nativo sin generar el bundle Tauri. Ambos ejecutan los tests Rust del runner y las suites `rpc`, `storage_retention`, `terminal_stream_rpc`, `app_settings`, `session_preferences_rpc`, `pulso_rpc`, `native_resume_rpc`, `legacy_profile_rpc` y los benchmarks opt-in `listener_latency`/`pulso_latency` (ignorados por defecto), además de `cargo test --locked` en `desktop/src-tauri` para el bridge nativo. Los tests existentes crean fixtures temporales y procesos de prueba; no necesitan login de proveedores. No se incluyen los harnesses locales de pruebas con proveedores ni los registros originales.

El fixture `runner/tests/fixtures/protocol.synthetic.jsonl` contiene exclusivamente mensajes construidos para pruebas: dos solicitudes de aprobación, 24 fragmentos de mensaje y tres terminaciones de turno. La prueba `replay_synthetic_protocol_offline` conserva las aserciones del replay: dos denegaciones, tres terminaciones y más de veinte eventos normalizados. No es una transcripción nativa ni demuestra comportamiento real del proveedor.

El workflow `.github/workflows/macos.yml` configura Node 24 para ejecutar los tests TypeScript con el soporte nativo de borrado de tipos; no implica que los tests locales se hayan ejecutado en Node 24. Usa Rust estable, macOS Apple Silicon, permisos de repositorio de solo lectura y acciones fijadas a SHA. No instala CLI de proveedores, no realiza login, no firma, no publica ni sube perfiles o evidencia. Referencia del runner: https://docs.github.com/en/actions/reference/runners/github-hosted-runners .

Los resultados deben verificarse sobre el snapshot final: una compilación anterior al freeze no valida cambios posteriores. El DMG se genera y verifica con `scripts/package-macos.py`; su publicación en GitHub es un paso explícito posterior. La release v1.3.2 adjunta un DMG sin firma Developer ID ni notarización. Esas verificaciones, Intel y otras plataformas quedan pendientes.

`scripts/build-macos.py` añade `--remap-path-prefix` a las compilaciones Rust para que los lugares de pánico no incluyan la carpeta personal del compilador. Conserva los flags Rust existentes. El empaquetador inspecciona el bundle y rechaza rutas absolutas `/Users/<cuenta>/` antes de crear el DMG; no elimina el contenido por sí solo. Si aparece ese error, reconstruye con el script de build y revisa el recurso que lo causó.

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


La paleta de comandos tiene su propia suite en `tests/browser/command-palette.test.ts` (Chrome y WebKit, dentro del mismo glob): abre la paleta con `⌘⇧P` desde un terminal enfocado y comprueba que ninguna tecla ni el atajo llegan al PTY, que el rectángulo de `.terminal-host` y el número de `resize` no cambian, la selección de sesiones, la confirmación de Terminar, las acciones deshabilitadas, que no se abre sobre un diálogo modal y la guarda del borrador de Pulso. Con `PALETTE_SCREENSHOT_DIR=/ruta/absoluta` guarda además capturas sintéticas claras y oscuras. La lógica pura (búsqueda, orden, registro de atajos y disponibilidad) está en `tests/command-palette.test.ts`.

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

## Perfiles con Repositorios retirados

Desde 1.4 no existen Repositorios ni tareas Git. El runner ya no expone `register_project`, `create_task`, `prepare_task`, `start_task`, `start_codex_task`, revisión, verificación ni relevo (responde `unknown operation`), y `status` deja de anunciar `workspaceVersion`, `workflowVersion`, `verificationVersion`, `handoffVersion`, `recoveryVersion` y `projectLifecycleVersion` y de enviar `projects`/`tasks`. `status` sigue aceptando, e ignorando, `workspaceAfter` de una interfaz 1.3.x.

El esquema SQLite no cambia (`user_version` 5). `runner/src/legacy_tasks.rs` crea y valida las tablas antiguas con el mismo texto SQL que 1.3.x, sin recuperación ni limpieza: los datos de un perfil anterior se conservan tal cual y nada los lee. Un perfil creado o migrado por 1.4 sigue abriéndose con un runner 1.3.x. Los worktrees y ramas del usuario no se tocan; sus carpetas se pueden abrir como sesión normal con la regla de un escritor por worktree. Las reservas antiguas de relevo ya no bloquean sesiones: solo reservaban el identificador de la sesión que iba a abrir el relevo, no una carpeta ni una plaza, y los identificadores nuevos son aleatorios. Una sesión de relevo que llegó a abrirse es una fila normal de `sessions` y sigue cubierta por la regla de un escritor.

Una verificación de 1.3.x sin terminar (cualquier estado salvo `prepared`, `completed`, `not_executed`, `cancelled`, `released` o `purged`) sigue protegiendo su carpeta, la de su tarea, sus ancestros y sus descendientes, pero solo mientras su comando siga vivo (`legacy_tasks::ensure_no_live_verification`, llamada al admitir `start`, `start_codex`, `resume_native` y `codex_resume`). La fila no guarda el PID: solo argv, carpeta aprobada (`cwd`, `cwdDev`, `cwdIno`) y `createdAt`. El comando se lanzaba con `setsid`, así que se reconoce un proceso vivo del mismo usuario que lidera su propia sesión, arrancó a partir de `createdAt` y ejecuta exactamente ese argv (`process_custody::live_session_leader`, vía `KERN_PROCARGS2`). Un PID reutilizado o un shell cualquiera no coinciden. Mientras exista, el arranque responde «Un proceso de verificación de una versión anterior sigue activo en esta carpeta (pid N). Termínalo y vuelve a intentar.»; cuando termina, se admite y la fila no se modifica. Límite: no se reconocen descendientes que sobrevivan al comando principal en otro grupo; 1.3.x bloqueaba la carpeta hasta una liberación manual que ya no existe en la interfaz.

La migración v4→v5 mantiene la anotación `legacy_pre_handoff` de los registros purgados para que un 1.3.x posterior siga distinguiéndolos.

Combinaciones durante una actualización:

| Interfaz | Runner | Resultado |
| --- | --- | --- |
| 1.4 | 1.3.x vivo | Sesiones, Pulso, MCP, permisos e historial funcionan. La interfaz ignora `projects`/`tasks`; no ofrece Repositorios. No aparece el aviso de runner anterior por las capacidades retiradas. |
| 1.3.x | 1.4 | Conecta (`workspaceAfter` aceptado). Oculta Repositorios porque falta `workspaceVersion`, y Diagnóstico muestra «runner anterior» porque faltan las capacidades retiradas; es un aviso de más, no un fallo. Una operación de tareas devuelve `unknown operation`. |
| 1.4 | 1.4 | Sin Repositorios; perfil antiguo legible. |

`cargo test --locked --test legacy_profile_rpc` reproduce un perfil sintético con proyectos, tareas, revisión, relevo, una verificación sin terminar y una sesión de tarea; comprueba arranque, sesiones, Pulso, las operaciones retiradas, que la verificación bloquea mientras su comando sintético vive y deja de bloquear al terminar, y que las filas antiguas no cambian. Límite: crea el esquema con el runner nuevo e inserta las filas antiguas a mano; no ejecuta un runner 1.3.x. La prueba unitaria `legacy_verification_blocks_writers_only_while_its_command_lives` cubre los arranques Codex, Claude, Terminal y Codex estructurado, ancestros, descendientes, identidad distinta y proceso terminado.

Vuelta atrás comprobada a mano con el runner de 9c646ec (1.3.3 de la rama): un perfil vacío creado por 1.4 abre en 1.3.x, que anuncia `workspaceVersion: 1` con listas vacías, y vuelve a abrir en 1.4. No se probó la vuelta atrás con filas antiguas: al abrir, el inicializador 1.3.x sí modifica esas filas (tareas `preparing` → `needs_attention` con una entrada de auditoría; verificaciones `prepared` → `cancelled` y `running`/`cancel_requested` → `needs_attention`), y su cerco bloquea la carpeta hasta liberarla desde su interfaz.

`diagnostic_preview` conserva su formato: sus campos de conteo de `projects` y `tasks` son conteos de solo lectura de los datos antiguos conservados.

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
PULSO_PANEL_BROWSER=1 PULSO_PANEL_WEBKIT=1 node --test tests/browser/pulso-workbench.test.ts
PULSO_PANEL_BROWSER=1 PULSO_PANEL_WEBKIT=1 node --test tests/browser/pulso-revision.test.ts
```

`pulso-revision.test.ts` alterna en el arnés las capacidades `pulsoRevisionVersion`, `pulsoSummaryVersion` y `pulsoBoardCardsVersion`: con ellas cuenta las lecturas de Pulso por ciclo de `status` (cero sin cambios, una relectura por revisión nueva, ninguna con el documento oculto), comprueba el pie de tarjeta y las fases de la paleta; sin ellas, que se conserva el comportamiento 1.3.x. `PULSO_E_SCREENSHOT_DIR=/ruta/absoluta` guarda capturas sintéticas claras y oscuras.

Los fixtures simulan solo la frontera nativa, sin datos personales ni proveedor. Cubren borradores, conflictos, reintentos, permisos, paginación y recuperación. La shell completa conserva xterm y posición de lectura. Para evitar recargas de Vite durante una regresión de terminal, no edites fuentes ni ejecutes varios servidores de estas suites sobre la misma caché al mismo tiempo.

Desde `experiments/tauri-vertical/runner`:

```sh
cargo test --locked --test pulso_rpc --test native_resume_rpc
cargo test --release --locked --test pulso_latency -- --ignored --nocapture
```

El segundo comando mide 2/8 PTY, 500 fases y clientes lentos de Pulso en perfiles temporales. No contacta proveedores ni mide pintura de pantalla. La CLI `--pulso-client` acepta `-` para leer JSON por stdin y evitar poner el texto del plan en argumentos del shell. Consulta [el contrato de uso](PULSO.md) y [los resultados locales de 1.1.0](PULSO_VALIDATION_1.1.0.md).

La versión 1.2.0 añade el tablero y los estados pasivos de programa. Consulta [la revisión de Herdr](HERDR_REVIEW.md) y [la validación de 1.2.0](PULSO_VALIDATION_1.2.0.md).

## Capacidades de `status`

La interfaz decide qué usar según los campos `*Version` de `status`. La app 1.3.x compara los existentes con `=== 1` o `!== 1`, así que **nunca se sube un `*Version` existente**: una capacidad nueva o ampliada lleva un campo nuevo y la respuesta antigua solo gana claves. Un campo que falta significa runner anterior y la interfaz conserva la ruta antigua.

| Campo | Desde | Qué anuncia |
| --- | --- | --- |
| `pulsoRevision`, `pulsoRevisionVersion: 1` | 1.4 | Revisión de Pulso confirmada, leída de memoria tras cada `COMMIT` (UI y MCP). Se inyecta después de la caché de `status`, así que sigue al día con la base de sesiones ocupada. Ausentes si Pulso no está disponible. |
| `pulsoSummaryVersion: 1` | 1.4 | Operación de Pulso `sidebar_summary {ifRevision?}`, solo UI. |
| `pulsoBoardCardsVersion: 1` | 1.4 | Tarjetas de `board` con `session` y `checkpointCount`. `pulsoBoardVersion` sigue en 1. |
| `agentAttentionVersion: 1`, `agentAttention` | 1.4 | Estado declarado y avisos del runner: `agent` por sesión en `status` y `terminal_live`, y la operación `mark_seen`. Se inyecta desde memoria después de la caché de `status`. Ver [Atención de agentes en el runner](#atención-de-agentes-en-el-runner-14-e). |

Las pruebas de `pulso_store.rs` comprueban con `EXPLAIN QUERY PLAN` que `sidebar_summary` y el pie de tarjeta usan los índices existentes. Dos mediciones son opt-in, sobre bases en memoria sintéticas, desde `experiments/tauri-vertical/runner`:

```sh
cargo test --release --locked --bin aw-runner pulso_summary_scale -- --ignored --nocapture
cargo test --release --locked --bin aw-runner pulso_board_cards_scale -- --ignored --nocapture
```

## Atención de agentes en el runner (1.4 E)

El comportamiento y sus límites están en [SESSION_ALERTS.md](SESSION_ALERTS.md#estado-y-vistos-en-el-runner-14-e). Contrato para la interfaz:

- `status.sessions[i].agent` (solo sesiones con registro: primero las que tienen avisos pendientes, después las vivas o con estado; como mucho 256) y `terminal_live.agent` (la sesión pedida, o `null`): `state` (`working|blocked|error|done|idle|null`), `changedAt`, `stateFrame`, `turnOpen`, `turnStartedAt`, `turnEndedAt`, `lastTurnMs`, `turnInterrupted`, `alertSeq`, `seenSeq`, `finishedUnseen` y `pending`, un objeto con una entrada por tipo pendiente (`needs`, `finished`, `bell`, `notify`: `{seq, frame}`; `ended`: `{seq}`; `permission`: `{seq, requestId, generation}`). Las horas son milisegundos Unix del reloj del runner; las duraciones, monotónicas. `frame` y `stateFrame` son índices de frame del `terminalStream` de la generación actual del runner, o `null`.
- `status.agentAttention`: `{hasMore, pendingSessions, pendingAlerts, durable, maxAgents}`. Con `hasMore` la lista de `agent` no está completa; los totales cuentan todas las sesiones.
- `mark_seen {items:[{id, through}]}` (1 a 64; `through` entero no negativo) responde `{items:[{id, agent|null}], durable}`. Sube `seenSeq` a `max(seenSeq, min(through, alertSeq))`, sin cerrojo de mutaciones ni custodia; no responde permisos.
- Reglas del cliente: `through` es el `alertSeq` que pintó, nunca uno leído después; solo vale dentro de la misma `generation` de `status`. Un aviso con `frame` se marca visto de forma automática solo cuando la interfaz ya consumió ese frame de `terminal_live` y no está en replay; con `frame: null` (otra generación o aviso sin frame, como `permission` y `ended`) solo por una acción explícita de la persona o al abrir la sesión.

Pruebas, desde `experiments/tauri-vertical/runner` (perfiles, sockets y HOME temporales; solo sesiones `shell` sintéticas):

```sh
cargo test --locked --bin aw-runner agent_
cargo test --locked --test agent_attention_rpc
cargo test --release --locked --test agent_attention_rpc burst -- --ignored --nocapture
```

La tercera mide una ráfaga de 50 MiB con `resize` concurrente; con `AGENT_BASELINE_RUNNER=/ruta/absoluta/aw-runner` compara con otro binario (`AGENT_BASELINE_LAST=1` invierte el orden; `AGENT_BENCH_NO_RESIZE=1` mide solo el drenaje). Los vectores del parser son `desktop/tests/fixtures/program-status-vectors.json`, compartidos con las pruebas del cliente.

### Vuelta atrás a la versión anterior (paso de la lista de release)

Antes de publicar una versión que añada tablas a `runner.sqlite`, comprueba que el runner de la release anterior abre el perfil. Con 1.3.3:

```sh
S=$(mktemp -d)   # o el scratchpad de la sesión
mkdir -p "$S/src"
git archive v1.3.3 experiments/tauri-vertical/runner | tar -x -C "$S/src"
(cd "$S/src/experiments/tauri-vertical/runner" && CARGO_TARGET_DIR="$S/target" cargo build --locked)
JAURIA_PREVIOUS_RUNNER="$S/target/debug/aw-runner" \
  cargo test --locked --test agent_attention_rpc rollback -- --ignored --nocapture
```

El runner se lanza siempre con `--data-dir`, `--socket` y `--token-file` explícitos dentro de un directorio temporal y con `HOME` propio; no tiene valores por defecto, así que nunca toca el perfil real ni el runner vivo. La prueba crea filas de `agent_attention` con el runner nuevo, abre el mismo perfil con el anterior, ejecuta allí `purge_history` y `compact_history` sobre una sesión final, y lo reabre con el nuevo: las filas quedan idénticas, `user_version` sigue en 5 y hay exactamente cinco triggers sobre `sessions`/`events`. Se ejecutó con éxito el 23 de noviembre de 2026 contra v1.3.3 (commit `b296f6e`).

