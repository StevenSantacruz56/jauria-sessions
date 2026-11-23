---
name: Jauria
description: Desktop workbench design system for Jauria 1.4 (shell, sidebar and Pulso).
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
  light-brand-text: "#8a5f00"
  light-error: "#b5313b"
  light-error-bg: "#fff0f1"
  light-notice-bg: "#e9ebee"
  dark-sidebar: "#0c0e11"
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
  dark-brand-text: "#f0b323"
  dark-error: "#ff9da5"
  dark-error-bg: "#3a2329"
  dark-notice-bg: "#262a30"
  terminal: "#16191d"
  terminal-text: "#d5d8dd"
  terminal-muted: "#9ba0a8"
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
  sidebar-row: "30px"
  sidebar-overlay-below: "860px"
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

Authority is the built source: `experiments/tauri-vertical/desktop/src/style.css` (tokens and shell), `pulso-panel.css`, `settings-panel.css`, `telemetry.css`, `review-panel.css`, `verification-panel.css`, `codex-conversation.css`, `terminal-theme.ts` and `src-tauri/tauri.conf.json`. The approved visual reference for 1.4 is the owner's proposal mock-up (its `:root` tokens and sidebar). `tests/design-tokens.test.ts` guards the rules below that can be checked statically. Read `PRODUCT.md` for product constraints. Source wins over this description.

**Key characteristics:**
- Fewer colors with fixed meanings: blue works, orange needs you, green finished, grey has no report.
- Compact one-line rows, visible labels and keyboard focus.
- Terminal geometry is independent of chrome changes that are not explicitly about the terminal.

## Colors

Frontmatter `light-*` and `dark-*` entries are the values of the CSS variables of the same name (`--sidebar`, `--canvas`, `--surface`, `--raised`, `--text`, `--muted`, `--dim`, `--border`, `--control-border`, `--hover`, `--selected`, `--pressed`, `--focus`, `--state-*`, `--brand-text`, `--error`, `--error-bg`, `--notice-bg`). Explicit `data-theme` wins; with no explicit light choice, system dark appearance applies. The system-dark and explicit-dark blocks in `style.css` are kept identical; a test compares them.

- **Surfaces.** `--sidebar` for the sidebar, `--canvas` for the workbench background, header and Pulso board, `--surface` for panels, cards, controls and dialogs, `--raised` for the active tab and menus. `--chrome` is an alias of the canvas tone for pane headings, the message rail and the footer.
- **Lines and states of interaction.** One `--border` for structure; `--control-border` is stronger so inputs and selects stay identifiable. Hover, selection and pressed are translucent overlays (`--hover`, `--selected`, `--pressed`) that work on any surface.
- **Text.** `--text`, `--muted` for secondary copy, `--dim` for counts, durations and section labels. All pass 4.5:1 on their surfaces.
- **Focus.** `--focus` is the keyboard ring (2 px outline, 2 px offset), the focused pane outline and the mark of selected choices and interaction emphasis (drop targets, settings switch). `--accent` is kept as an alias of `--focus` for older rules. Focus never changes border width; the focused pane uses an inset outline.
- **States.** `--state-working`, `--state-attention`, `--state-ready`, `--state-paused`. `--working-text`, `--warning` and `--success` are aliases of the first three, so there is one state system. Errors keep their own `--error` / `--error-bg`.
- **Amber.** `--brand` (`#f0b323` with `--brand-ink`) is used only by `.primary` buttons and the brand lockup. It is not used for focus, tabs, card hover, counters, provider icons or switches. `--brand-text` (`#8a5f00` on light, `#f0b323` on dark) is reserved for amber text if it is ever needed; the brand kit forbids amber text on white.
- **Terminal.** `--terminal` (`#16191d`) is the same in both appearances and equals the xterm theme background in `terminal-theme.ts`; change both together. `--terminal-text` and `--terminal-muted` style the empty pane that sits on the terminal surface. Provider badges use `--provider-claude`, `--provider-codex` and `--provider-terminal` with `--provider-ink`.

## Typography

Inter at 11, 12, 13 and 16 px, weights 400, 500 and 600 only. 13 px is body and row text, 12 px secondary copy and controls, 11 px metadata, counts, durations and section labels, 16 px the workbench title and board titles. Counts, durations and progress use tabular numerals; long titles truncate in rows and wrap elsewhere. Card notes clamp to three lines.

