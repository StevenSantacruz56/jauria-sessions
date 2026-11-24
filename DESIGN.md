---
name: Jauria
description: Desktop workbench design system for Jauria 1.4 (shell, sidebar, terminal chrome and Pulso).
colors:
  brand: "#f0b323"
  brand-hover: "#dca21c"
  brand-active: "#c89216"
  brand-ink: "#0e1116"
  light-sidebar: "#e9ebee"
  light-canvas: "#f1f2f4"
  light-surface: "#ffffff"
  light-raised: "#ffffff"
  light-text: "#14171c"
  light-muted: "#5c626c"
  light-dim: "#62666f"
  light-border: "rgba(14,17,22,.11)"
  light-control-border: "rgba(14,17,22,.22)"
  light-hover: "rgba(14,17,22,.05)"
  light-selected: "rgba(14,17,22,.08)"
  light-pressed: "rgba(14,17,22,.11)"
  light-focus: "#3d6fb6"
  light-state-working: "#1f62d0"
  light-state-attention: "#955000"
  light-state-ready: "#177243"
  light-state-paused: "#62666f"
  light-error: "#b5313b"
  light-error-bg: "#fff0f1"
  light-notice-bg: "#e9ebee"
  dark-sidebar: "#0e1116"
  dark-canvas: "#111316"
  dark-surface: "#16191d"
  dark-raised: "#262a30"
  dark-text: "#ecedef"
  dark-muted: "#9b9fa6"
  dark-dim: "#8d9199"
  dark-border: "rgba(255,255,255,.09)"
  dark-control-border: "rgba(255,255,255,.2)"
  dark-hover: "rgba(255,255,255,.055)"
  dark-selected: "rgba(255,255,255,.09)"
  dark-pressed: "rgba(255,255,255,.12)"
  dark-focus: "#8fa9cf"
  dark-state-working: "#5b9bff"
  dark-state-attention: "#ff9f43"
  dark-state-ready: "#2dbe7e"
  dark-state-paused: "#8d9199"
  dark-error: "#ff9da5"
  dark-error-bg: "#3a2329"
  dark-notice-bg: "#262a30"
  terminal: "#16191d"
  terminal-text: "#d5d8dd"
  terminal-muted: "#9ba0a8"
  terminal-line: "rgba(255,255,255,.09)"
  terminal-working: "#5b9bff"
  terminal-attention: "#ff9f43"
  terminal-ready: "#2dbe7e"
  terminal-error: "#ff9da5"
typography:
  body:
    fontFamily: '"Inter", -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif'
    fontSize: "13px"
    lineHeight: 1.45
  sizes: ["11px", "12px", "13px", "16px"]
  weights: [400, 500, 600]
  display:
    fontFamily: '"Bricolage Grotesque", "Inter", sans-serif'
    fontSize: "20px"
    fontWeight: 700
  label:
    fontSize: "11px"
    fontWeight: 500
rounded:
  control: "6px"
  row: "8px"
  panel: "10px"
spacing:
  compact: "4px"
  control-gap: "8px"
  column-gap: "12px"
  narrow-gutter: "16px"
  section-inset: "20px"
  gutter: "24px"
layout:
  sidebar: "264px"
  sidebar-range: "220px-420px"
  sidebar-separator-hit: "8px"
  sidebar-row: "30px"
  sidebar-overlay-below: "860px"
  top-bar: "42px"
  pane-heading: "32px"
  status-bar: "28px"
  pane-gap: "8px"
  window-minimum: "760x560"
components:
  button-primary:
    backgroundColor: "{colors.brand}"
    textColor: "{colors.brand-ink}"
    rounded: "{rounded.control}"
    padding: "6px 11px"
  button-primary-hover:
    backgroundColor: "{colors.brand-hover}"
  button-primary-active:
    backgroundColor: "{colors.brand-active}"
  tab-active:
    backgroundColor: "{colors.light-raised} / {colors.dark-raised}"
    border: "1px {colors.light-border} / {colors.dark-border}"
    rounded: "{rounded.control}"
