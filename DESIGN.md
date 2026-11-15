---
name: Jauria
description: Existing desktop workbench design system, as implemented in Pulso.
colors:
  primary: "#f0b323"
  primary-hover: "#dca21c"
  primary-active: "#c89216"
  primary-ink: "#0e1116"
  light-surface: "#ffffff"
  light-sidebar: "#eef3fa"
  light-chrome: "#f6f8fb"
  light-hover: "#e6ebf2"
  light-pressed: "#dce3ed"
  light-text: "#0e1116"
  light-muted: "#5c626c"
  light-border: "#dce1e8"
  light-control-border: "#bdc6d3"
  light-accent: "#926500"
  light-accent-hover: "#785200"
  light-selected: "#e8edf4"
  light-selected-text: "#35465c"
  light-working-text: "#245fae"
  light-success: "#278153"
  light-warning: "#946200"
  light-error: "#b5313b"
  light-error-bg: "#fff0f1"
  light-notice-bg: "#eef3fa"
  dark-surface: "#1e232c"
  dark-sidebar: "#0e1116"
  dark-chrome: "#242a34"
  dark-hover: "#303844"
  dark-pressed: "#3c4655"
  dark-text: "#e9edf3"
  dark-muted: "#a7b0bd"
  dark-border: "#323b49"
  dark-control-border: "#526076"
  dark-accent: "#f0b323"
  dark-accent-hover: "#dca21c"
  dark-selected: "#323d4c"
  dark-selected-text: "#d9e4f2"
  dark-working-text: "#91bbff"
  dark-success: "#71c59a"
  dark-warning: "#e2b567"
  dark-error: "#ff9da5"
  dark-error-bg: "#39252d"
  dark-notice-bg: "#293341"
typography:
  body:
    fontFamily: '"Inter", -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif'
    fontSize: "13px"
    lineHeight: 1.45
  title:
    fontSize: "24px"
    fontWeight: 600
    lineHeight: 1.2
    letterSpacing: "-.03em"
  label:
    fontSize: "12px"
    fontWeight: 600
    lineHeight: 1.4
rounded:
  control: "6px"
  feedback: "8px"
  card: "12px"
spacing:
  compact: "4px"
  control-gap: "8px"
  column-gap: "12px"
  narrow-gutter: "16px"
  section-inset: "20px"
  gutter: "24px"
components:
  button-primary:
    backgroundColor: "{colors.primary}"
    textColor: "{colors.primary-ink}"
    rounded: "{rounded.control}"
    padding: "6px 11px"
  button-primary-hover:
    backgroundColor: "{colors.primary-hover}"
  button-primary-active:
    backgroundColor: "{colors.primary-active}"
---

# Design System: Jauria

## Overview

Pulso belongs to Jauria's established desktop workbench: Inter, yellow actions, local light/dark surfaces, compact controls and restrained borders. Preserve the supplied brand assets and their aspect ratios; Pulso names the planning area, not a separate identity.

This records the built source after the F1 feedback correction. The reviewer confirmed F1 resolved in the inspected captures; validation evidence remains separate from design authority. Authority: `experiments/tauri-vertical/desktop/src/style.css`, `pulso-panel.css`, `pulso-panel.ts` and `src-tauri/tauri.conf.json`. Read `PRODUCT.md` for product constraints and `.impeccable/surfaces/pulso-board.md` for the surface brief. Source wins over intended composition.

**Key Characteristics:**
- Compact desktop task controls with visible labels and keyboard focus.
- Tonal separation in both appearances; yellow reserved for actions and interaction emphasis.
- Board browsing and focused detail editing within the existing terminal workbench.

## Colors

Primary buttons retain the fixed yellow fill and dark ink in both themes. The semantic accent differs by appearance: darker amber in light mode, yellow in dark mode. Use the existing `--accent` for focus, card borders and the active tab underline; do not substitute the primary fill everywhere.

Use `--surface` for cards, controls and drawer; `--chrome` for columns and the active tab; `--border` for structural dividers; `--control-border` for controls and cards. Muted copy uses `--muted`. Selection uses the paired `--selected` / `--selected-text` tokens. Column headings use `--working-text`, `--warning` and `--success` for En curso, En espera and Hecho; retain textual status labels. Errors pair `--error` with `--error-bg`; undo uses `--notice-bg`.

Frontmatter `light-*` and `dark-*` entries record the corresponding CSS variables, not new runtime token names. Explicit `data-theme` takes precedence; system dark appearance applies when no explicit light/dark choice exists. Terminal colors remain independent of appearance.