Display headings (welcome, dialogs, task) use Bricolage Grotesque at a single 20 px size. The supplied file exists only at weight 700, which is the one exception to the weight rule. JetBrains Mono is for identifiers, paths and provider badges.

## Layout

Native Tauri/macOS app: minimum window 760 × 560 px, initial 1220 × 800 px. The sidebar is 264 px and becomes an overlay below 860 px. The 50 px message rail, the pane heading and the terminal inset are fixed so that notices never resize a PTY.

Sidebar, top to bottom:
- **Header (46 px):** brand lockup, search button (⌘K, reveals the search field) and new session button (⌘N).
- **Proyectos:** Pulso boards with their initial, title and done/total progress, then Pendientes with the count of unfinished cards. A row opens that board in Pulso; the layers button opens Pulso on the last board. The list scrolls inside at most about a third of the sidebar.
- **Agentes:** heading with "N de M plazas", the Abiertas/Historial tabs, the Por proyecto / Por estado switch (remembered per profile), the attention shortcut when there are alerts, then groups of agent rows. Por proyecto groups by the Pulso project whose main session or project link is the session, and ends with "Sin proyecto". Por estado uses the activity sections: Necesitan tu acción, Avisos, Terminaron, En curso, En espera, Sin estado del agente. Inside a group: needs action, unseen finish, working, rest.
- **Footer:** Uso y recursos (disclosure with its own chevron), Configuración (⌘,) and a quiet connection line.

The Git repository and task entry is not shown in the sidebar in 1.4.

Pulso fills the stage with a constrained flex chain. Four fixed columns (Por hacer, En curso, En espera, Hecho) of 240–320 px with a 12 px gap; horizontal overflow belongs to the board and vertical overflow to each card list. Gutters are 24 px, 16 px at ≤760 px. The detail drawer is a modal dialog anchored right, min(540px, 92vw) wide.

## Elevation & Depth

Surfaces are flat and separated by tone and the single border. Menus, dialogs and the drawer use `--shadow` over a `--scrim` backdrop. Cards and columns have no shadow.

## Shapes

Three radii: 6 px for controls (buttons, inputs, tabs, badges), 8 px for rows and cards, 10 px for panels, columns, dialogs and the settings card. Circles are for state dots only; the settings switch is a pill. Borders are 1 px.

## Components

- **Buttons and fields:** minimum height 32 px, padding 6px 11px, weight 500. Primary is amber; secondary uses the surface and control border; quiet is transparent; icon buttons are transparent and muted until hover. Disabled is opacity .48.
- **Tabs:** one raised style everywhere (sidebar Abiertas/Historial, the grouping switch and Pulso boards): the active tab gets `--raised` and a 1 px `--border`; no underline and no accent color.
- **Agent row:** 30 px, one line: provider badge (C, X or $), truncated name, duration in `--dim`, and a state indicator on the right. The indicator spins only for an explicit `working` report (OSC 7501); a green dot means finished and unseen, an orange dot needs action or carries a notice, a grey dot is idle, an empty ring means no report. An open process without a declared state never spins. The state is also present as text (screen-reader label and title), so it never depends on color alone. Animation stops with reduced motion.
- **Project row:** 30 px: initial tile, title, progress in `--dim`. The active board is marked with `--selected` and `aria-current`.
- **Pulso cards:** 8 px radius, one `--border`, `--control-border` on hover or focus. The title/note button opens detail; the grip and the native "Mover" select move the card. Column headings are muted with a state dot.
- **Feedback:** notices, errors and undo stay in normal flow, capped at 25% height, never floating over cards or inline creation.

## Do's and Don'ts

- Do use the tokens; add a token instead of a new literal color.
- Do keep amber for `.primary` and the brand.
- Do keep the state as text next to every color cue.
- Do keep the message rail, pane heading and terminal inset fixed unless the change is about terminal geometry, and re-measure the PTY when it is.
- Don't show working without an explicit report, or infer state from terminal output.
- Don't add sizes, weights or radii outside the scale.
- Don't launch processes, send terminal text or reorder phases from the sidebar or the board.
