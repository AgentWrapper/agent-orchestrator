# Agent Orchestrator Dashboard — Design Brief

_Research-backed design specification for the ao dashboard_
_Version 2 — Updated with Playwright CSS extraction from live sites_

---

## Product Context

The Agent Orchestrator dashboard is **mission control for parallel AI coding agents**. Users are senior engineers and CTOs who routinely spawn 10–30 agents at once and need to:

1. Triage at a glance (who needs me right now?)
2. Merge PRs that are ready
3. Intervene on blocked or stuck agents
4. Understand what each agent is doing without attaching to it

Primary interaction model: **scan → identify → act**. Not explore, not browse. The interface must surface actionable items immediately and suppress noise. Speed and density beat friendliness. This is closer to Grafana or an APM dashboard than to a product onboarding flow.

---

## 1. Competitive Visual Analysis

### Linear (linear.app) — **Ground truth via CSS extraction**

_Playwright was used to extract exact token values from the live site. See `screenshots/linear-homepage.png`._

**Verified color palette:**

- Body background: `rgb(8, 9, 10)` → `#08090A` — near-pure black with imperceptible warm cast
- Product panel background: `#0F1011` (CSS token `--color-bg-panel`)
- Marketing background: `#010102` (CSS token `--color-bg-marketing`)
- Brand accent / link color: `#7070FF` (CSS token `--color-accent`, `--color-brand-bg`)
- Focus ring: `#5E6AD2` (CSS token `--color-indigo`)

**Verified semantic status colors:**

```
--color-blue:   #4EA7FC  (informational, active)
--color-red:    #EB5757  (error, critical)
--color-green:  #27A644  (success, done)
--color-orange: #FC7840  (warning, medium priority)
--color-yellow: #F0BF00  (caution, low priority)
--color-teal:   #00B8CC  (informational variant)
--color-indigo: #5E6AD2  (brand, focus ring)
```

**Verified typography:**

- UI font: `"Inter Variable"` with `"SF Pro Display"` fallback
- **Monospace: `"Berkeley Mono"`** — a premium licensed monospace, not JetBrains Mono as commonly assumed. Fallback: `"SFMono Regular"`, `Consolas`, `Menlo`
- Display/serif: `"Tiempos Headline"` — premium editorial serif (used sparingly for marketing copy)
- Font weights (non-standard variable font values): light=300, normal=400, **medium=510**, **semibold=590**, bold=680

**Verified type scale:**

```
--text-tiny-size:    0.625rem  = 10px
--text-micro-size:   0.75rem   = 12px
--text-mini-size:    0.8125rem = 13px
--text-small-size:   0.875rem  = 14px
--text-regular-size: 0.9375rem = 15px
--text-large-size:   1.0625rem = 17px
```

**Letter spacing:** Negative tracking at most sizes (−0.010em to −0.013em for body/mini). Titles use −0.022em at large sizes.

**Verified spacing/radius:**

```
--radius-4:  4px   (inputs, small badges)
--radius-6:  6px   (buttons, cards)
--radius-8:  8px   (modals, panels)
--radius-12: 12px  (larger surfaces)
--radius-16: 16px  (overlays)
```

**Verified transitions:**

```
--speed-quickTransition:   0.1s
--speed-regularTransition: 0.25s
```

**Shadows:** Zero visible shadows in dark mode (all `--shadow-*` = `var(--shadow-none)` on dark backgrounds). Elevation is purely background-based.

**Scrollbar:** `rgba(255,255,255,0.1)` at rest → `rgba(255,255,255,0.2)` hover → `rgba(255,255,255,0.4)` active. 6px width, 10px on hover.

**Tone**: Engineered restraint. Everything earns its place.

---

### Railway (railway.app) — **Visually analyzed via screenshot**

_See `screenshots/railway-homepage.png`._

**Visual palette observations:**

- Background (hero): Dark desaturated blue-purple, approximately `hsl(250, 24%, 9%)` ≈ `#13111C`
- App UI panel (visible in screenshot): Dark surface, same purple-tinted dark family
- CTA "Deploy" button: Solid purple, approximately `#7C3AED` (Tailwind `purple-600`)
- Navigation background: Near-black with slight purple tint
- Tab text (active): White. Inactive: muted gray.
- Announcement banner: Dark purple/indigo gradient

**Visual typography observations:**

- Font appears to be Inter (very clean, standard weight interpolation)
- Navigation uses medium weight (~500)
- Body copy uses regular weight (400)

**Key visual identity:**

