# Dashboard Design Language — exploration (ao-2-1)

A design-language exploration for the AO dashboard, captured as live HTML mockups
plus the rationale behind them. This is an **iteration on / proposal alongside**
the existing [`DESIGN.md`](../../DESIGN.md) — see [Relationship to DESIGN.md](#relationship-to-designmd)
for where it diverges and what needs reconciling before any production work.

> These are **reference mockups**, not production code. They use a Google-Fonts
> CDN and inline `<style>`/`style=` for speed of iteration. The production
> implementation must use the AO Tailwind v4 tokens in `globals.css`, no inline
> styles (C-02), no external font CDN, and CSS-only motion (C-07).

## Mockups

| File | What it is |
|------|-----------|
| [`mockups/kanban.html`](mockups/kanban.html)   | **Canonical** — the fleet board (home view): lifecycle columns of agent-session cards. |
| [`mockups/session.html`](mockups/session.html) | **Canonical** — the agent session detail page: framed terminal + pluggable inspector rail. |
| [`mockups/mascot.png`](mockups/mascot.png)      | The mascot — Claude Code's character recolored blue (the conductor). |
| `mockups/concepts.html`        | Exploration — three early directions (A refined / B terminal-craft / C bold console). |
| `mockups/refined.html`         | Exploration — the first restrained single-screen pass. |
| `mockups/orchestrator-icons.html`, `orgchart-icons.html`, `address-icons.html` | Exploration — icon candidate comparisons. |

## Concept

**A calm, high-signal control room for supervising a fleet of autonomous agents.**
Linear-grade restraint, dense but humane. The product must stay calm with 20+
agents running: state is glanceable, not noisy.

## Identity — the blue/orange split

The mascot is the Claude Code character recolored **blue**, holding a wand — it's
the *conductor*. This drives a deliberate two-color semantic split:

- **Blue = the orchestrator (AO itself / "you").** Brand, the single primary CTA
  (the **Orchestrator** button), active selection, focus, links.
- **Orange = the agents being conducted (the Claude Code lineage).** The per-agent
  identity and the **`working`** status — the one "an agent is alive right now"
  signal (a gently breathing dot, the terminal cursor).

Blue does not *replace* orange; they mean different things. The fleet board reads
as a blue conductor surrounded by orange agents — the product's metaphor, visualized.

## Color discipline

**Color = meaning. Most states get none.** The UI is grayscale by default; color
is rationed so it always signals something:

| Token | Use |
|-------|-----|
| Blue `#4d8dff` | orchestrator / you — primary action, selection, focus (the *only* solid-fill button) |
| Orange `#f59f4c` | a working agent (status + cursor) |
| Amber `#e8c14a` | needs-your-input / attention (incl. unresolved review comments) |
| Red `#ef6b6b` | failing (CI failed, stuck) |
| Green `#74b98a` | mergeable / passed / resolved |
| Neutral grays | everything healthy & passive: in-review, idle, done, metadata |

Diff add/remove green & red are allowed in their literal context (the Changes view).

### Surfaces & lines (dark, cool neutral)
```
--bg        #0a0b0d   (app base)        --card  #15171b (the only bordered surface)
--bg-side   #08090b   (sidebar)         --term  #0c0d10 (terminal / xterm background)
--line      rgba(255,255,255,0.06)      --line-2 rgba(255,255,255,0.10)
--t1 #f4f5f7  --t2 #9ba1aa  --t3 #646a73  --t4 #444951   (text ramp: primary→faint)
```

## Typography

- **UI:** *Schibsted Grotesk* (distinctive grotesk, not Inter/system). The product voice.
- **Machine:** *JetBrains Mono* — branches, IDs, PR numbers, costs, timestamps, terminal.
- **Numerals:** `tabular-nums` wherever numbers appear (counts, costs, token totals).

The split between UI sans (product voice) and mono (machine voice) is itself a
design device — never render chrome in mono.

## Status as one system

A single semantic status spectrum maps to the canonical lifecycle and is used
everywhere (kanban dot, card badge, session topbar pill): `working` (orange,
breathing) · `needs input` (amber) · `CI failed` (red) · `in review` (neutral) ·
`changes requested` (amber) · `mergeable` (green) · `idle` / `done` (neutral).

## Layout patterns

### Fleet board (`kanban.html`)
- **Lead with the fleet, not the terminal.** The home view answers "what are all my
  agents doing?" at a glance.
- **Frameless columns:** lifecycle columns (Working → Needs you → In review → Ready
  to merge) are borderless tinted troughs with a faint *per-column* semantic
  top-glow. The **card is the only bordered surface** — no box-in-box nesting.
- Compact cards: status + id, task title (2-line clamp), branch, one thin footer
  (PR / CI / cost). Done/Terminated collapses at the bottom.

### Session detail (`session.html`)
- **Framed terminal** as a real surface (header + viewport), flush to sidebar/topbar.
  The terminal is a **live xterm.js/PTY** — we do *not* style its content; we only
  set the frame and the xterm.js `theme` object (background, foreground, cursor,
  and a harmonized 16-color ANSI palette tied to these tokens). No separate message
  composer; Claude Code's own input lives inside the terminal.
- **Pluggable inspector rail** (a view slot): **Summary · Changes · Browser**, each a
  registered view; adding more (Logs, Cost, …) is just another entry.
  - *Summary* is ordered by supervision value: **Pull request → Review comments →
    Activity → Overview** (metadata last).
  - *Review comments* surface an **Address** action (soft blue, not a loud CTA) that
    hands the comment — with its `file:line` — to the agent session to fix.
  - *Browser* renders what the agent is viewing (web-preview / Playwright plugin).
- **Topbar:** `‹ Kanban` (back to board) · title + inline branch · status · then
  notifications · **Kill** (trash icon) · **Orchestrator** (blue primary, org-chart icon).

## Iconography & motion
- **Line icons only** (Lucide-style, ~1.6px stroke, `currentColor`). **No emoji.**
- **Motion is minimal & purposeful:** a slow "breathe" pulse on the working dot/cursor.
  CSS-only.

## Relationship to DESIGN.md

This exploration diverges from the current [`DESIGN.md`](../../DESIGN.md) and these
points need a deliberate decision before production:

| Topic | DESIGN.md (current) | This exploration |
|-------|--------------------|------------------|
| Direction | "Warm Terminal" (warm neutrals) | Cool, restrained "mission control" |
| Accent meaning | amber/orange orchestrator CTA | **blue = orchestrator, orange = agents** |
| UI font | Geist Sans | Schibsted Grotesk |
| Display | JetBrains Mono headlines | UI sans headlines; mono reserved for machine data |

Recommendation: reconcile into a single source of truth (update `DESIGN.md` or
formally supersede it) before implementing — don't ship two conflicting systems.
