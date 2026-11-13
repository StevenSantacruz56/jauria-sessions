# Session alerts MVP

Implemented in `feat/session-alerts`, based on `849245c`. This is a development change, not audit evidence or real-provider acceptance. No real provider, user profile, system settings, push, or staging worktree was used.

## Behavior

- The header **Avisos** button is global, including when the sidebar is hidden or a task is open. It opens the session list with the alert filter and clears search. A row opens its session. The banner only offers navigation and marking seen; permissions still require the existing contextual native confirmation.
- Claude/Codex PTY sessions report **Salida nueva sin ver**, **La sesión emitió una alerta**, and **El proceso terminó**. Output coalesces per session, without inspecting its text. BEL and OSC 9 notifications / OSC 777 `notify;` use the installed xterm public parser. OSC 9 numeric subprotocols (including progress) are ignored. Replay cannot emit activity alerts. Live-to-exited/stopped/failed process transitions are deduplicated independently of status/event delivery order.
- Output and explicit signals are collected when the session is not the focused session in a visible, focused app window. Viewing consumes activity. An observed process end can remain until viewed even if the selected session has ended.
- Lifecycle incidents retain existing attention-filter coverage: failed, interrupted, unknown and `needs_attention`. The latter means custody/recovery uncertainty, never a permission wait. A confirmed runner lifecycle change clears or replaces that cause; marking seen does not release custody, stop a process, or resolve it.
- Relevant structured app-server sessions are queried independently of pane visibility, filters and task screen. Two workers maximum, one collection at a time, every three seconds. Finished history without known pending permissions is skipped. Collection is detached from terminal/status polling; completion refreshes the UI. Reconnect/version and session-generation guards discard obsolete reads.
- `pendingRequestCount` handles bounded/truncated summaries. Request identity includes generation and request ID. Read errors retain last known data as **sin confirmar**. Prior-generation requests are **caducado**, not resolved. Stale/expired observations do not add to the confirmed header number (`+ ?` indicates uncertainty), and never generate native notices.
- Initial lifecycle and first successful permission snapshots per generation are quiet: listed, without a new-alert banner or native notice. Later changes are unseen. Seen permission/custody causes remain listed until the source changes. Repeated unchanged snapshots do not re-alert. Seen state and activity are window-local; they are not persisted across app launches.

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

41 tests passed, including seven attention-model tests, two native scheduling tests and one real installed-xterm public-parser test. These cover initial quiet state, new activity after baseline, coalescing/consumption, process-end deduplication, all relevant hidden sessions, truncated counts, concurrency limit, finished-history exclusion, stale reads, generation identity, reconnect fences, opt-in/backlog suppression, focus/acknowledgement cancellation and disposal.

The runner release was built solely to provide the configured Tauri bundle resource, then `cargo test --locked` in `desktop/src-tauri` passed all 35 bridge tests. Notification plugin, capability identifiers and frontend compile successfully; this is not a packaged native delivery test.

For the synthetic Chromium integration harness, run Vite on port 5189, then from repository root:

```sh
JAURIA_PLAYWRIGHT_MODULE=/path/to/playwright/index.mjs node experiments/tauri-vertical/desktop/tests/attention-browser.mjs
```

The harness uses an isolated browser context and a synthetic Tauri RPC adapter; no runner/profile/provider or native permission API. It checks hidden PTY output/BEL, navigation, consumption, hidden structured permission deltas, seen versus resolved, quiet historical replay, and no horizontal page overflow at the minimum supported width. Screenshots are local ignored evidence in `.impeccable/review/desktop.png` and `minimum-window.png`; the fixture intentionally includes three synthetic sessions to exercise cross-session collection, not production capacity acceptance.

## Review and integration

Claude's independent design review was read from the parent-provided `alerts-design-review-result.json`. Incorporated: explicit PTY facts, source uncertainty, generation expiry, quiet baselines, seen versus resolved, navigation-only permission handling, generic opt-in notifications and truthful delivery limits. Its proposal for a new “accept current custody” mutation was deferred: existing backend custody/recovery transitions remain authoritative. No invented permission or turn-completion heuristics, provider hooks or user configuration changes.

Impeccable context ran once. Existing brand, tokens, typography and workbench composition were retained. Two visual inspection rounds covered 1220×800 and 760×640. The detector reported only two pre-existing Inter font warnings; preserved per the explicit brand requirement. With no finish-review subagent available, the inline degraded review found the added banner, navigation, wrapping reasons and seen styling consistent with the incumbent surface (ship at that visual scope). This does not claim an independent implementation review. Claude's design review is not code approval; independent code/native-delivery review remains pending with the integrating parent.

`src/main.ts` will conflict with the scroll worker. Preserve its bounded redraw optimization: these changes add no refresh to individual output/BEL callbacks. They only record coalesced observations, surfaced by status polling and attention collection completion. Keep the detached bounded collector and version/generation checks when integrating. No scroll-worker or audited-staging files were edited.

PTY permission detection and semantic turn completion remain unavailable. Hooks are not installed or configured. Alerts while the UI is closed require future runner-side infrastructure. Native macOS delivery, Focus mode behavior and signed/installed bundle behavior need explicit user-driven runtime validation.

## Terminal geometry regression

Notification and connection messages share an always-present 50 px rail. Showing, consuming, dismissing or replacing a message does not change terminal rows or columns. This matters for native Codex: changing the PTY geometry sends SIGWINCH, causing a redraw that can jump away from the reading position. The native focus regression was reproduced with the old layout (31 → 34 rows) and checked after the fix (121 × 31 throughout; zero resize events; same runner and PTY process).

`node --test tests/browser/notification-geometry.test.ts` checks host bounds, real xterm dimensions, every rendered frame and native resize-request counts in Chrome/WebKit at 1220 × 800 and 760 × 640. The old source at `5431021` fails all four cases. The browser suite runs files serially: simultaneous browser-heavy fixtures made the older detached-viewport baseline timing-dependent. This test evidence is separate from security-audit reproductions.
