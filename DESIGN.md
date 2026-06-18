# Design System — AgentMesh

> **This document supersedes the previous "Warm Terminal" system.** AgentMesh's design
> language is **Mission Control**: a calm, high-signal control room for
> supervising a fleet of autonomous agents. The earlier warm-neutral direction
> (Geist Sans, amber/orange orchestrator CTA, brown-tinted surfaces) is retired.
> This file is the single source of truth — there is no second package-level
> `DESIGN.md`. Origin: the dashboard design-language exploration in
> [`docs/design/dashboard-language.md`](docs/design/dashboard-language.md) and
> its canonical mockups ([`kanban.html`](docs/design/mockups/kanban.html),
> [`session.html`](docs/design/mockups/session.html)).

## Product Context

- **What this is:** A web dashboard for supervising fleets of parallel AI coding agents. Each agent gets its own git worktree, branch, and PR. The dashboard is the operator's single pane of glass.
- **Who it's for:** Developers running 10–30+ agents in parallel. It must stay calm and glanceable with 20+ agents running.
- **Project type:** Next.js 15 (App Router) + React 19 + Tailwind v4. A kanban fleet board (home) and a per-session detail view.

## Concept & Identity

**A calm, high-signal control room.** Linear-grade restraint, dense but humane.
State is glanceable, not noisy.

**The blue/orange split.** The mascot is the Claude Code character recolored
**blue** — the _conductor_. This drives a deliberate two-color semantic split:

- **Blue = the orchestrator (AO itself / "you").** Brand, the single solid-fill
  primary CTA (the **Orchestrator** button), active selection, focus, links.
- **Orange = the agents being conducted.** The per-agent identity and the
  **`working`** status — the one "an agent is alive right now" signal (a gently
  breathing dot, the terminal cursor).

Blue does not _replace_ orange; they mean different things. The board reads as a
blue conductor surrounded by orange agents.

## Color discipline

**Color = meaning. Most states get none.** The UI is grayscale by default;
color is rationed so it always signals something.

| Token         | Hex       | Use                                                                                         |
| ------------- | --------- | ------------------------------------------------------------------------------------------- |
| Blue          | `#4d8dff` | orchestrator / you — primary action, selection, focus, links (the _only_ solid-fill button) |
| Orange        | `#f59f4c` | a working agent (status dot + terminal cursor)                                              |
| Amber         | `#e8c14a` | needs-your-input / attention (incl. unresolved review comments, changes requested)          |
| Red           | `#ef6b6b` | failing / stuck (CI failed, crashed, conflicts)                                             |
| Green         | `#74b98a` | mergeable / passed / resolved                                                               |
| Neutral grays | —         | everything healthy & passive: in-review, idle, done, metadata                               |

Diff add/remove green & red are permitted in their literal context (the Changes view).

### Surfaces & lines (dark, cool neutral)

The product is **dark-only mission control**. The dark theme is authoritative.

| Token (literal) | Value                                   | Maps to semantic token                                                   |
| --------------- | --------------------------------------- | ------------------------------------------------------------------------ |
| `--bg`          | `#0a0b0d`                               | `--color-bg-base` (app base)                                             |
| `--bg-side`     | `#08090b`                               | `--color-bg-sidebar`                                                     |
| `--card`        | `#15171b`                               | `--color-bg-surface` / `--color-bg-card` — **the only bordered surface** |
| `--card-hover`  | `#191b20`                               | `--color-bg-elevated` / `-elevated-hover`                                |
| `--col`         | `#0e0f12`                               | `--color-column-bg` (kanban trough)                                      |
| `--term`        | `#0c0d10`                               | xterm background (terminal-themes.ts)                                    |
| `--line`        | `rgba(255,255,255,0.06)`                | `--color-border-subtle` / `-default`                                     |
| `--line-2`      | `rgba(255,255,255,0.10)`                | `--color-border-strong`                                                  |
| `--t1 … --t4`   | `#f4f5f7` `#9ba1aa` `#646a73` `#444951` | `--color-text-primary/secondary/tertiary/muted`                          |

These literals live at the top of the `.dark` block in
`packages/web/src/app/globals.css`; the existing `--color-*` semantic tokens
**alias** them, so all consuming CSS keeps working. **Don't rename the semantic
tokens** — add/alias and migrate.

## Typography

Self-hosted via `next/font/local` (`packages/web/src/fonts/`). **No external font CDN.**

- **UI = Schibsted Grotesk** (`--font-sans`). The product voice. Used for all
  chrome: titles, labels, buttons, body. A distinctive grotesk — not Inter/system.
- **Machine = JetBrains Mono** (`--font-mono`). Branches, IDs, PR numbers, costs,
  timestamps, terminal — anything the machine emits.
- **Numerals:** `tabular-nums` wherever numbers appear (counts, costs, tokens).
- **Never render chrome in mono.** The sans/mono split is itself a design device:
  product voice vs. machine voice.

(Geist Sans is removed. JetBrains Mono is no longer used for display headlines.)

## Status as one system

A single semantic spectrum maps the canonical lifecycle to a `{tone, label}`
pair and is used **everywhere** — kanban card badge, sidebar dot, session topbar
pill. It lives in [`lib/status-spec.ts`](packages/web/src/lib/status-spec.ts)
(`getStatusSpec`) and renders through
[`StatusBadge`](packages/web/src/components/StatusBadge.tsx).

| Tone               | Color              | Meaning                                 |
| ------------------ | ------------------ | --------------------------------------- |
| `working`          | orange (breathing) | an agent is alive right now             |
| `input`            | amber              | needs your input                        |
| `changes`          | amber              | changes requested                       |
| `fail`             | red                | CI failed / stuck / crashed / conflicts |
| `review`           | neutral            | in review / waiting on a reviewer       |
| `ready` / `merged` | green              | mergeable / landed                      |
| `neutral`          | gray               | idle / done / terminated                |