- The purple-tinted dark is _not_ the same as WandB's neutral charcoal or Linear's near-black. It has a visible chromatic quality — a cool indigo cast that reads immediately.
- The "Deploy →" CTA is the most vibrant element on the page — solid purple, high contrast.

---

### Vercel, Inngest, WandB, LangSmith, Grafana — Prior Research

_(Based on detailed text analysis from earlier research agents — see `competitive-analysis-raw.md`)_

**Vercel**: `#000000` pure black. Geist + Geist Mono (proprietary). Zero saturation, zero compromise.

**Inngest**: Stone-950 `#0A0A0A` warm black. Amber `#CBB26A`. Whyte + Circular fonts. The warmest palette in the group.

**WandB**: `#1A1C1F` charcoal. Cyan `#00AFC2` accent. Source Serif 4 headings (unique). Yellow-gold CTAs (`#FFCC33→#FFAD33`). Explicit `1px solid #34373C` card borders.

**LangSmith**: `#030710` near-black with blue cast. Electric blue `#4D65FF`. JetBrains Mono as primary font — the only site to use monospace as the main UI font.

**Grafana**: The outlier — white background. Orange `#F46800` brand. OSS pragmatism aesthetic.

---

## 2. Design Direction

### Philosophy

**Mission control, not social feed.** The ao dashboard should feel like a fighter pilot's HUD — dense, high-contrast, every element load-bearing. Visual analogues: Vercel deployment list discipline + Grafana panel density + LangSmith trace density + Linear state dot pattern.

**Dark mode native.** Not dark mode as a feature — dark mode as the only mode designed with conviction.

**Color = signal, not decoration.** Every chromatic element is semantic. Outside status colors, the palette is near-monochrome. This maximizes the signal-to-noise ratio of status indicators.

---

### Color Palette

Inspired by Linear's `#08090A` and Railway's purple-tinted dark, but finding its own position: **a very dark blue-black** that reads as technical/precise without being as stark as Vercel's pure black.

#### Base Palette

| Token              | Hex       | RGB      | Usage                                |
| ------------------ | --------- | -------- | ------------------------------------ |
| `--bg-base`        | `#0C0C11` | 12,12,17 | Page/app background                  |
| `--bg-surface`     | `#141419` | 20,20,25 | Card backgrounds                     |
| `--bg-elevated`    | `#1C1C25` | 28,28,37 | Hover states, terminal bg, dropdowns |
| `--bg-subtle`      | `#23232F` | 35,35,47 | Input backgrounds, code blocks       |
| `--border-subtle`  | `#22222E` | 34,34,46 | Lowest-visibility borders            |
| `--border-default` | `#2E2E3E` | 46,46,62 | Standard card borders                |
| `--border-strong`  | `#3E3E52` | 62,62,82 | Focus rings, active borders          |

_The blue tint is subtle (~hue 250, saturation ~12%) — enough to read as "technical" rather than "warm", but not as loud as Railway's purple._

#### Text Hierarchy

Modeled on Linear's verified 4-tier system:

| Token              | Hex       | Usage                               |
| ------------------ | --------- | ----------------------------------- |
| `--text-primary`   | `#EEEEF5` | Main content, titles, session names |
| `--text-secondary` | `#8888A6` | Metadata, timestamps, labels        |
| `--text-tertiary`  | `#50506A` | Disabled, de-emphasized             |
| `--text-inverse`   | `#0C0C11` | Text on solid-colored buttons       |

_Slight blue tint (`EEEEF5` not `EEEEEE`) harmonizes with the blue-cast background._

#### Status Colors — Semantic only, never decorative

| Token                | Hex       | State                              | Notes                   |
| -------------------- | --------- | ---------------------------------- | ----------------------- |
| `--status-working`   | `#5B7EF8` | Agent actively running             | Animated pulse          |
| `--status-ready`     | `#22C55E` | Needs merge / human to act         | Highest priority signal |
| `--status-attention` | `#F59E0B` | Blocked, CI failing, review needed | Action required         |
| `--status-idle`      | `#6B6B8A` | Agent idle/paused                  | Low visual weight       |
| `--status-done`      | `#3E3E54` | Session complete                   | Visually recedes        |
| `--status-error`     | `#EF4444` | Crash, hard failure                | Urgent                  |

_Note: Linear uses `#27A644` for green, `#EB5757` for red, `#F0BF00` for yellow. ao's status palette is aligned but not identical._

#### Interactive Accent

