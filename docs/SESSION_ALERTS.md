# Session alerts MVP

Implemented in `feat/session-alerts`, based on `849245c`. This is a development change, not audit evidence or real-provider acceptance. No real provider, user profile, system settings, push, or staging worktree was used.

## Behavior

- The header **Avisos** button is global, including when the sidebar is hidden or a task is open. It opens the session list with the alert filter and clears search. A row opens its session. The banner only offers navigation and marking seen; permissions still require the existing contextual native confirmation.
- Claude/Codex PTY sessions report **La sesión emitió una alerta** and **El proceso terminó**. Raw output never counts as attention: spinner, progress and cursor redraws must not generate banners, unread counts, Dock badges or native notices. No terminal-text heuristics are used. BEL and OSC 9 notifications / OSC 777 `notify;` use the installed xterm public parser. OSC 9 numeric subprotocols (including progress) are ignored. Replay cannot emit activity alerts. Live-to-exited/stopped/failed process transitions are deduplicated independently of status/event delivery order.
- Explicit protocol signals are collected when the session is not the focused session in a visible, focused app window. Viewing consumes activity. An observed process end can remain until viewed even if the selected session has ended.
- Lifecycle incidents retain existing attention-filter coverage: failed, interrupted, unknown and `needs_attention`. The latter means custody/recovery uncertainty, never a permission wait. A confirmed runner lifecycle change clears or replaces that cause; marking seen does not release custody, stop a process, or resolve it.
- Relevant structured app-server sessions are queried independently of pane visibility, filters and task screen. Two workers maximum, one collection at a time, every three seconds. Finished history without known pending permissions is skipped. Collection is detached from terminal/status polling; completion refreshes the UI. Reconnect/version and session-generation guards discard obsolete reads.
- `pendingRequestCount` handles bounded/truncated summaries. Request identity includes generation and request ID. Read errors retain last known data as **sin confirmar**. Prior-generation requests are **caducado**, not resolved. Stale/expired observations do not add to the confirmed header number (`+ ?` indicates uncertainty), and never generate native notices.
- Initial lifecycle and first successful permission snapshots per generation are quiet: listed, without a new-alert banner or native notice. Later changes are unseen. Seen permission/custody causes remain listed until the source changes. Repeated unchanged snapshots do not re-alert. Seen state and activity are window-local; they are not persisted across app launches. *(Historical: MVP behavior. Since 1.4 E the runner keeps declared state and seen sequences; see [Estado y vistos en el runner (1.4 E)](#estado-y-vistos-en-el-runner-14-e).)*

## Native notifications

Actual `tauri-plugin-notification` 2.8.1, pinned for Rust and JavaScript. The local `main` window has only `allow-is-permission-granted`, `allow-request-permission`, and `allow-notify`; no remote origins or broad default notification capability. The Rust builder initializes the plugin; the frontend calls its official API, not an unconfigured WebKit Notification implementation.

**Información → Activar avisos de macOS…** opts in for this app opening. Default off on every launch. Only this click can call the permission request API. No startup/background permission requests or OS settings changes. Existing alerts at activation are excluded. New unseen, non-stale background alerts are grouped over 1.5 seconds and deduplicated. Acknowledgement, focus, disconnect, disabling, or window disposal can suppress a queued notice. The notice has fixed generic copy: no session titles, paths, terminal content, request details, or session deep link.

Delivery is best effort, only while Jauría is open. No sound, critical alert, scheduled delivery or click-to-session action is implemented. Importantly, the plugin's desktop `permission_state` / `request_permission` implementation always returns `Granted`; it does not prove macOS notification settings or delivery. `sendNotification` returns void, with no delivery receipt. The settings copy states these limits. No actual OS notification or permission prompt was exercised for this change.

Primary references: [Tauri notification setup and permissions](https://v2.tauri.app/plugin/notification/), [official JavaScript notification API](https://v2.tauri.app/reference/javascript/notification/). The pinned plugin's `src/desktop.rs` documents unconditional desktop permission reporting; its `dist-js/index.js` exposes the notification API through the plugin-installed implementation.

## Validation

From `experiments/tauri-vertical/desktop`:

```sh
npm ci
npm run build
node --test tests/*.test.ts
```

41 tests passed, including seven attention-model tests, two native scheduling tests and one real installed-xterm public-parser test. These cover initial quiet state, raw-progress suppression and explicit alerts after baseline, coalescing/consumption, process-end deduplication, all relevant hidden sessions, truncated counts, concurrency limit, finished-history exclusion, stale reads, generation identity, reconnect fences, opt-in/backlog suppression, focus/acknowledgement cancellation and disposal.

The runner release was built solely to provide the configured Tauri bundle resource, then `cargo test --locked` in `desktop/src-tauri` passed all 35 bridge tests. Notification plugin, capability identifiers and frontend compile successfully; this is not a packaged native delivery test.

For the synthetic Chromium integration harness, run Vite on port 5189, then from repository root:

```sh
JAURIA_PLAYWRIGHT_MODULE=/path/to/playwright/index.mjs node experiments/tauri-vertical/desktop/tests/attention-browser.mjs
```

The harness uses an isolated browser context and a synthetic Tauri RPC adapter; no runner/profile/provider or native permission API. It checks raw PTY progress suppression and explicit BEL, navigation, consumption, hidden structured permission deltas, seen versus resolved, quiet historical replay, and no horizontal page overflow at the minimum supported width. Screenshots are local ignored evidence in `.impeccable/review/desktop.png` and `minimum-window.png`; the fixture intentionally includes three synthetic sessions to exercise cross-session collection, not production capacity acceptance.

## Review and integration

Claude's independent design review was read from the parent-provided `alerts-design-review-result.json`. Incorporated: explicit PTY notifications, source uncertainty, generation expiry, quiet baselines, seen versus resolved, navigation-only permission handling, generic opt-in notifications and truthful delivery limits. Its proposal for a new “accept current custody” mutation was deferred: existing backend custody/recovery transitions remain authoritative. No invented permission or turn-completion heuristics, provider hooks or user configuration changes.

Impeccable context ran once. Existing brand, tokens, typography and workbench composition were retained. Two visual inspection rounds covered 1220×800 and 760×640. The detector reported only two pre-existing Inter font warnings; preserved per the explicit brand requirement. With no finish-review subagent available, the inline degraded review found the added banner, navigation, wrapping reasons and seen styling consistent with the incumbent surface (ship at that visual scope). This does not claim an independent implementation review. Claude's design review is not code approval; independent code/native-delivery review remains pending with the integrating parent.

`src/main.ts` will conflict with the scroll worker. Preserve its bounded redraw optimization: these changes add no refresh to individual output/BEL callbacks. They only record coalesced observations, surfaced by status polling and attention collection completion. Keep the detached bounded collector and version/generation checks when integrating. No scroll-worker or audited-staging files were edited.

PTY permission detection and semantic turn completion remain unavailable. Hooks are not installed or configured. Alerts while the UI is closed require future runner-side infrastructure. *(Historical: 1.4 E adds that runner-side ledger; see the section at the end.)* Native macOS delivery, Focus mode behavior and signed/installed bundle behavior need explicit user-driven runtime validation.

## Terminal geometry regression

Until delivery 1.4 A, notification and connection messages shared an always-present 50 px rail. Since 1.4 B there is no rail: see «Avisos sin barra fija (1.4 B)» below. Showing, consuming, dismissing or replacing a message still does not change terminal rows or columns. This matters for native Codex: changing the PTY geometry sends SIGWINCH, causing a redraw that can jump away from the reading position. The native focus regression was reproduced with the old layout (31 → 34 rows) and checked after the fix (121 × 31 throughout; zero resize events; same runner and PTY process).

`node --test tests/browser/notification-geometry.test.ts` checks host bounds, real xterm dimensions, every rendered frame and native resize-request counts in Chrome/WebKit at 1220 × 800 and 760 × 640. The old source at `5431021` failed all four cases of the original version; the 1.4 B rewrite is described below. The browser suite runs files serially: simultaneous browser-heavy fixtures made the older detached-viewport baseline timing-dependent. This test evidence is separate from security-audit reproductions.

## Activity is not an unread alert

Raw PTY output, including progress redraws, never enters the attention ledger. The legacy output signal is explicitly ignored at the model boundary as well as omitted from the renderer callback. BEL, supported OSC notifications, process termination, observed lifecycle incidents and structured pending permissions keep their existing semantics. The global header distinguishes new alerts from already-seen pending causes; seeing a pending permission does not approve or resolve it.

## Actividad y avisos desde 1.3.1

Esta sección describe el comportamiento actual. Los apartados anteriores documentan el MVP histórico y sus cifras de prueba, no la nueva versión.

- **Actividad** siempre está disponible en la barra lateral. Ordena las sesiones observadas por acción requerida, avisos explícitos, turnos o procesos terminados, trabajo declarado, espera y progreso no informado. Desde la entrega 1.4 A es la agrupación **Por estado** de la sección Agentes (dentro de **Abiertas**); **Por proyecto** es la predeterminada y ordena cada grupo con la misma prioridad. Solo un reporte `working` muestra el anillo giratorio.
- `running` describe un proceso abierto, no trabajo activo. Solo OSC 7501 raíz `working` se muestra como **Trabajando**, con tiempo observado en esta ventana *(histórico: con un runner que anuncia `agentAttentionVersion` el tiempo sale de `turnStartedAt` del runner; ver 1.4 E)*. Sin reporte, la sesión queda **Abierta · progreso no informado**. Los reportes de hijos, preguntas y campos de texto siguen ignorados; no se inspecciona salida cruda ni se infiere un porcentaje.
- `blocked/error` constituye una causa persistente mientras el programa lo declara. `working → done/idle` produce un fin no visto que persiste si después llega `idle`; abrir la sesión lo marca visto. Un reporte nuevo de `working` borra ese fin pendiente. Ver la sesión no responde permisos ni repara un fallo. El estado reportado y el visto se pierden al reconectar o cerrar la interfaz *(histórico: desde 1.4 E el runner conserva ambos; esta frase describe la interfaz sin esa capacidad)*.
- Desde 1.4 B no hay barra de avisos: la causa prioritaria aparece en la etiqueta de estado de la cabecera del panel, en la campana de la barra superior (con su lista emergente) y en la barra de estado. **Abrir sesión** y **Marcar vistos** están en esa lista; ninguna de las tres superficies cambia la altura del terminal. **Marcar vistos** afecta solo a la presentación; las causas persistentes permanecen hasta que su fuente cambia. La notificación nativa opcional usa una de tres categorías genéricas: atención, actividad finalizada o aviso. Nunca contiene títulos, rutas, salida ni detalles de permisos. Su entrega sigue sin recibo y el clic en macOS no abre automáticamente la sesión.
- La implementación está en `program-status.ts`, `attention.ts`, `session-activity.ts` y `main.ts`. La revisión con Claude y el contraste con Herdr están en [HERDR_REVIEW.md](HERDR_REVIEW.md#actividad-y-avisos-en-131). Las pruebas usan sesiones sintéticas y el xterm real en Chromium/WebKit; no prueban notificaciones del sistema ni proveedores reales.

## Avisos sin barra fija (1.4 B)

La barra de avisos de 50 px se retiró del flujo. El aviso prioritario se muestra en tres sitios de alto fijo y en una lista flotante:

- **Cabecera del panel (32 px).** La etiqueta de estado (indicador y texto, con tinte naranja cuando la sesión te necesita) cambia de contenido, nunca de alto: la cabecera es `nowrap`, recorta y tiene alto mínimo y máximo de 32 px.
- **Campana de la barra superior (42 px).** Muestra el número de avisos nuevos y abre una lista flotante (`#attention-banner`, posición absoluta) con cada sesión, su motivo, «Sin ver»/«Visto» y **Abrir**, más **Ver en la lista** (el filtro de la barra lateral), **Marcar vistos** y **Abrir sesión** (la sesión prioritaria). Escape (desde la lista o desde la propia campana desplegada) o un clic fuera la cierran y el foco vuelve a la campana.
- **Barra de estado (28 px).** «N te necesita(n)» (botón: abre la sesión prioritaria), «N terminó/terminaron» y «N trabajando». «Sin avisos» solo aparece cuando la campana está a cero; un aviso que no cuenta ningún contador se muestra como «N avisos».
- Una región `aria-live="polite"` visualmente oculta anuncia los avisos nuevos sin ver; no repite los que siguen igual.

Los avisos genéricos y los errores de conexión son una notificación flotante en la esquina inferior derecha (máximo 96 px con desplazamiento propio). El selector de sesión, el menú «…» del panel y el contexto de relevo (abierto con «Contexto» en la barra superior) también flotan. Ninguno ocupa espacio del terminal.

`tests/browser/notification-geometry.test.ts` se reescribió para este diseño sin relajar lo que protege: en Chrome y WebKit, a 1220 × 800 y 760 × 640, comprueba el rectángulo de `.terminal-host` en cada fotograma, las columnas y filas reales de xterm y que no haya RPC `resize` adicionales al llegar un aviso explícito (BEL, OSC 9, OSC 777), al consumirlo, al marcarlo visto, con avisos y errores largos a la vez, durante la recuperación del historial, al abrir y cerrar la lista de avisos (clic y Escape), con los estados de programa `working`, `blocked`, `done`, `idle` y `clear` en la cabecera del panel, con el contador de la barra de estado y al abrir, filtrar y cerrar el selector de sesión. También comprueba los altos fijos de la barra superior, la cabecera del panel y la barra de estado, y que las teclas escritas en el buscador del selector no llegan al PTY. Una mutación de control (la notificación con `position: static`) hace fallar los seis casos originales. Tras la revisión se añadieron 760 × 560 y un caso con dos paneles: un aviso y un estado bloqueado en el segundo panel, elegir en él una sesión cerrada (etiqueta «Historial · solo lectura» visible), «Sin sesión» y de nuevo la sesión viva, nombres y carpetas muy largos y el contexto de relevo mostrado, ampliado y cerrado; ninguno mueve los dos terminales ni envía `resize`.

## Estado y vistos en el runner (1.4 E)

Desde 1.4 E el runner, no la ventana, observa las señales explícitas del PTY y guarda el estado declarado y lo visto. La interfaz deja de ser la fuente de verdad cuando adopta el contrato (`agentAttentionVersion: 1` en `status`); mientras no lo adopte, o frente a un runner anterior, sigue el comportamiento de las secciones anteriores. El contrato exacto está en [DEVELOPMENT.md](DEVELOPMENT.md#atención-de-agentes-en-el-runner-14-e).

**Qué observa.** `agent_signals.rs` lee cada byte de salida de cada sesión PTY una sola vez, aunque la secuencia llegue partida entre lecturas: OSC 7501 raíz (`working`, `blocked`, `error`, `done`, `idle`, `clear`) con las mismas reglas que `parseProgramStatus`, BEL fuera de cadenas y notificaciones OSC 9 y OSC 777 `notify;` con las reglas de `terminal-attention.ts`. Ignora la salida cruda, los subprotocolos numéricos de OSC 9 (progreso `9;4`), DCS/SOS/PM/APC y los C1 de 8 bits. Los vectores compartidos están en `desktop/tests/fixtures/program-status-vectors.json`. Diferencias conocidas con xterm, sin efecto práctico: un OSC rastreado de más de 1 KiB se descarta entero (xterm aceptaría una notificación larga) y los C1 codificados en UTF-8 (U+0080–U+009F) se tratan como texto. El modo estructurado de Codex no usa OSC: no tiene estado y nunca se muestra como trabajando.

**Declaración del PTY.** El estado es lo que declara la salida del terminal, no la verdad del agente. Cualquier programa de la sesión, o un `cat` de un archivo que contenga una secuencia válida, puede declararlo. El runner nunca guarda ni publica el contenido de la secuencia (título, mensaje o texto de 9/777): solo un enumerado y el índice del frame que la completó.

**Avisos y visto.** Cada aviso toma el siguiente `alertSeq` de su sesión y queda registrado por tipo: `needs` (entrar en `blocked`/`error`), `finished` (`working`/`blocked`/`error` → `done`/`idle`), `bell`, `notify` (como mucho uno por tipo, sesión y segundo), `ended` (fin de proceso confirmado: `exited`, `stopped` o `failed`; `needs_attention` sigue siendo una causa del estado de la sesión, no un `ended`) y `permission` (solo una solicitud de Codex nueva confirmada en el registro, con su `requestId` y generación). Un aviso está pendiente mientras su secuencia supera `seenSeq`. `mark_seen` solo sube `seenSeq` hasta `min(through, alertSeq)`: marcar lo que se pintó nunca oculta un aviso que llegó después, y dos clientes que marcan en cualquier orden quedan en el máximo. Igual que el cliente, una declaración posterior sustituye avisos: un turno nuevo, `blocked`/`error` o `clear` sustituyen `finished`, y salir de `blocked`/`error` sustituye `needs`. El fin del proceso y el reinicio del runner nunca borran un aviso sin ver. Marcar visto no responde un permiso ni libera custodia.

**Turnos.** Un turno empieza al declarar `working` sin turno abierto, continúa durante `blocked`/`error` y termina en `done`, `idle` o `clear`. `lastTurnMs` se mide con reloj monotónico. Si el proceso termina con un turno abierto, se cierra con `turnInterrupted` y su duración real; si el runner se reinicia, los turnos abiertos pasan a interrumpidos sin duración.

**Durabilidad.** La tabla `agent_attention` de `runner.sqlite` la escribe solo el hilo `agent-attention` con su conexión; el lector del PTY nunca toma la base principal. `mark_seen` responde cuando su cambio está confirmado (`durable: true`) o, si SQLite sigue ocupado tras 2 s, con `durable: false` y el visto solo en memoria. Los demás cambios se confirman en lotes en menos de 250 ms más el tiempo de SQLite; una caída dentro de esa ventana pierde como mucho esos cambios, nunca un visto confirmado. El cierre ordenado del runner vacía la cola después de detener las sesiones. Si la tabla existe con otra definición, el runner sigue solo en memoria y no rechaza el perfil.

**Retención.** Eliminar o compactar el historial de una sesión no borra su atención: un aviso sin ver sobrevive a purgar la salida. Al abrir, el runner borra las filas cuya sesión ya no existe y conserva como mucho 512 filas de sesiones finalizadas con todo visto; las filas con avisos pendientes nunca se descartan. `status` envía como mucho 256 objetos `agent` (primero los pendientes) e indica `hasMore` y el total de pendientes.

**Compatibilidad.** Con la app 1.3.x el runner solo añade claves a `status` y `terminal_live`; los frames no cambian y su lector en xterm sigue igual. Los avisos que nadie marca se acumulan y aparecen como pendientes cuando se vuelve a la app 1.4. Un runner 1.3.x abre el perfil y no toca la tabla (comprobado con el binario de v1.3.3).