---

# Design System: Jauria

## Overview

Jauria 1.4 is a quiet desktop workbench: neutral surfaces, one translucent border, four state colors and a cold focus accent. Amber is the brand color and the primary action, nothing else. Inter carries the interface; the supplied brand assets keep their aspect ratios and are never redrawn. Pulso is the planning area inside the shell, not a separate identity.

Authority is the built source: `experiments/tauri-vertical/desktop/src/style.css` (tokens and shell), `pulso-panel.css`, `settings-panel.css`, `telemetry.css`, `codex-conversation.css`, `terminal-theme.ts` and `src-tauri/tauri.conf.json`. The approved visual reference for 1.4 is the owner's proposal mock-up (its `:root` tokens and sidebar). `tests/design-tokens.test.ts` guards the rules below that can be checked statically. Read `PRODUCT.md` for product constraints. Source wins over this description.

**Key characteristics:**
- Fewer colors with fixed meanings: blue works, orange needs you, green finished, grey has no report.
- Compact one-line rows, visible labels and keyboard focus.
- Terminal geometry is independent of chrome changes that are not explicitly about the terminal.

## Colors

Frontmatter `light-*` and `dark-*` entries are the values of the CSS variables of the same name (`--sidebar`, `--canvas`, `--surface`, `--raised`, `--text`, `--muted`, `--dim`, `--border`, `--control-border`, `--hover`, `--selected`, `--pressed`, `--focus`, `--state-*`, `--error`, `--error-bg`, `--notice-bg`). Explicit `data-theme` wins; with no explicit light choice, system dark appearance applies. The system-dark and explicit-dark blocks in `style.css` are kept identical; a test compares them.

- **Surfaces.** `--sidebar` for the sidebar, the top bar and the status bar, `--canvas` for the workbench background behind the pane cards and the Pulso board, `--surface` for panels, cards, controls and dialogs, `--raised` for the active tab, menus and popovers. `--chrome` is an alias of the canvas tone. The dark `--sidebar` is `#0e1116`, the ink of the dark horizontal logo (its SVG carries that background rect), so the lockup shows no box; `--dim` (5.98:1) and `--muted` (7.12:1) stay AA on it.
- **Lines and states of interaction.** One `--border` for structure; `--control-border` is stronger so inputs and selects stay identifiable. Hover, selection and pressed are translucent overlays (`--hover`, `--selected`, `--pressed`) that work on any surface.
- **Text.** `--text`, `--muted` for secondary copy, `--dim` for counts, durations and section labels. All pass 4.5:1 on their surfaces.
- **Focus.** `--focus` is the keyboard ring (2 px outline, 2 px offset), the focused pane outline and the mark of selected choices and interaction emphasis (drop targets, settings switch). Focus never changes border width; the focused pane uses an inset outline.
- **States.** `--state-working`, `--state-attention`, `--state-ready`, `--state-paused`. `--working-text`, `--warning` and `--success` are aliases of the first three, so there is one state system. Errors keep their own `--error` / `--error-bg`.
- **Amber.** `--brand` (`#f0b323` with `--brand-ink`) is used only by `.primary` buttons and the brand lockup. It is not used for focus, tabs, card hover, counters, provider icons or switches. The brand kit forbids amber text on white; there is no amber text token.
- **Terminal.** `--terminal` (`#16191d`) is the same in both appearances and equals the xterm theme background in `terminal-theme.ts`; change both together. `--terminal-text` and `--terminal-muted` style the empty pane and the pane heading, which sit on the terminal surface. Because that surface is dark in both appearances, the pane heading uses `--terminal-line`, `--terminal-hover` and the `--terminal-working/attention/ready/error` state colors (the dark state values) instead of the appearance tokens. Provider badges use `--provider-claude`, `--provider-codex` and `--provider-terminal` with `--provider-ink`.