Tone is refined from the (tested) attention-level bucket so a card's badge never
disagrees with the column it sits in.

## Layout patterns

### Fleet board (home) — `kanban.html`

- **Lead with the fleet, not the terminal.** Answers "what are all my agents doing?" at a glance.
- **Frameless columns:** lifecycle columns **Working → Needs you → In review →
  Ready to merge** are borderless tinted troughs with a faint _per-column_
  semantic top-glow. The **card is the only bordered surface** — no box-in-box.
- **Compact cards:** status badge + id, task title (2-line clamp), branch, a thin
  footer. Done/Terminated collapses at the bottom.
- The sidebar always shows **all projects'** sessions; the board filters
  client-side. The SSE refresh interval is **5s** (unchanged — C-14).

### Session detail — `session.html`

- **Framed terminal** as a real surface (header + viewport), flush to sidebar/topbar.
  It is a **live xterm.js/PTY** — we do _not_ style its content; we only set the
  frame and the xterm.js `theme` object (background `--term`, orange cursor, blue
  selection, a 16-color ANSI palette tied to the tokens — see `terminal-themes.ts`).
  Claude Code's own input lives inside the terminal; there is no separate composer.
- **Pluggable inspector rail** (a registered-view slot):
  [`SessionInspector`](packages/web/src/components/SessionInspector.tsx) with views
  **Summary · Changes · Browser**; adding more (Logs, Cost…) is just another entry.
  - _Summary_ is ordered by supervision value: **Pull request → Review comments →
    Activity → Overview** (the PR card bundles PR + review comments).
  - _Review comments_ surface a soft-blue **Address** action (`askAgentToFix`) that
    hands the comment — with its `file:line` — to the agent session to fix.
  - _Browser_ is reserved for a web-preview / Playwright plugin.
- **Topbar:** `‹ Kanban` (back) · title + inline branch · **status pill** ·
  notifications · **Kill** (trash) · **Orchestrator** (blue primary, org-chart icon).

## Iconography & motion

- **Line icons only** (Lucide-style, ~1.6px stroke, `currentColor`, inline SVG). **No emoji.**
- **Motion is minimal & purposeful:** a slow CSS-only "breathe" pulse on the
  working dot / terminal cursor (`@keyframes breathe`, 2.4s). No animation
  libraries (C-07). All motion respects `prefers-reduced-motion: reduce`.

## Web Implementation Rules

- **Tokens over raw values.** Use the `--color-*` semantic tokens (or the literal
  `--bg/--card/--t1…` palette) from `globals.css`. No hardcoded hex/rgba in components.
- **No inline `style=`** for theme values (C-02). Tailwind utilities with
  `var(--token)`, or a named class in `globals.css`.
- **No external UI kits** (Radix, shadcn, Headless UI, …) (C-01).
- **Tailwind vs CSS classes:** Tailwind for one-off layout/spacing; add a class in
  `globals.css` when a pattern is theme-sensitive, uses pseudo-elements/gradients,
  or repeats 3+ times.
- **App Router only** (C-06). Component files ≤ 400 lines (C-04). Test files for
  new/changed components (C-12).
- **Dark theme is always preserved** (C-05). Light-mode tokens still exist for the
  theme toggle but mission control is designed and tuned for dark.

## Accessibility

- **Focus indicators:** `outline: 2px solid var(--color-accent); outline-offset: 2px` on `:focus-visible`. Never `outline: none` without a visible replacement.
- **Reduced motion:** `@media (prefers-reduced-motion: reduce)` disables animations/transitions. Non-negotiable.
- **Color independence:** never encode meaning with color alone. Status badges always pair a colored dot with a text label.
- **Contrast:** body text ≥ 4.5:1; UI/borders/icons ≥ 3:1. The text ramp `--t1…--t3` is for primary→labels on the `--bg`/`--card` surfaces; `--t4` is for faint/disabled only.
- **Keyboard nav:** all interactive elements reachable via Tab; Escape closes popovers; logical order.
- **ARIA labels** on all icon-only buttons.

## Constraints

- C-01: No new UI component libraries
- C-02: No inline styles in new/modified code
- C-04: Component files max 400 lines
- C-05: Dark theme preserved
- C-06: Next.js App Router only
- C-07: No animation libraries (CSS-only motion)
- C-12: Test files for new/changed components
- C-14: SSE 5s interval unchanged

## Decisions Log

| Date       | Decision                                                       | Rationale                                                                                                                                                            |
| ---------- | -------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 2026-05-27 | **Mission Control supersedes Warm Terminal**                   | A single source of truth. The product is a calm control room for a fleet of agents; cool restraint + rationed color reads better at 20+ agents than warm decoration. |
| 2026-05-27 | Blue = orchestrator/you, orange = working agent                | The mascot is the blue conductor; orange is the Claude Code lineage. Two colors, two meanings — the product metaphor, visualized.                                    |
| 2026-05-27 | Schibsted Grotesk (UI) + JetBrains Mono (machine), self-hosted | A distinctive grotesk for the product voice; mono reserved for machine data. Self-hosted via `next/font/local` — no external font CDN.                               |
| 2026-05-27 | One status system (`getStatusSpec` + `StatusBadge`)            | Kanban badge, sidebar dot, and topbar pill all render from one spectrum so status never disagrees with itself.                                                       |
| 2026-05-27 | The card is the only bordered surface                          | Frameless tinted columns with per-column glow; cards are flat `--card` with a hairline ring. No box-in-box nesting.                                                  |
