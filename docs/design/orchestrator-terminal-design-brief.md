# Orchestrator Terminal Page — Design Brief
*Design specification for `/sessions/[orchestrator-id]` (the orchestrator session)*
*Companion to `design-brief.md` (main dashboard) and `session-detail-design-brief.md`.*

---

## Product Context

The orchestrator terminal is the **command center**. While agent session pages show one agent's work, the orchestrator session is the parent — the process that spawns, monitors, and auto-handles all agent sessions.

Users open this page to:
1. Watch the orchestrator's decision-making in real-time ("why did it just spawn a new session?")
2. Issue high-level commands ("spawn sessions for issues 299–305")
3. Debug orchestrator-level problems (config errors, plugin failures, connectivity issues)
4. Get a "god view" — see the state of all sessions from the orchestrator's perspective

**Key distinction from agent session pages**: There is no PR, no CI, no code review. The orchestrator manages processes, not code. The terminal is 100% of the content payload. Everything else is context scaffolding.

**User profile**: Senior engineer or CTO who has already built fluency with the dashboard. The orchestrator terminal is a power-user surface. It can lean into density and technical detail.

---

## Layout Architecture

The orchestrator terminal page should diverge from the generic session detail layout. It needs two things the agent session page does not:

1. **A status strip** — a compact real-time summary of what the orchestrator is managing (session counts by zone). This replaces the PR Card entirely.
2. **A command history / quick actions strip** — recent orchestrator commands and one-click shortcuts.

```
┌─ Nav bar ───────────────────────────────────────────────────────────────┐
│  ← Agent Orchestrator                                     orchestrator  │
└─────────────────────────────────────────────────────────────────────────┘

┌─ Status strip ──────────────────────────────────────────────────────────┐
│  3 merge-ready   2 needs-response   12 working   4 done                 │
│  ao-orchestrator  ● Active  ·  Uptime: 2h 14m                          │
└─────────────────────────────────────────────────────────────────────────┘

┌─ Terminal (fills remaining height) ─────────────────────────────────────┐
│ ┌─────────────────────────────────────────────────────────────────────┐ │
│ │ ● ao-orchestrator  Connected  XDA              [↕ fullscreen]       │ │
│ │─────────────────────────────────────────────────────────────────────│ │
│ │                                                                     │ │
│ │  [Orchestrator] Spawning session for issue #299...                  │ │
│ │  [Orchestrator] Session ao-62 created.                              │ │
│ │  [Orchestrator] Checking CI for ao-58: failing (2 checks)          │ │
│ │  [Orchestrator] Sent fix-ci message to ao-58.                      │ │
│ │                                                                     │ │
│ └─────────────────────────────────────────────────────────────────────┘ │
└─────────────────────────────────────────────────────────────────────────┘
```

**Height distribution**: Nav 40px · Status strip ~64px · Terminal fills `calc(100vh - 104px)`. The terminal is the dominant surface. No scrolling below the fold.

---

## Visual Differentiation from Agent Pages

The orchestrator page must be visually distinct so users always know which "level" they're on. Three signals achieve this without new components:

1. **Accent color shift**: Agent pages use `--accent` blue (`#5B7EF8`) for interactive elements. The orchestrator page uses **indigo/violet** (`#7070FF` — Linear's brand color, which happens to match our `--accent-violet: #a371f7` range). This signals "orchestrator = control layer, not work layer."

2. **Nav label**: The "orchestrator" label persists in the nav bar (right-aligned). Always visible even in fullscreen-adjacent states.

3. **Terminal chrome**: Instead of the session ID `ao-62`, the orchestrator chrome shows `ao-orchestrator` in a different color — `--accent-violet` instead of the default `--text-muted`.

These three changes are purely visual and require no structural changes to shared components.

---

## Component Designs

### Navigation Bar

Same as session detail bar, plus a persistent right-side label:

```
← Agent Orchestrator                                    [orchestrator]
```

```css
.nav-orchestrator-badge {
  font: 11px/1 "Inter Variable" 500;
  letter-spacing: 0.04em;
  color: var(--accent-violet);   /* #a371f7 */
  padding: 2px 8px;
  border-radius: 4px;
  background: rgba(163, 113, 247, 0.08);
  border: 1px solid rgba(163, 113, 247, 0.15);
}
```

---

### Status Strip

A compact horizontal summary bar. Reads left-to-right by urgency (mirrors dashboard zone order).

```
[3 merge-ready]  [2 responding]  [12 working]  [4 done]  ─────  ao-orchestrator  ● Active  ·  2h 14m
```

```css
.orchestrator-status-strip {
  display: flex;
  align-items: center;
  gap: 16px;
  padding: 10px 32px;
  background: var(--bg-surface);
  border-bottom: 1px solid var(--border-subtle);
  font-size: 12px;
}

.status-count {
  display: flex;
  align-items: baseline;
  gap: 4px;
}
.status-count__value {
  font-weight: 600;
  font-size: 15px;
}
.status-count__label {
  color: var(--text-secondary);
  font-size: 11px;
}

/* Colors match dashboard zone colors */
.status-count--merge    { color: var(--status-ready); }      /* green */
.status-count--respond  { color: var(--status-error); }      /* red */
.status-count--working  { color: var(--accent); }            /* blue */
.status-count--done     { color: var(--text-tertiary); }     /* dim */
```

Right side of the strip shows session identity and uptime:
```css
.orchestrator-identity {
  margin-left: auto;
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 11px;
  color: var(--text-muted);
}
/* "ao-orchestrator" in --font-mono */
/* Activity dot: same 8px CSS dot as elsewhere */
/* Uptime: computed from session.createdAt */
```

**Data sourcing**: The status counts come from the sessions API (already available on the page since the page loads session data). Uptime is `Date.now() - session.createdAt`. No new API calls required.

---

### Terminal Panel

The terminal takes all remaining height. The orchestrator should feel like a true terminal emulator, not an embedded panel.

**Height**: `calc(100vh - 104px)` (full viewport minus nav + status strip). Never a fixed `600px` on this page.

**Terminal theme** — same as session detail recommendation, but with the cursor in `--accent-violet` instead of `--accent` blue, reinforcing the orchestrator identity:

```typescript
theme: {
  background: "#0A0A0F",
  foreground: "#D4D4D8",
  cursor: "#a371f7",           // violet: orchestrator identity signal
  cursorAccent: "#0A0A0F",
  selection: "rgba(163, 113, 247, 0.25)",
  fontSize: 13,
  fontFamily: '"JetBrains Mono", "SF Mono", Menlo, Monaco, monospace',
}
```

**Terminal chrome bar** (the header bar with connection status):
```
[● violet]  ao-orchestrator  Connected  XDA              [↕ fullscreen]
```

The session ID `ao-orchestrator` is displayed in `--accent-violet` instead of `--text-muted` to maintain the identity signal. All other chrome elements same as `DirectTerminal.tsx`.

**Log coloring** (aspirational — requires orchestrator to emit structured ANSI output):

If the orchestrator emits ANSI escape codes, the terminal will naturally show color-coded output. Even without ANSI, xterm.js renders the raw terminal faithfully. No special handling needed in the UI layer.

Structured orchestrator log prefix pattern (for the orchestrator to implement, not the UI):
```
\e[35m[Orchestrator]\e[0m Spawning session for issue #299...   (violet prefix)
\e[32m[ao-62]\e[0m Session created on branch feat/issue-299    (green for new)
\e[33m[ao-58]\e[0m CI failing — 2 checks                       (amber for issues)
\e[31m[ao-45]\e[0m Crashed — activity: exited                  (red for errors)
```

---

## Fullscreen Mode

In fullscreen:
- Nav bar and status strip both hide (fixed position inset-0)
- Terminal takes full viewport
- A minimal overlay in the top-right corner maintains context:

```
                                     [ao-orchestrator] [● Active] [exit fullscreen]
```

```css
.fullscreen-overlay {
  position: fixed;
  top: 8px;
  right: 12px;
  z-index: 100;
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 4px 10px;
  background: rgba(20, 20, 25, 0.85);
  backdrop-filter: blur(4px);
  border-radius: 6px;
  border: 1px solid var(--border-subtle);
  font-size: 11px;
}
```

This is a small additive change to `DirectTerminal.tsx` — pass an optional `overlayContent` prop or a specialized `OrchestratorTerminal` wrapper component.

---

## Implementation Strategy

The orchestrator terminal currently renders as a standard `SessionDetail` page (same component, orchestrator has no PR so the PR card is absent). The terminal itself is identical.

**Option A — Minimal differentiation** (recommended for v1):
- Detect orchestrator session in `page.tsx` by `id.endsWith("-orchestrator")`
- Pass a prop `isOrchestrator={true}` to `SessionDetail`
- `SessionDetail` conditionally renders the status strip + nav badge + violet terminal theme
- No new components, no routing changes

**Option B — Dedicated page** (better for v2):
- Create `app/orchestrator/page.tsx` and `components/OrchestratorTerminal.tsx`
- Cleaner separation, allows orchestrator-specific features (command history, session shortcuts) without polluting `SessionDetail`

**Option A is sufficient for design parity.** Option B becomes worthwhile when orchestrator-specific features (command shortcuts, live session list in sidebar) are added.

---

## Current Implementation Audit

### What exists

- `SessionDetail` component handles no-PR state correctly (PR card is absent, terminal is the full content) ✅
- `DirectTerminal` handles fullscreen, XDA clipboard, responsive sizing ✅
- The dashboard links to `/sessions/${orchestratorId}` (from `Dashboard.tsx` L93) ✅
- Session polling every 5s keeps activity state current ✅

### What's missing

| Gap | Description | Priority |
|-----|-------------|----------|
| Visual identity | No distinction between orchestrator and agent session pages | High |
| Status strip | No live session count summary on the orchestrator page | High |
| Nav badge | No persistent "orchestrator" label in nav | Medium |
| Terminal height | Fixed `600px` instead of filling viewport | Medium |
| Terminal theme | Generic xterm black instead of brand-differentiated theme | Medium |
| Violet cursor | Cursor not differentiated from agent sessions | Low |
| Fullscreen overlay | No context overlay in fullscreen mode | Low |

### Design deltas (priority order)

| Priority | Change | File | Notes |
|----------|--------|------|-------|
| 1 | Detect orchestrator + pass `isOrchestrator` prop | `packages/web/src/app/page.tsx`, `SessionDetail.tsx` | Enables all other changes |
| 2 | Status strip: session counts by zone | `SessionDetail.tsx` (conditional) or new `OrchestratorStatus.tsx` | Main UX differentiation |
| 3 | Terminal height: `calc(100vh - 104px)` | `DirectTerminal.tsx` or wrapper | Full-viewport terminal |
| 4 | Nav badge: "orchestrator" pill | `SessionDetail.tsx` nav | Identity signal |
| 5 | Terminal theme: violet cursor + `#0A0A0F` bg | `DirectTerminal.tsx` (via `theme` prop) | Identity + quality |
| 6 | Fullscreen overlay with context | `DirectTerminal.tsx` (via `overlayContent` prop) | Fullscreen UX |

---

## Shared Design System Reference

All three pages share the same design tokens. Use the token names from the main design brief:

| Token | Value | Usage here |
|-------|-------|-----------|
| `--bg-base` | `#0C0C11` | Page background |
| `--bg-surface` | `#141419` | Nav bar, status strip |
| `--bg-elevated` | `#1C1C25` | Terminal chrome bar |
| `--accent` | `#5B7EF8` | Agent session links, focus rings |
| `--accent-violet` | `#a371f7` | Orchestrator identity color |
| `--status-ready` | `#22C55E` | Merge-ready count |
| `--status-error` | `#EF4444` | Respond-needed count, crashes |
| `--font-mono` | JetBrains Mono | Terminal, session IDs, branch names |

---

*Companion document to `design-brief.md` and `session-detail-design-brief.md`.*
*Compiled February 2026.*