## Typography

Inter at 11, 12, 13 and 16 px, weights 400, 500 and 600 only. 13 px is body and row text, 12 px secondary copy and controls, 11 px metadata, counts, durations and section labels, 16 px the workbench title and board titles. Counts, durations and progress use tabular numerals; long titles truncate in rows and wrap elsewhere. Card notes clamp to three lines.

Display headings (welcome and dialogs) use Bricolage Grotesque at a single 20 px size. The supplied file exists only at weight 700, which is the one exception to the weight rule. JetBrains Mono is for identifiers, paths and provider badges.

## Layout

Native Tauri/macOS app: minimum window 760 × 560 px, initial 1220 × 800 px. The sidebar is 264 px by default; the person can drag its right edge between 220 and 420 px (never leaving the workbench under 440 px) and it becomes a 264 px overlay at 860 px or less, where the width handle is hidden. While that overlay and its scrim are open they cover the terminal: the focused session counts as not attended (no automatic seen, alerts stay new), the same as behind any dialog or in Pulso.

Workbench, top to bottom: the **top bar** (42 px), the stage with the pane cards, and the **status bar** (28 px). There is no message rail since delivery 1.4 B. The top bar, the pane heading (32 px), the status bar and the terminal inset have fixed heights, never wrap and are the only chrome above or below a terminal, so alerts, state changes and notices never resize a PTY. Everything that can appear on demand (alerts popover, session picker, pane menu, notice) floats with absolute positioning.