## Typography

Inter is the Pulso UI family, inherited from the desktop root. The root body uses the frontmatter body role; supporting copy is usually (12px), metadata/counts (11px). Pulso's page title uses the title role; board titles are (17px, 600, 1.35), drawer content titles (20px, 600, 1.35), card titles (13px, 600, 1.5). Column headings use the label role. Counts and progress use tabular numerals; long text wraps, and card notes clamp to three lines.

The existing shell also supplies Bricolage Grotesque for welcome/general dialog/task headings and JetBrains Mono for technical identifiers. Pulso headings currently remain Inter; do not spread those other roles into Pulso by assumption.

## Layout

Native Tauri/macOS app; configured window minimum is (760 × 560px), initial size (1220 × 800px). Browser-sized CSS is an implementation detail, not evidence of a mobile product. The shell sidebar is (232px) and becomes an overlay below (860px).

Pulso fills the existing stage with a constrained flex chain and hidden outer overflow. Header, tabs, messages and toolbar occupy normal flow. Four fixed statuses stay in order: Por hacer, En curso, En espera, Hecho. Columns have a (240px) minimum, (320px) maximum and (12px) gap. Horizontal overflow belongs to the board; vertical overflow belongs to each card list. Four simultaneously visible columns depend on available stage width: do not promise that at every desktop width or stack columns at the native minimum.

Main gutters are (24px), reduced to (16px) at viewport widths ≤760px. Header actions and toolbar controls wrap. Tabs have their own horizontal overflow. Detail copy is constrained to (74ch).

The detail surface is a modal HTML dialog anchored right, (min(540px, 92vw)) wide and full viewport height. Its header and clear close control remain above the independently scrolling detail body. Preserve closed-dialog behavior; only the open dialog becomes flex.

## Elevation & Depth

Cards and columns are flat bordered surfaces without card shadows. The drawer uses the existing appearance-specific `--shadow` and a translucent backdrop. Feedback has no floating elevation. Exact shadows and transition values are in `.impeccable/design.json`.

## Shapes

Controls use gently rounded corners (6px); feedback uses (8px); cards and columns use (12px), all with thin borders (1px). Active tabs have rounded top corners and an accent underline (2px). Drawer edges are square. Controls use authored SVG icons with current-color strokes; do not redraw brand assets.

## Components

- **Buttons and fields:** inherited buttons have minimum height (32px), padding (6px 11px), weight (500); secondary buttons use the surface and control border, quiet buttons are transparent. Inputs/selects use padding (7px 9px) and the control radius. Inline-add fields have minimum height (36px). Focus is a (2px) accent outline offset (2px); disabled controls use opacity (.48). Preserve labels, invalid borders and reduced-motion handling.
- **Board navigation:** Pendientes is permanent and includes Hecho; projects appear alongside it. Current tabs use chrome, stronger text and an underline. No separate filter-chip visual system is implemented in Pulso.
- **Cards:** the title/note button opens detail; a separate pointer grip moves between status columns, with a native status select as an alternative. Card body padding reserves space for the grip. Hover/focus changes the border to accent; dragging dims the card and dashes its border, while the target column gains an inset accent outline and selection fill. Status moves preserve phase order; they do not start a session or implement a workflow engine. Inline creation is available in the three unfinished columns, not Hecho.
- **Drawer:** project plan/main session live in “Plan y sesiones”; notes, checkpoints, continuity and explicit session actions live in detail. Use existing disclosure sections for secondary editing and permissions. Dirty or failed drafts block dismissal/navigation until resolved; preserve retry and discard access. History, live-session focus and conditional conversation resume remain distinct actions. Preparing/copying context never automatically pastes or executes it.
- **Feedback after F1:** feedback, errors and undo all explicitly use `position: static`, nonshrinking layout participation and internal overflow, capped at (25%) height. They must not float over cards or inline creation. Status feedback is polite live text; errors are alerts with retry controls. Opening the modal moves feedback/errors into its message container so they remain reachable there; undo stays in board flow. Do not turn this source observation into a claim that final visual review has passed.

## Do's and Don'ts

- Do reuse the existing appearance variables and supplied brand assets.
- Do contain board overflow and keep the native minimum window usable.
- Do preserve explicit status controls, focus outlines, drafts and retry access.
- Do keep Pulso feedback in normal flow and terminal geometry independent.
- Don't invent a Pulso identity, palette, component library or service/API capability.
- Don't launch processes, send terminal text or reorder phases through card movement.
- Don't infer board status from program status or conflate saved output with resumed conversation.
