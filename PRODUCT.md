# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

Jauria is a desktop macOS application built with a Tauri WebView and native Rust services. This value describes its frontend technology; distribution and operating conventions remain desktop macOS, not a hosted website.

## Users

Steven and developers working in native Claude Code, Codex and ordinary terminal sessions. Work can start in a Git repository or the user home directory.

## Product Purpose

One app to capture lightweight work, organize a complete plan as a project with phases, and return to the exact linked conversation or a saved phase checkpoint. Jira retains detailed specifications and team tracking.

## Operating Context

A project is a Trello-style board with four fixed workflow columns (to do, in progress, waiting, done), one explicitly chosen main session and optional sessions related to phases. Cards open a focused side drawer; creating and moving cards are board actions, not session launches. Business projects do not require a Git repository and do not create worktrees. The existing Git project/task workflow remains separate.

## Capabilities and Constraints

Preserve terminal responsiveness, scroll, input, tabs and split panes. Use profile-local data, explicit agent access and native provider permissions. Recovering saved terminal output is distinct from resuming a provider conversation. A phase checkpoint does not rewind a chat and is never automatically pasted or executed. No browser synchronization or second app is required.

## Brand Commitments

Preserve Jauria's supplied brand assets, implemented light/dark tokens, typography and controls. Pulso names the planning area inside Jauria.

## Evidence on Hand

Existing Jauria source at 70e7c96 and Pulso Site source at 21b9f6fa8f5b65a2a95934f14b7d18461e80227d. Planning evidence in docs/PULSO_INTEGRATION_PLAN.md. All new demos/tests use synthetic content.

## Product Principles

- Capture a title inline first; detail is optional and appears in the card drawer.
- Moving a card between columns changes workflow state; it preserves the phase sequence and never starts a process.
- Projects and phases retain explicit session references.
- Status changes are attributed, reversible and independent of code acceptance.
- Keep planning queries outside the terminal frame/input loop.
- Honest recovery actions distinguish live sessions, history and saved context.