- **Top bar:** sidebar toggle (narrow windows), one raised tab per open session (provider badge, truncated name, the state indicator of the sidebar row; sessions shown in a pane keep their tab after they close) with its own horizontal scroll, "+" (new session), then the command palette button (search icon and its ⌘⇧P hint, hidden at 760 px), Dividir, the bell (count of new alerts; opens the alerts popover) (the Información panel and its button were retired in 1.4.0). In Pulso the same bar starts with a quiet «Terminal» control with its icon (back to the terminal or welcome view, keeping Pulso's draft guards; never `aria-current`) and a divider, then the scrolling strip of board tabs (only Pendientes and open projects), then, after another divider and outside the scroll, two secondary buttons: «+ Nuevo proyecto» and «Histórico» (archive icon and a counter of archived projects; `aria-expanded` while its drawer is open). At 760 px those two keep only their icon, named by `aria-label`; the Pulso button in the sidebar toggles the view (`aria-pressed`). Escape on the board never changes views. `#workspace-title` stays as a visually hidden heading.
- **Pane cards:** 8 px gap and padding on the canvas, 10 px radius, 1 px `--border`; the focused pane turns its border `--focus` and adds a 1 px `--focus` ring (no border-width change). Two panes side by side, stacked below 1050 px.
- **Pane heading (32 px):** provider badge, session name (a button that opens the session picker), the folder in dim monospace (hidden below 760 px), the state label (indicator + text, orange tint when the session needs you; «Terminando…» while a confirmed Terminar waits, «No se pudo confirmar el cierre» when the runner did not confirm it within 12 s or left it uncertain), a visible «Terminada · solo lectura» label for a session that ended on screen («Solo lectura» at 760 px or less), a quiet «Cerrar» for a session that ended on its own (takes it out of the pane), Cancelar (Ctrl-C) (help: «Cancela lo que está haciendo; la sesión sigue abierta») and the "…" menu. The heading is not positioned, so its floating menu anchors to the pane and is never clipped by the heading's overflow. The menu starts with the session details that the retired Información panel showed (full folder in monospace; provider, state, columns × rows and identifier in `--dim`; the local history note when it applies), then Copiar carpeta, Copiar identificador, Nueva sesión en esta carpeta…, Cambiar nombre, Terminar sesión with its confirmation, Liberar plaza (Sin confirmar only), and for an ended session Eliminar salida guardada… and Compactar eventos antiguos… (native confirmation). Fixture controls only in smoke profiles.
- **Session lifecycle (1.4.0):** four categories (`session-lifecycle.ts`): Abierta, Sin confirmar — ocupa plaza, Interrumpida, Terminada. A pane is for working: it never receives a Terminada by choice (picker, tabs, Dividir); a session that ends on screen keeps its pane with the read-only label. An Interrumpida in a pane shows the **recovery overlay**: a `--raised` card with `--shadow` and the 10 px radius, absolutely positioned over the terminal (never in the flow, so the PTY keeps its size), title, reason and one note; the single amber action is «Continuar conversación» or «Empezar de nuevo aquí», then «Ver salida» (secondary: folds the card into a bar at the bottom of the pane, with «Opciones…» to unfold it) and «Descartar» (quiet: «La pasa a Terminadas; no borra nada»). Keyboard focus goes to the amber action, not to the dead terminal.
- **Historial view (1.4.0):** a Terminada opens in the stage, like Pulso: a 46 px header (provider badge, 16 px title, folder in dim monospace, «Terminada · solo lectura»), a toolbar (Volver a las sesiones, Buscar en la salida with «n de m», Copiar salida, Nueva sesión en esta carpeta, Continuar conversación as a secondary button where it applies, and a "…" menu with Borrar salida guardada… and Compactar eventos…), then the saved terminal at its own geometry inside a scrolling `--terminal` card. No amber: reading has no primary action. Entering and leaving never send `resize`; Escape goes back. The panes are covered, so nothing is attended.
- **Ending a session:** a Terminar the person confirmed moves the pane, once the runner confirms the end, to the next open session not shown in the other pane (needs you → finished unseen → working → most recently used) or to the welcome view, with keyboard focus on that terminal or on Nueva sesión, never on body; only the affected pane changes. The ended session leaves the tabs and stays in Historial, read only. An end nobody asked for (exit, failure) keeps the pane so its last output can be read, with the read-only label and «Cerrar».
- **Status bar (28 px):** "N te necesita(n)" (button: opens the priority session), "N terminó/terminaron" and "N trabajando" with their indicator shapes; "Sin avisos" only when the bell is at zero (an alert no counter shows reads "N avisos"); on the right the connection with Reconectar, the focused terminal's columns × rows and the interface resources. The advice that closing the window does not stop sessions lives in the welcome view and in Configuración → Sesiones.

Sidebar, top to bottom:
- **Header (46 px):** brand lockup, search button (⌘K, reveals the search field) and new session button (⌘N).
- **Regions.** Proyectos and Agentes are two regions between the search field and the footer, each with a fixed heading and its own scroll; the sidebar itself never scrolls and the footer is always visible. Proyectos takes its content up to its share of the regions (default 34 %, 15–85 %), never less than its heading and two rows while open; Agentes takes the rest and never less than its heading, the Abiertas/Historial tabs and two rows. Before 1.4.0 both regions shrank in proportion to their content, so a long agent list (Historial) squeezed Proyectos to its heading.
- **Separators.** A horizontal separator between the regions (share) and a vertical one on the sidebar's right edge (width): `role="separator"` with orientation, value, minimum and maximum, focusable, arrows (5 % or 8 px), Home/End, Enter or double click for the default. An 8 px hit area with a 1 px `--border` line that becomes 2 px `--focus` on hover, drag and keyboard focus; row/column resize cursors; no text selection while dragging; Escape cancels a drag. The share moves live (it only changes the sidebar). The width shows a 2 px `--focus` guide while dragging and changes the grid once, on release, so each visible terminal gets at most one `resize`.
- **Folding.** Each heading title is a button with its own chevron and `aria-expanded`; a folded region keeps its heading and the other one takes the room. Both folded is not allowed (folding one unfolds the other). Share, width and folding are remembered per profile (`sidebar-layout.ts`) and validated field by field; «Restablecer tamaño de la barra lateral» (palette or Configuración) returns to the defaults.
- **Proyectos:** heading with the Pulso button, then the first 20 Pulso boards with their initial, title and done/total progress, then Pendientes with the count of unfinished cards, and «Más proyectos…» (opens Pulso) when there are more. A row opens that board in Pulso and keeps keyboard focus. The summary is never read on a timer. With a 1.4 runner it is one `sidebar_summary` read, made when `status.pulsoRevision` differs from the loaded summary and the window is visible (a hidden window rereads when it returns); with a 1.3.x runner it is read on events (connect, window focus, leaving or changing the board, session-set changes, an agent reporting done/idle).
- **Agentes:** heading with "N de M plazas" and an icon button that toggles Por proyecto / Por estado (pressed = Por estado; remembered per profile), the Abiertas/Historial tabs, the attention shortcut when there are alerts, then groups of agent rows. Por proyecto groups by the Pulso project whose main session or project link is the session, and ends with "Sin proyecto". Por estado uses the activity sections: Necesitan tu acción, Avisos, Terminaron, En curso, En espera, Sin estado del agente. Inside a group: needs action, notices, unseen finish, working, waiting, no report; ties most recent first. In Abiertas, an **Interrumpidas** section comes first (orange group marker, most recent first), each row with a quiet 24 px «Descartar». Historial lists only Terminadas, most recent first (the runner gives no dates: creation order reversed).
- **Footer:** two fixed rows that open dialogs: Uso y recursos and Configuración (⌘,). The footer never changes height.
- **Uso y recursos** is its own modal dialog (560 px), like Configuración: opened from the footer row, the status bar total and the palette; «Cerrar» and Escape close it and focus returns to what opened it (the footer row when that is gone). Top: **Cuotas**, one block per provider, each window in plain words with its bar and reset («Semana: 92 % libre · se reinicia el 25 nov, 11:23»), a «Actualizado hace …» or «Dato vencido · hace 11 h» badge (stale: muted bars, never presented as current), and «Actualizar» (the only provider query; nothing on mount or open). Without data, one line saying why and what to do. Below: **Recursos de Jauría**, a table with one row per open session by its title (its descendants added), Runner, Interfaz (window process and the helpers macOS attributes to it, WebKit included) and «Total de Jauría» in the footer row. The status bar shows that same total («Jauría · CPU … · RAM …») and opens the dialog. Measurement details live in the diagnostic, not on screen.

There is no Git repository or task entry: that feature was retired in 1.4 (delivery D).

Pulso fills the stage with a constrained flex chain. Four fixed columns (Por hacer, En curso, En espera, Hecho) of 200–320 px with a 12 px gap, so all four fit at 1220 px with the 264 px sidebar; horizontal overflow belongs to the board and vertical overflow to each card list. Gutters are 24 px, 16 px at ≤760 px. The detail drawer is a modal dialog anchored right, min(540px, 92vw) wide.

## Elevation & Depth

Surfaces are flat and separated by tone and the single border. Menus, dialogs and the drawer use `--shadow` over a `--scrim` backdrop. Cards and columns have no shadow.

## Shapes

Three radii: 6 px for controls (buttons, inputs, tabs, badges), 8 px for rows and cards, 10 px for panels, columns, dialogs and the settings card. Circles are for state dots only; the settings switch is a pill. Borders are 1 px.

## Components

- **Buttons and fields:** minimum height 32 px, padding 6px 11px, weight 500. Disabled is opacity .48. Three levels, everywhere (Pulso included):
  1. **Primary** (`.primary`, amber): the one main action of a surface (Crear proyecto, Vincular sesión, the add form's submit, Abrir/Continuar sesión principal, «Sí, terminar»).
  2. **Secondary** (the base button or `.secondary`: surface plus `--control-border`): every other text action (Proyecto, Sesiones, Nuevo proyecto, Histórico, Dar por terminado, Archivar proyecto, Ver tablero, Reabrir, Ver historial, Empezar de nuevo aquí, Cancelar, Reintentar…, Descartar mis cambios). It must read as a button at rest in both themes.
  3. **Quiet** (`.quiet`, transparent): only icon controls (close ×, a card's "…" and grip), the «Terminal» way back in Pulso's top bar, and the dashed «+ Añadir fase» control inside a column. No other text action is bare text.
  A form's primary and its Cancelar/Descartar share one row, primary first.
- **Tabs:** one raised style everywhere (session tabs, sidebar Abiertas/Historial and Pulso boards): the active tab gets `--raised` and a 1 px `--border`; no underline and no accent color.
- **Session picker:** replaces the native select. The pane name opens a popup inside the pane with a search field (`role=combobox`) and a listbox: "Sin sesión", Abiertas (Sin confirmar marked in the detail), «Interrumpidas · se pueden continuar», and a last «Nueva sesión…» row that stays during a search; never a Terminada (1.4.0), most recent first; a session visible in the other pane is disabled ("En el otro panel"). Arrows, Enter and Escape work in the field; Home/End pick the first/last option while the query is empty; Tab and Shift+Tab close it and continue in natural order. No key reaches the PTY; Escape or a choice returns focus to the terminal.
- **Command palette:** ⌘⇧P (Ctrl+Shift+P outside macOS) or the top-bar button. A modal `<dialog>` in the top layer, min(560px, 100vw − 32px) wide, 72 px from the top (48 px at 760 px), `--raised` with the 10 px radius, `--shadow` and the `--scrim` backdrop; it never enters the layout, so the terminal keeps its size. A 46 px search row (combobox) over a grouped listbox: Te necesitan, Sesiones (indicator, provider badge, project or folder), Proyectos (initial tile and progress), Fases (the phases of the project board already loaded, with column and project) and Acciones (shortcut hint on the right in `--dim`). Rows are 30 px with the 8 px radius; the active row is `--selected`; group labels are 11 px `--dim`. Disabled actions stay at full opacity with `--muted` names and the reason in place of the detail, so the reason stays legible. No amber: the palette has no primary action. No animation. Focus stays in the field (Tab does not leave the modal); Escape or a click on the backdrop closes it and returns focus to the previous element.
- **Floating controls (one rule).** Pane "…" menu, session picker, alerts popover and the Pulso card menu share `floating.ts`: only one is open at a time; a press outside closes it (taken on `document` in the capture phase and never cancelled, so a press on a terminal also focuses it); Escape closes it and returns focus to its trigger (the picker returns it to the terminal); focus moving outside (Tab, another control, another window) closes it; choosing an option closes it. Closing never resizes a pane or sends keys to a PTY. Uso y recursos is a modal dialog and the disclosures inside Pulso's drawer are inline: neither is floating.
- **Alerts popover:** opened by the bell. Rows in the sidebar priority with the indicator, "Sin ver"/"Visto", the reason and Abrir; actions Ver en la lista (sidebar filter), Marcar vistos and Abrir sesión (the priority session). Escape or a click outside closes it. New unseen alerts are announced through a visually hidden polite live region. With a 1.4 runner that reports more pending sessions than `status` lists (`hasMore`), the list ends with a muted, non-interactive «y N más sin listar» row and the bell and Dock count the runner totals: the list is never presented as complete.
- **Notice:** a floating toast at the bottom right of the stage (`--raised`, or `--error-bg` for errors), at most 96 px with its own scroll; it never takes space from a pane or takes focus. Three kinds: a short confirmation leaves after 5 s (later while hovered or focused); a progress message («Conectado. Recuperando historial…») leaves when its condition ends; an error stays until closed with its button or Escape, or until its cause is resolved. A new message replaces the previous one. Opening and ending a session use no toast: the pane heading says «Abriendo» / «Terminando…» and a visually hidden polite region announces it.
- **Agent row:** 30 px, one line: provider badge (C, X or $), truncated name, duration in `--dim`, and a state indicator on the right. Each state has its own shape in the same 12 px box: a spinning ring only for an explicit `working` report (OSC 7501), an orange dot with a halo for needs action or a notice, a green check for finished and unseen, a grey dash for waiting, an empty ring for no report. An open process without a declared state never spins. With a 1.4 runner the state, duration and alerts come from the runner's record, so they survive reconnecting; an unseen finished turn keeps the check (finished outranks working) while the agent works again, with «Trabaja de nuevo» in its label, and the pane heading word says Trabajando. The state is also present as text (screen-reader label and title), so it never depends on color alone. Animation stops with reduced motion.
- **Project row:** 30 px: initial tile, title, progress in `--dim`. The active board is marked with `--selected` and `aria-current`.
- **Pulso cards:** 8 px radius, one `--border`, `--control-border` on hover or focus. The title/note button opens detail (note clamped to three lines). Top right: the "…" menu button ("Mover a Por hacer / En curso / En espera / Hecho", the current column disabled; arrows, Home/End, Escape; Tab closes it and continues from the button) as the keyboard alternative to dragging, and the grip for pointer drag. Column headings are muted with a state dot. With a 1.4 runner a card footer (11 px, `--dim`, inside the card's bottom padding) shows the linked session as a quiet 22 px control: the sidebar's state indicator, provider badge and truncated name; it opens the live session or its history and never the drawer or a drag. The checkpoint count sits on the right as a small flag icon (own SVG in `currentColor`) and the number, with «n checkpoint(s)» as its `aria-label` and title, so the session name keeps the width; hidden at 0. A session from the last checkpoint says so in its label; an unknown session reads «Sesión no disponible» without indicator or action. No amber in the footer.
- **Pulso project bar:** one 46 px line: title, "n de m fases hechas", the secondary buttons Proyecto and Sesiones (and «Dar por terminado» when every phase is done, a normal secondary: green means the Hecho state, never an action), then the main-session action: amber when it opens or continues the session; when there is no conversation, the muted text «Sin conversación que continuar» (not a button) and the secondary «Empezar de nuevo aquí». An archived board shows «Terminado» or «Archivado», Reabrir and «Ver sesión principal» only.
- **Pulso columns:** an empty column's text box has a fixed two-line height so «+ Añadir fase» (dashed `--control-border`, `--hover` on hover, 32 px) starts at the same height in every column; with phases it follows the last one. An empty board highlights one first step under Por hacer.
- **Configuración:** sections named by task (Apariencia, Barra lateral, Sesiones, Pulso y agentes, Avisos, Acerca de y diagnóstico), separated by a line, never nested cards. Each row: a plain label and one line saying what changing it does (the current value in words where it helps, «Hasta 4 sesiones a la vez»), the control on the right. One saving model: every option applies and is saved at once, the footer status confirms it («Guardado: …») and there is no Guardar button and no unsaved state; runner options changed while a save is in flight are sent once after it, and a failure puts the control back on the runner value and says so. The dialog cannot close while a runner read or save is in flight. The Pulso access scope text stays fully visible. No amber in the dialog: it has no primary action.
- **Feedback:** notices, errors and undo stay in normal flow, capped at 25% height, never floating over cards or inline creation.

## Do's and Don'ts

- Do use the tokens; add a token instead of a new literal color.
- Do keep amber for `.primary` and the brand.
- Do keep the state as text next to every color cue.
- Do keep the top bar, pane heading, status bar and terminal inset fixed unless the change is about terminal geometry, and re-measure the PTY when it is. Anything shown on demand floats (absolute) instead of entering the flow.
- Don't show working without an explicit report, or infer state from terminal output.
- Don't add sizes, weights or radii outside the scale.
- Don't launch processes, send terminal text or reorder phases from the sidebar or the board.