| Token             | Hex                     | Usage                                         |
| ----------------- | ----------------------- | --------------------------------------------- |
| `--accent`        | `#5B7EF8`               | Links, focus rings, active nav, working state |
| `--accent-hover`  | `#7B9CFB`               | Hover state                                   |
| `--accent-subtle` | `rgba(91,126,248,0.12)` | Highlight backgrounds                         |

_Derived from Linear's `#4EA7FC` blue + their `#7070FF` brand purple — splitting the difference at a mid-blue-purple that works for both "active" and "interactive" semantic meanings._

#### Surface Elevation System

Uses background stepping (verified from Linear's approach — no shadows in dark mode):

```
Page:      #0C0C11  (L ≈ 5%)
Surface:   #141419  (L ≈ 8%)   ← cards, panels
Elevated:  #1C1C25  (L ≈ 12%)  ← hovers, dropdowns, terminals
Subtle:    #23232F  (L ≈ 15%)  ← inputs, inline code
```

---

### Typography

#### Font Stack

```css
/* UI — all prose, labels, body */
font-family:
  "Inter Variable",
  "SF Pro Display",
  -apple-system,
  system-ui,
  sans-serif;

/* Monospace — branch names, session IDs, terminals, all machine-produced data */
font-family: "Berkeley Mono", "JetBrains Mono", "SF Mono", Menlo, monospace;
```

**Primary recommendation: use `Inter Variable`** — universally available, verified in use by Linear and Supabase (both best-in-class developer dashboards). If budget permits a premium license, `Berkeley Mono` for monospace matches Linear's actual stack.

**Alternative monospace**: JetBrains Mono (free, used by LangSmith) — excellent fallback with strong developer tool credibility.

#### Type Scale

Directly derived from Linear's verified CSS token system:

| Name      | Size (rem) | Size (px) | Weight  | Usage                                      |
| --------- | ---------- | --------- | ------- | ------------------------------------------ |
| `tiny`    | 0.625rem   | 10px      | 500     | Zone headers (uppercase, +0.10em tracking) |
| `micro`   | 0.75rem    | 12px      | 400     | Timestamps, secondary metadata (mono)      |
| `mini`    | 0.8125rem  | 13px      | 400–500 | Status badges, card metadata rows          |
| `small`   | 0.875rem   | 14px      | 500     | Card titles, primary labels                |
| `regular` | 0.9375rem  | 15px      | 400     | Body copy within panels                    |
| `large`   | 1.0625rem  | 17px      | 600     | Section headings, zone names               |

**Letter spacing**: −0.010em to −0.013em for body/mini (matches Linear's verified values). Uppercase zone labels use +0.10em.

**Font weights (non-standard for Inter Variable)**:

- Regular: 400
- Medium: 500 (or 510 per Linear's precise variable-font value)
- Semibold: 590
- Bold: 680

---

### Component Style

**No drop shadows** — verified from Linear's CSS: all `--shadow-*` values resolve to `var(--shadow-none)` on dark backgrounds. Elevation is exclusively via background color stepping.

**1px explicit borders** (`--border-default: #2E2E3E`) on cards — verified from WandB's `1px solid #34373C` approach. Border-based cards, not shadow-based.

**Border-radius**: 6px for cards (Linear's `--radius-6`). 4px for badges and inputs (`--radius-4`). 8px for modals/dropdowns (`--radius-8`).

**Transitions**: `0.1s` for quick (hover states). `0.25s` for regular (state changes). Matches Linear's `--speed-quickTransition` and `--speed-regularTransition`.

---

### Density

**Target**: 6–8 session cards visible without scrolling in the "Working" zone at 1440px.

- Card height: ~156px compact / ~200px expanded
- Card width: `minmax(260px, 1fr)` — 3 columns at 1280px, 4 at 1920px
- Grid gap: 12px
- Zone header: 32px
- Page margin: 20px

This density is closer to Grafana than to Linear. The ao dashboard with 30 agents is a monitoring tool, not a project management tool.

---

### Animation and Motion

**One continuous animation only**: the working-state activity dot pulse. Everything else is triggered by state change.

```css
@keyframes activity-pulse {
  0%,
  100% {
    box-shadow: 0 0 0 0 rgba(91, 126, 248, 0.4);
  }
  50% {
    box-shadow: 0 0 0 4px rgba(91, 126, 248, 0);
  }
}

/* Matches Linear's --speed-regularTransition */
transition:
  background-color 250ms ease,
  border-color 250ms ease,
  color 250ms ease;
```

| Element            | Animation                 | Duration             |
| ------------------ | ------------------------- | -------------------- |
| Working dot        | Ring pulse (box-shadow)   | 2s infinite          |
| CI pending         | Spinner rotation          | 1.5s linear infinite |
| Card state change  | bg + border color         | 250ms ease           |
| New card appear    | Fade + 4px slide up       | 150ms ease-out       |
| Card removal       | Fade out                  | 200ms ease-in        |
| Terminal expand    | Height (overflow: hidden) | 200ms ease           |
| Merge button hover | translateY(−1px)          | 100ms ease           |

---

### Iconography

**Lucide Icons** — the shadcn/ui default. 2px stroke weight, clean geometric forms. Pick one library and commit.

| Semantic        | Icon                     |
| --------------- | ------------------------ |
| Working state   | Custom CSS dot (not SVG) |
| CI passing      | `CheckCircle2`           |
| CI failing      | `XCircle`                |
| CI running      | `Loader2` (animated)     |
| Branch          | `GitBranch`              |
| PR              | `GitPullRequest`         |
| Merge           | `GitMerge`               |
| Review comment  | `MessageSquare`          |
| Terminal        | `Terminal`               |
| Alert/attention | `AlertTriangle`          |

---

## 3. Component Designs

### Session Card

The primary unit. Each card = one agent session.

**Anatomy:**

```
┌─ 3px status strip ──────────────────────────────────────┐
│                                                          │
│  ● working    session/ao-58                    [···]    │  ← 10px dot + 11px mono ID + menu
│                                                          │
│  Implement UI/UX research dashboard                      │  ← 14px/500 ticket title (2 lines max)
│  GitHub #58                                             │  ← 11px tertiary tracker ref
│                                                          │
│  ⎇ session/ao-58                      ↑ PR #104        │  ← 11px mono branch + PR link
│                                                          │
│  ✓ CI passing    ✓ Approved    3m ago                   │  ← 11px badges + timestamp
│                                                          │
│  [  Terminal  ]                  [ Merge PR → ]         │  ← actions (conditional row)
│                                                          │
└──────────────────────────────────────────────────────────┘
```

**Visual spec:**

- Background: `--bg-surface` (`#141419`)
- Border: `1px solid --border-default` (`#2E2E3E`)
- Border-radius: `6px` (Linear's `--radius-6`)
- Padding: `12px 14px`
- Left status strip: `3px` wide, full height, color = zone's status color
- Shadow: none (Linear-verified: no shadows in dark mode)

**State variants** (tinted border + very subtle tinted background for scanability):

| State           | Strip     | Border                 | Background tint         |
| --------------- | --------- | ---------------------- | ----------------------- |
| Working         | `#5B7EF8` | default                | none                    |
| Needs Merge     | `#22C55E` | `rgba(34,197,94,0.2)`  | `rgba(34,197,94,0.03)`  |
| Needs Attention | `#F59E0B` | `rgba(245,158,11,0.2)` | `rgba(245,158,11,0.03)` |
| Error           | `#EF4444` | `rgba(239,68,68,0.2)`  | `rgba(239,68,68,0.03)`  |
| Done            | `#3E3E54` | `--border-subtle`      | `--bg-base` (recedes)   |

---

### Activity Indicator

8×8px CSS circle (not SVG — simpler, no scaling artifacts).

```css
/* Working — the only continuous animation */
.dot--working {
  background: #5b7ef8;
  animation: activity-pulse 2s ease-in-out infinite;
}

/* States */
.dot--ready {
  background: #22c55e;
} /* static — green is enough */
.dot--attention {
  background: #f59e0b;
} /* static */
.dot--idle {
  background: #6b6b8a;
} /* dim, static */
.dot--error {
  background: #ef4444;
} /* static */
.dot--done {
  background: #3e3e54;
} /* very dim, static */
```

Label alongside dot: 11px Inter 500, same color as dot.

---

### CI Status Badge

Height 20px, padding 0 8px, border-radius 10px (fully rounded pill).

| State   | Background               | Text      | Icon                     |
| ------- | ------------------------ | --------- | ------------------------ |
| Passing | `rgba(34,197,94,0.12)`   | `#22C55E` | `CheckCircle2` 12px      |
| Failing | `rgba(239,68,68,0.12)`   | `#EF4444` | `XCircle` 12px           |
| Running | `rgba(91,126,248,0.12)`  | `#5B7EF8` | `Loader2` 12px, spinning |
| Queued  | `rgba(245,158,11,0.12)`  | `#F59E0B` | `Clock` 12px             |
| Skipped | `rgba(107,107,138,0.12)` | `#6B6B8A` | `Minus` 12px             |

Text: always present (never icon-only). 11px Inter 500. "Passing" / "Failing" / "Running".

Multiple jobs: show worst-state badge. Hover expands to popover with all job names.

---

### PR Merge Button

The highest-priority action. When ready, must visually dominate the card.

**Ready:**

```css
background: #22c55e;
color: #0c0c11; /* dark text on green */
height: 28px;
padding: 0 12px;
border-radius: 6px; /* Linear's --radius-6 */
font: 12px/1 "Inter Variable" 600;
/* icon: GitMerge 14px left of "Merge PR" label */
transition:
  transform 100ms ease,
  filter 100ms ease;
&:hover {
  transform: translateY(-1px);
  filter: brightness(1.05);
}
```

**Blocked — CI/review:**

```css
background: #1c1c25;
color: #50506a;
border: 1px solid #2e2e3e;
cursor: not-allowed;
/* tooltip explains why */
```

**Conflicts:**

```css
background: rgba(239, 68, 68, 0.12);
color: #ef4444;
border: 1px solid rgba(239, 68, 68, 0.3);
label: "Conflicts";
```

**After merge (optimistic):**

```css
background: rgba(34, 197, 94, 0.12);
color: #22c55e;
label: "Merged ✓";
```

One click, no confirmation modal. Merging a reviewed PR is the goal state — friction is the enemy.

---

### Terminal Panel

**Location**: Right-side drawer (preferred — doesn't reflow the 30-card grid).

```
Width:    480px or 40vw (whichever larger)
Slide in: transform translateX(100%) → translateX(0), 200ms ease
Backdrop: rgba(0,0,0,0.4)
```

**Terminal area:**

```css
background: #0a0a0f; /* deeper than card surface */
font:
  13px/1.5 "Berkeley Mono",
  "JetBrains Mono",
  Menlo,
  monospace;
color: #d4d4d8; /* standard terminal foreground */
/* cursor: block, #5B7EF8 — brand blue distinguishes from content */
padding: 12px 16px;
scrollbar-width: 4px;
scrollbar-color: rgba(255, 255, 255, 0.1) transparent;
```

**Log format**: `timestamp` in `--text-tertiary` · content in `--text-primary`. Orchestrator-injected messages shown in `rgba(91,126,248,0.2)` highlight.

---

### Attention Zone Headers

5 zones ordered by priority (top to bottom):

1. **Needs Merge** — PRs approved + CI passing
2. **Needs Response** — review comments, CI failures, conflicts
3. **Working** — agents running fine
4. **Idle** — agents paused/inactive
5. **Done** — completed, ready for cleanup

**Header anatomy:**

```
[●] NEEDS MERGE  ─────────────────────────────  [3]
 ↑               ↑                               ↑
 8px dot    flex-1 1px border-subtle         count pill
```

```css
.zone-header {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 0;
  margin: 20px 0 12px;
}
.zone-label {
  font: 10px/1 "Inter Variable" 600;
  letter-spacing: 0.1em;
  text-transform: uppercase;
  /* color: zone's status color */
}
.zone-divider {
  flex: 1;
  height: 1px;
  background: var(--border-subtle);
}
.zone-count {
  font: 11px/1 "Inter Variable" 500;
  padding: 2px 7px;
  border-radius: 10px;
  /* background + color: zone's status color at 12% opacity */
}
```

| Zone           | Color     | Empty behavior       |
| -------------- | --------- | -------------------- |
| Needs Merge    | `#22C55E` | Collapse entirely    |
| Needs Response | `#F59E0B` | Collapse entirely    |
| Working        | `#5B7EF8` | Collapse if zero     |
| Idle           | `#6B6B8A` | Collapse by default  |
| Done           | `#3E3E54` | Collapsed by default |

---

## 4. Inspiration References

### Linear issue list — _the_ density benchmark

**URL**: https://linear.app (see `screenshots/linear-homepage.png`)
**Why**: The product UI visible in Linear's homepage hero screenshot shows exactly the information density and row compactness that ao session cards should match. Issue ID in muted monospace, title truncated, labels as small pill badges, state dot left-aligned. Zero wasted pixels.

### Vercel deployment list

**URL**: https://vercel.com/dashboard
**Why**: Each deployment row = name (mono) + status dot + branch + timestamp. The status dot on a near-black background carries the full state signal with nothing competing. This is the right level of restraint for ao's done/idle sessions.

### GitHub Actions job graph

**URL**: https://docs.github.com/en/actions/writing-workflows/quickstart
**Why**: Status-colored nodes (green pass, red fail, gray skip, amber running) in a dependency graph. The best existing model for "pipeline state at a glance." The icon+color combination for each step is directly applicable to ao's CI status display.

### Grafana panel layout — density reference

**URL**: https://grafana.com/grafana/dashboards
**Why**: Demonstrates that 30+ data panels in one viewport is possible — when organized by visual weight, semantic color, and zone separation. The panel border system (1px subtle border, consistent padding, consistent label typography) is the right density model for ao's session card grid.

### GitHub Copilot agent mode in VS Code

**URL**: https://code.visualstudio.com/blogs/2025/02/24/introducing-copilot-agent-mode
**Why**: Sequential labeled tool invocations ("Analyzing files... Running tests... Proposing edits...") is the right model for ao's terminal activity feed — transparent step disclosure rather than raw log dump. Each step collapsible. Makes AI activity _legible_ rather than just _visible_.

---

## 5. What to Avoid

### Anti-patterns for this product specifically

**1. Spacious card proportions** — ao has 30 sessions. Linear/Notion card sizes assume 1 project per screen.

**2. Status color overloading** — Define strict semantic rules. Amber = "needs human attention." Green = "positive outcome / merge-ready." Red = "error/failure." Never use the same color for two different meanings.

**3. Badge spam** — Show only badges that diverge from the happy path. CI passing = expected = no badge. CI failing = show badge. If everything is highlighted, nothing is.

**4. Modal confirmation for merge** — Pre-approved PRs are the goal state. One click. Destructive actions (kill session, delete worktree) use confirmation. Merge does not.

**5. Wide sidebar** — A 240px sidebar wastes 240px of card grid space. Use a 48px icon rail or a 32px top bar.

**6. Light mode as design authority** — Design dark first. If you design light first you get light-mode thinking applied to dark backgrounds.

**7. Competing animations** — One continuous animation (working dot pulse). Everything else is state-change triggered.

**8. Full-width single-column** — 30 sessions in a single column is 5 viewports tall. Grid layout is mandatory.

**9. Burying the terminal** — Terminal is a primary debugging surface. One click from any session card.

**10. Generic icon library mixing** — Pick Lucide or Heroicons. Use it everywhere. One icon per semantic concept.

**11. Done sessions at full visual weight** — Done cards must visually recede (dim colors, collapsed by default). The eye should skip them automatically.

**12. Conflating activity state and attention state** — These are separate dimensions. A working agent can need response (CI failing). An idle agent can be merge-ready. Show both independently: left strip = attention state, dot = activity state.

---

## 6. Implementation Stack Recommendation

**Frontend**: Next.js 15 (App Router) + Tailwind CSS 4 + shadcn/ui (Radix UI primitives)

- Matches ao's existing stack
- Used by Supabase at scale — validated for serious developer tooling

**Design tokens**: CSS custom properties on `:root`. All colors defined as tokens, not Tailwind classes directly. Enables runtime theming and makes the semantic system enforceable.

**Terminal**: xterm.js + `@xterm/addon-fit`. Dark theme with the color system above.

**Real-time**: Server-Sent Events (existing in ao's architecture). State transitions animate via CSS transition (250ms ease).

**Icons**: `lucide-react` (npm package, tree-shakeable). Same package used by shadcn/ui components.

**Accessibility**: Status indicators never rely on color alone — always paired with text label or icon. Focus rings use `--accent` at 2px offset. Tab order follows visual reading order.

---

## 7. Current Implementation Audit

_Added after reading the actual `packages/web/` codebase. Maps recommendations to real files._

### Existing Component Inventory

| File                                             | Purpose                                                        | Status                                        |
| ------------------------------------------------ | -------------------------------------------------------------- | --------------------------------------------- |
| `packages/web/src/app/globals.css`               | CSS design tokens (`@theme` block)                             | ✅ Token system in place, needs repalette     |
| `packages/web/src/components/Dashboard.tsx`      | Top-level layout: header, stats bar, attention zones, PR table | ✅ Well structured                            |
| `packages/web/src/components/AttentionZone.tsx`  | Zone header + collapsible session list                         | ✅ Functional, visual polish needed           |
| `packages/web/src/components/SessionCard.tsx`    | Primary card unit with left border strip, alerts, expand panel | ✅ Core logic solid, visual refinement needed |
| `packages/web/src/components/CIBadge.tsx`        | CI check status display                                        | ✅ Exists                                     |
| `packages/web/src/components/PRStatus.tsx`       | PR state display + table row                                   | ✅ Exists                                     |
| `packages/web/src/components/DirectTerminal.tsx` | xterm.js + WebSocket terminal (full-page `/sessions/:id`)      | ✅ Fully implemented                          |
| `packages/web/src/lib/types.ts`                  | `DashboardSession`, `AttentionLevel`, `getAttentionLevel()`    | ✅ Well typed                                 |

### Current Color Token System vs. Recommended

`packages/web/src/app/globals.css` uses a **GitHub-inspired palette**. The recommended brief palette is a **blue-cast dark**. Mapping:

| Token                              | Current (GitHub)     | Recommended (Brief)  | Delta                                                            |
| ---------------------------------- | -------------------- | -------------------- | ---------------------------------------------------------------- |
| `--bg-base` / `--color-bg-primary` | `#0d1117` (13,17,23) | `#0C0C11` (12,12,17) | Very close. GitHub has more blue+green, brief more neutral-blue. |
| Surface / `--color-bg-secondary`   | `#161b22` (22,27,34) | `#141419` (20,20,25) | GitHub bluer, brief more neutral. Similar luminance.             |
| Elevated / `--color-bg-tertiary`   | `#1c2128` (28,33,40) | `#1C1C25` (28,28,37) | GitHub bluer.                                                    |
| `--color-border-default`           | `#30363d`            | `#2E2E3E`            | GitHub has green tint, brief is blue-neutral.                    |
| `--color-text-primary`             | `#e6edf3`            | `#EEEEF5`            | GitHub slightly cooler-white; brief slightly warmer.             |
| `--color-text-secondary`           | `#7d8590`            | `#8888A6`            | GitHub gray; brief has slight blue cast.                         |
| Accent blue                        | `#58a6ff`            | `#5B7EF8`            | Brief's blue is shifted toward indigo.                           |
| Green                              | `#3fb950`            | `#22C55E`            | Brief's green is more vibrant/saturated.                         |
| Red                                | `#f85149`            | `#EF4444`            | Very similar.                                                    |
| Yellow                             | `#d29922`            | `#F59E0B`            | Brief is brighter/more saturated.                                |

**Assessment**: The current palette is functional and coherent. The recommended palette shifts from GitHub's blue-green cast to a more neutral blue-indigo cast. Both work; the brief's palette aligns more closely with Linear/LangSmith's positioning than GitHub's.

### Current Typography vs. Recommended

`globals.css` body font:

```css
font-family: -apple-system, BlinkMacSystemFont, "SF Pro", system-ui, sans-serif;
```

`--font-mono`:

```css
--font-mono: "SF Mono", "Menlo", "Consolas", monospace;
```

**Brief recommendation**: `"Inter Variable"` as primary, `"Berkeley Mono"` / `"JetBrains Mono"` as monospace.

**Practical path**:

- Swap body to `"Inter Variable", ...` — load via `next/font/google` (no license cost). This is the highest-impact single change.
- Swap monospace to `"JetBrains Mono", "SF Mono", Menlo, monospace` — JetBrains Mono is free, available via Google Fonts, and widely recognized in developer tooling (LangSmith uses it).
- Berkeley Mono requires a paid license — use as optional upgrade if budget permits.

### Attention Zone: Actual vs. Recommended

**Current `AttentionZone.tsx`** header structure:

```
[ZONE LABEL]  [description text]                    [count pill] [▼]
```

**Brief recommendation:**

```
[●] ZONE LABEL  ─────────────────────────────────────── [count pill]
```

The current implementation adds a description text (e.g., "PRs ready to merge"). This is informative for new users but creates visual clutter at density. The brief's divider-line approach is more compact and scales better with 30+ sessions.

**Collapse behavior**: Current correctly collapses "done" by default and returns `null` when empty — matches brief recommendation.

**6-level zone system** matches brief: `merge → respond → review → pending → working → done`.

### Session Card: Actual vs. Recommended

**What the current card gets right:**

- 3px left border strip colored by attention level ✅
- Left strip color mapped to `borderColorByLevel` record ✅
- Merge-ready: green border highlight + prominent "merge PR #N" button ✅
- Alert badges for CI failures, review requests, conflicts, unresolved comments ✅
- Expandable detail panel with CI checks, unresolved comments, PR diff stats ✅
- Activity icons for each `ActivityState` ✅

**What diverges from brief:**

1. **Activity icons are Unicode emoji** (`⚡`, `🟢`, `💤`, `❓`, `🚧`, `💀`) — brief recommends 8×8px CSS circles with color semantics. Emoji are charmingly informal but inconsistently sized across platforms and don't carry precise color semantics. The CSS dot approach is more precise.

2. **Merge button is translucent** (`rgba(63,185,80,0.2)` bg with `#3fb950` text) — brief recommends solid green (`#22C55E` background, dark text). Solid green for the primary action makes it visually dominate correctly.

3. **Card border-radius is `10px`** (set inline with `style={{ borderRadius: 10 }}`) — brief recommends `6px` (Linear's `--radius-6`). Minor but affects overall tightness.

4. **`confirm()` dialog on merge** — brief explicitly recommends one-click merge without modal. The current `if (!confirm(...))` on line 66 of `Dashboard.tsx` adds friction for the primary happy-path action. Kill/terminate should keep the confirm; merge should not.

5. **Single-column list layout** — cards stack vertically within each zone. Brief recommends a multi-column grid for density. At 30 sessions, single-column requires significant scrolling. Grid at `minmax(300px, 1fr)` with `gap: 12px` would show 3 columns at 1100px viewport, matching brief density target.

### Real-time Updates: Gap

`packages/web/src/lib/types.ts` defines `SSESnapshotEvent` and `SSEActivityEvent` — the SSE contract is designed. However, the dashboard currently fetches data at page load only (server-side, via `page.tsx`). No client-side SSE listener exists.

**Brief recommendation**: SSE subscription on `/api/events` to receive `session.activity` updates and re-render affected cards without full refresh.

**Files to add this to**:

- `packages/web/src/components/Dashboard.tsx` — add `useEffect` with `EventSource` to subscribe to `/api/events`
- On `session.activity` event: update the session in local state and allow CSS transition to reflect new attention level

### Design Deltas Summary (Priority Order)

| Priority | Change                                                       | File                                                           | Impact                                       |
| -------- | ------------------------------------------------------------ | -------------------------------------------------------------- | -------------------------------------------- |
| 1        | Load Inter Variable via `next/font/google`                   | `packages/web/src/app/layout.tsx`                              | Typography lift — biggest visual delta       |
| 2        | Load JetBrains Mono via `next/font/google`                   | `packages/web/src/app/layout.tsx`                              | Monospace consistency                        |
| 3        | Swap `globals.css` color tokens to brief palette             | `packages/web/src/app/globals.css`                             | Color system coherence                       |
| 4        | Merge button: solid green background, no confirm             | `packages/web/src/components/SessionCard.tsx`, `Dashboard.tsx` | Primary action clarity                       |
| 5        | Replace emoji activity icons with CSS dots                   | `packages/web/src/components/SessionCard.tsx`                  | Visual precision, cross-platform consistency |
| 6        | Zone header: divider-line layout instead of description text | `packages/web/src/components/AttentionZone.tsx`                | Density                                      |
| 7        | Multi-column grid for session cards                          | `packages/web/src/components/AttentionZone.tsx`                | Density at scale                             |
| 8        | Card border-radius: 10px → 6px                               | `packages/web/src/components/SessionCard.tsx`                  | Tighter, more Linear-aligned                 |
| 9        | SSE live-reload subscription                                 | `packages/web/src/components/Dashboard.tsx`                    | Real-time updates                            |
| 10       | Right-side drawer for terminal (vs. full-page nav)           | New component or `DirectTerminal.tsx`                          | Workflow: stay in dashboard while monitoring |

---

## Appendix: Raw Research Notes

See `competitive-analysis-raw.md` for full text-based analysis of all 14 competitor sites.
See `screenshots/` for Playwright-captured screenshots of Linear and Railway.

## Companion Documents

All three pages share this token system and theme:

| Document                                | Page                          | Focus                                  |
| --------------------------------------- | ----------------------------- | -------------------------------------- |
| `design-brief.md` (this file)           | `/` — Main dashboard          | Session grid, attention zones, triage  |
| `session-detail-design-brief.md`        | `/sessions/[id]`              | Terminal + PR investigation            |
| `orchestrator-terminal-design-brief.md` | `/sessions/[orchestrator-id]` | Command center, full-viewport terminal |

---

_Design brief v2. Compiled February 2026._
_Research methods: Playwright CSS extraction (Linear), Playwright screenshots (Linear, Railway), text-based web analysis (all others)._
_Codebase audit: Read packages/web/src — globals.css, Dashboard.tsx, SessionCard.tsx, AttentionZone.tsx, types.ts, DirectTerminal.tsx._
_Precision note: Linear color/typography values are verified from live CSS. Railway values are visually estimated from screenshot. All others are from text/HTML analysis._
