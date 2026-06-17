# Agent Orchestrator Dashboard — Design Brief
*Research-backed design specification for the ao dashboard*

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

### Linear (linear.app)
**Palette**: Pure token-based CSS system — near-black in dark mode, warm neutrals. No vibrant accents; status colors (green, red) are the only chromatic moments. Custom property hierarchy goes four levels deep (`--color-text-primary` → `--color-text-quaternary`).
**Typography**: Inter Variable exclusively. Nine-level title scale. `text-micro` (the smallest label) at 9–10px. Body and UI labels use a 6-level named scale: large → regular → small → mini → micro → tiny.
**Density**: Marketing site is airy (128px+ section gaps); the product is tighter. Cards use `rightBottomFade` gradient corners — no drop shadows.
**Status indicators**: Small colored circles — the Linear "state dot" became an industry pattern. Green for done/success, red for blocked/error.
**Tone**: Engineered restraint. Every element earns its place. Nothing decorative.

**Takeaway for ao**: The quaternary text hierarchy and named type scale enable information density without visual chaos. Adopt a similarly granular token system.

---

### Vercel (vercel.com)
**Palette**: Binary extremes — `#000000` in dark mode, `#FAFAFA` in light. Zero saturation. Borders are `rgba(255,255,255,0.08)` — barely visible. Status colors (green = Ready, red = Error, amber = Building) are the only chromatic intrusions.
**Typography**: Geist and Geist Mono — Vercel's proprietary type system. Clear functional split: sans for UI copy, mono for code/deployment names.
**Density**: Very sparse in marketing; the dashboard itself is moderate — deployment list rows are compact with inline status dots.
**Status indicators**: Small colored dots (8–10px) inline with resource names. Unmistakable but minimal.
**Tone**: Austere technical authority. "We don't need color to project confidence."

**Takeaway for ao**: The deployment list row pattern (name + status dot + metadata on one line) is directly applicable to session cards in compact mode. Monochrome discipline keeps status colors maximally signal-to-noise.

---

### Railway (railway.app)
**Palette**: `hsl(250, 24%, 9%)` ≈ `#13111C` — dark desaturated purple-tinted background. Not pure black, not navy. A signature color. Semantic palette: `hsl(152)` green, `hsl(1)` red, `hsl(44)` yellow, `hsl(180)` cyan.
**Typography**: Inter + Inter Tight for UI; JetBrains Mono for code; IBM Plex Serif as an accent. The three-family system ranges from utilitarian to editorial.
**Density**: Moderate. Services presented as visual cards in a grid. Shadow: `0 0 30px hsla(0,0%,30%,.25)` — diffuse ambient glow, not directional.
**Tone**: Playful sophistication. "Ship software peacefully" — the vaporwave easter egg theme reveals a team with personality.

**Takeaway for ao**: The purple-tinted dark base (`#13111C`) is more distinctive than pure black without being loud. Worth considering as the background. The ambient glow shadow on cards is more premium than flat borders.

---

### Fly.io
**Palette**: Deep navy `#0a0e27`. Electric purple/magenta CTAs. High contrast.
**Typography**: Fricolage Grotesque (quirky geometric grotesque) for headlines, Mackinac (warm serif) for body, Fragment Mono for code. The most typographically adventurous stack in the group.
**Tone**: "Fearless confidence." Loud type choices signal that the team has opinions.

**Takeaway for ao**: The adventurous type choice is a lesson about brand identity. ao should pick *one* distinctive typographic decision and commit to it.

---

### Inngest (inngest.com) — workflow orchestration
**Palette**: Stone-950 `#0a0a0a` — warm black (not cool/blue). "Inngest Lux" amber `#CBB26A` as primary accent. Supplementary: green `#2C9B63`, rust `#CB5C32`, purple `#655279`. Stone-400 `rgba(white, 0.1)` for borders.
**Typography**: Whyte + Whyte Inktrap for display; Circular for body. Font investment signals brand maturity.
**Density**: Generous. 80rem max-width, 20–24px padding, 2–3 column grids.
**Cards**: Stone-900 background, top-border accent lines, `rounded-xl` (12px) radius.
**Tone**: Warm enterprise. The stone palette (not cold gray) gives unexpected approachability.

**Takeaway for ao**: The amber accent color for an infrastructure product is distinctive and memorable. Grid background textures at 0.3 opacity add depth without clutter.

---

### Temporal (temporal.io) — workflow orchestration
**Palette**: Deep ultraviolet/indigo backdrop, star-grid hero pattern. Magenta `~#d946ef` CTAs. Green badge for system status.
**Tone**: "Cosmic reliability." Rainbow gradients in testimonial sections break monochrome tension.

**Takeaway for ao**: The star-grid subtle texture on a dark background is a quality signal without being decorative noise.

---

### Grafana — high-density monitoring
**Palette**: White background (counterpoint to the dark-mode consensus). Orange `#F46800` brand. Blue `#0066ff` CTAs.
**Density**: Monitoring tools require extreme density — Grafana panels pack many metrics per square centimeter. Time-series panels, gauge panels, table panels all coexist at density levels that would horrify Linear's designers.
**Tone**: OSS pragmatism. The white background is a deliberate "we are transparent and open" statement.

**Takeaway for ao**: ao should reference Grafana for density targets, not aesthetic. The ao dashboard with 30 sessions needs panel-level density discipline.

---

### Weights & Biases / wandb.ai — ML experiment tracking
**Palette**: `#1A1C1F` charcoal background. `#212429` card surface. `#00AFC2` cyan accent. Yellow-gold gradient CTAs (`#FFCC33` → `#FFAD33`). Borders: `#34373C`. Secondary text: `#ADB0B5`.
**Typography**: Source Serif 4 (headings), Source Sans 3 (body), Source Code Pro (code). The *only* product in this group using a serif for headings — gives academic/research gravitas.
**Cards**: `border-radius: 8–16px`. Explicit `1px solid #34373C` borders. Upward-direction box shadow: `0px -1px 16px rgba(10,14,21,0.5)`.
**Tone**: Scientific gravitas meets ML ambition. Dense, trustworthy, research-credibility.

**Takeaway for ao**: The `#1A1C1F` charcoal with `#34373C` explicit borders is the most production-battle-tested dark card system in this research. The upward shadow (rather than downward) creates a distinctive floating-from-below effect.

---

### LangSmith (smith.langchain.com) — LLM observability
**Palette**: `#030710` near-black with blue cast. Electric blue `#4d65ff` primary interactive. Green checkmarks for success, red icons for failure.
**Typography**: JetBrains Mono as the *primary* font — not relegated to code blocks. This is the most distinctive typographic choice for a developer observability tool.
**Density**: Extremely high. Trace tree on left, detail panel on right. Many rows of data: token counts, latency, inputs, outputs. Progressive disclosure via expandable rows.
**Status system**: Hierarchical run tree with icon-based type indicators (chain icon for chain runs, LLM icon for LLM runs). Green ✓ / red ✗ for success/failure.
**Tone**: Analytical transparency. "Know what your agents are really doing."

**Takeaway for ao**: LangSmith is the closest design analogue to ao — it's a dashboard for understanding AI agent behavior. The hierarchical trace tree, dense row layout, and JetBrains Mono-first typography are all directly relevant. ao is LangSmith for the agent lifecycle rather than the agent's internal trace.

---

### GitHub Copilot Workspace — AI agent UI
**Palette**: Deep purple Copilot brand, VS Code dark background.
**Agent step display**: Each tool invocation shown as a labeled step in the chat panel ("Analyzing files...", "Running tests...", "Proposing edits...") — sequential, transparent, collapsible.
**Status for AI activity**: Animated ellipsis/spinner for "thinking"; static result for "complete." Undo controls appear after edit.
**Tone**: "Capability amplification." UI recedes so work foregrounds.

**Takeaway for ao**: The pattern of **transparent sequential step disclosure** (each tool call labeled and visible) is the right model for the terminal/activity panel. ao should show what the agent is doing in the same style: labeled steps, not a raw log dump.

---

### Supabase (supabase.com)
**Palette**: `#3ECF8E` mint-green as brand-primary (also the success color). `#11181C` dark background. Built on Radix UI + Tailwind + shadcn/ui.
**Tone**: "Radical developer empathy." Open source, portable, one of us.

**Takeaway for ao**: The shadcn/ui + Tailwind stack is a practical choice for ao's implementation. Supabase's success with it validates the approach for a serious developer tool.

---

## 2. Design Direction

### Philosophy

**Mission control, not social feed.** The ao dashboard should feel like a fighter pilot's heads-up display — dense, high-contrast, every element load-bearing. Closest visual analogues: Vercel deployment list + Grafana panel density + LangSmith trace density + Linear state dot pattern.

**Dark mode native.** Not dark mode as a feature — dark mode as the only mode designed with conviction. Light mode can exist but shouldn't drive design decisions.

**Color = signal, not decoration.** Every chromatic element is semantic. The palette outside of status colors is near-monochrome. This maximizes the signal of status colors.

---

### Color Palette

#### Base Palette

| Token | Hex | Usage |
|-------|-----|-------|
| `--bg-base` | `#0C0C11` | Page/app background |
| `--bg-surface` | `#141418` | Card backgrounds |
| `--bg-elevated` | `#1C1C24` | Hover states, terminal background, popover surfaces |
| `--bg-subtle` | `#232330` | Input backgrounds, code blocks |
| `--border-subtle` | `#222230` | Lowest-visibility borders |
| `--border-default` | `#2E2E40` | Standard card borders |
| `--border-strong` | `#3E3E54` | Focus rings, interactive borders |

#### Text Hierarchy

| Token | Hex | Usage |
|-------|-----|-------|
| `--text-primary` | `#EEEEF4` | Main content, session names, ticket titles |
| `--text-secondary` | `#8888A4` | Metadata, timestamps, secondary labels |
| `--text-tertiary` | `#50506A` | Disabled states, de-emphasized content |
| `--text-inverse` | `#0C0C11` | Text on colored buttons |

*Note: Text has a slight blue cast (`EEEEF4` not `EEEEEE`) to harmonize with the blue-cast background.*

#### Status Colors (semantic — must not be overridden for decoration)

| Token | Hex | State | Usage |
|-------|-----|-------|-------|
| `--status-working` | `#5B7EF8` | Working/active agent | Pulsing dot, card left-border, zone header |
| `--status-ready` | `#22C55E` | Needs human action (merge/review) | Dot, merge button, zone header |
| `--status-attention` | `#F59E0B` | Blocked, waiting for response, CI failing | Dot, zone header, badge |
| `--status-idle` | `#6B6B8A` | Agent idle, not running | Dot (dim) |
| `--status-done` | `#3E3E54` | Session closed/archived | Dot (very dim), text de-emphasized |
| `--status-error` | `#EF4444` | Crash, hard failure, exited with error | Dot, badge |

#### Interactive Accent

| Token | Hex | Usage |
|-------|-----|-------|
| `--accent-blue` | `#5B7EF8` | Links, focus rings, active nav items, working state |
| `--accent-blue-hover` | `#7B9CFB` | Hover on blue elements |
| `--accent-blue-subtle` | `rgba(91,126,248,0.12)` | Subtle highlight backgrounds |

#### Full Dark Surface System

The surface layers use a consistent `+8–12 lightness step` between each level (in OKLCH terms), so layering always reads as elevation:

```
Background: #0C0C11 (L≈5%)
Surface:    #141418 (L≈8%)    ← cards
Elevated:   #1C1C24 (L≈12%)  ← hover, dropdowns
Subtle:     #232330 (L≈15%)  ← inputs, code
```

---

### Typography

#### Font Stack

```
UI sans-serif:   Inter Variable (weights 300–700)
                 fallback: -apple-system, system-ui

Code/mono:       JetBrains Mono (weights 400, 600)
                 fallback: 'Fira Code', Menlo, monospace
```

Inter Variable for all UI prose. JetBrains Mono for: session IDs, branch names, commit hashes, terminal output, agent status messages, any data that is "produced by a machine."

No display typeface. No serif. The monospace *is* the personality — it signals "this is infrastructure" without needing a quirky grotesque.

#### Type Scale

| Name | Size | Weight | Line Height | Usage |
|------|------|--------|-------------|-------|
| `zone-label` | 10px | 600 | 1 | Attention zone headers (uppercase, 0.1em tracking) |
| `label` | 11px | 500 | 1 | Status badges, tag text, column headers |
| `caption` | 11px | 400 | 1.4 | Timestamps, secondary metadata (mono) |
| `body-sm` | 12px | 400 | 1.5 | Card metadata rows, description lines |
| `body` | 13px | 400 | 1.5 | Primary body copy within cards |
| `card-title` | 14px | 500 | 1.4 | Ticket/issue titles on session cards |
| `section` | 13px | 600 | 1 | Section headings within panels |
| `page-title` | 18px | 600 | 1.2 | Dashboard title, view names |

Inspired by Linear's granular scale. The 10–14px range covers 90% of the UI.

---

### Component Style

**No drop shadows.** Elevation via background color — `--bg-surface` card on `--bg-base` page. Borders provide edge definition.

**3px left-border accent strips** on session cards to indicate state at a glance (colored by status). This is faster to scan than dots — the entire left edge of the card communicates state without requiring focus.

**Pill badges** for CI status, review status, and labels. Height: 20px. Padding: 0 8px. Border-radius: 10px (fully rounded). Background at 12% opacity of the status color, text at 100% opacity. No solid-fill badges except for the merge button.

**Consistent 6px border-radius** for cards. 4px for badges and inputs. 8px for modals and dropdowns.

**1px borders in `--border-default`** on cards. On hover, transitions to `--border-strong`. No box shadows.

---

### Density

**Target: 6–8 session cards visible without scrolling** in the "Working" zone at 1440px viewport width.

This requires:
- Card height: ~160px (compact) or ~200px (expanded with CI detail)
- Card width: ~280–320px
- Gap between cards: 12px
- Zone header height: 32px
- Padding: 16px page margin

Three columns at 1280px, four columns at 1920px. Grid is `auto-fill` with `minmax(260px, 1fr)`.

The density target is closer to Grafana than Linear. This is not a spacious single-project view — it's 30 agents at once.

---

### Animation and Motion

**Guiding principle: motion must be informative, never decorative.**

| Element | Animation | Spec |
|---------|-----------|------|
| Working state dot | Pulse (box-shadow ring expands) | `2s ease-in-out infinite` |
| CI pending badge | Spinner icon only (no layout shift) | `1.5s linear infinite` |
| Card state transition | Background + border color change | `transition: 200ms ease` |
| New session card | Fade in + 4px slide up | `150ms ease-out` |
| Session removal | Fade out | `200ms ease-in` |
| Terminal open/close | Height expand/collapse | `200ms ease` with `overflow: hidden` |
| Merge button hover | Translate Y -1px | `100ms ease` |
| Status badge change | Cross-fade | `150ms ease` |

No page transition animations. No parallax. No entrance animations on initial load — just appear.

The pulsing activity dot is the *only* continuous animation at rest. Everything else is triggered by state change or user interaction.

---

### Iconography

**Icon library: Lucide Icons** (used by shadcn/ui, 2px stroke, clean geometric forms).

Specific icons to use:
- Session state: `Circle` (dot for idle), `RefreshCw` (pulsed for working), `CheckCircle2` (done), `XCircle` (error)
- CI: `CheckCircle2` (pass), `XCircle` (fail), `Loader2` (pending/running)
- Git: `GitBranch`, `GitPullRequest`, `GitMerge`
- Review: `MessageSquare`, `ThumbsUp`, `ThumbsDown`
- Terminal: `Terminal`
- Attention: `AlertTriangle`, `Bell`
- Merge action: `GitMerge`

Icon sizes:
- Status dots/indicators: 8px (CSS circles, not SVG)
- Inline with text: 14px
- Action buttons: 16px
- Empty state illustrations: 40px

---

## 3. Component Designs

### Session Card

The primary unit of the dashboard. Every card represents one agent session.

**Dimensions**: 280–320px wide, 156px tall (compact) / 200px tall (with CI details expanded).

**Anatomy** (top to bottom):

```
┌─╴[status-strip]╶──────────────────────────────────┐
│                                                     │
│  ● working    ao-58                    [···]        │  ← row 1: status + session ID + menu
│                                                     │
│  Implement UI/UX research dashboard                 │  ← row 2: ticket title (14px, 500)
│  GitHub #58                                         │
│                                                     │
│  ⎇ session/ao-58                      ↑ PR #104    │  ← row 3: branch + PR link
│                                                     │
│  ✓ CI passing   ✓ Approved   3m ago                │  ← row 4: CI + review + timestamp
│                                                     │
│  [  Terminal  ]              [ Merge PR → ]         │  ← row 5: actions (conditional)
│                                                     │
└─────────────────────────────────────────────────────┘
```

**Visual details**:

- **Left border strip**: 3px wide, full card height, color = status color. This is the fastest-scan element. On a 30-card dashboard, these strips form a left-edge column of colors that communicate zone membership instantly.
- **Background**: `--bg-surface` (`#141418`)
- **Border**: `1px solid --border-default` (`#2E2E40`)
- **Border-radius**: 6px
- **Padding**: 12px 14px
- **Session ID** (row 1): 11px JetBrains Mono, `--text-tertiary`, top-right. Not primary — just identification.
- **Status indicator** (row 1 left): 8px filled circle, color by state, + text label 11px `--text-secondary`. For working state, the circle has a CSS `box-shadow` pulse ring (not the circle itself scaling — avoiding layout shift).
- **Ticket title** (row 2): 14px Inter 500, `--text-primary`. Max 2 lines, `overflow: ellipsis`. Below it: tracker reference (GitHub #N or Linear INT-N) in 11px `--text-tertiary`.
- **Branch** (row 3): 11px JetBrains Mono, `--text-secondary`, `⎇` prefix. PR link to the right: `↑ PR #N` in 11px, `--accent-blue`.
- **Status row** (row 4): CI badge + review badge + relative timestamp. All 11px. Left-aligned badges, timestamp right-aligned.
- **Actions row** (row 5): Only shown when human action is available. Merge button right-aligned; Terminal button left-aligned. Row absent if no actions needed (saves vertical space for working-only cards).

**States**:

| State | Left strip | Card border | Card background |
|-------|-----------|-------------|----------------|
| Working | `--status-working` blue | default | default |
| Ready/Merge | `--status-ready` green | `rgba(34,197,94,0.2)` | `rgba(34,197,94,0.03)` |
| Attention | `--status-attention` amber | `rgba(245,158,11,0.2)` | `rgba(245,158,11,0.03)` |
| Error | `--status-error` red | `rgba(239,68,68,0.2)` | `rgba(239,68,68,0.03)` |
| Done | `--status-done` dim | `--border-subtle` | `--bg-base` (recedes) |

The tinted border and very-subtle tinted background for Ready/Attention states make entire cards scannable by zone membership without relying on the strip alone.

---

### Activity Indicator

The dot + label system indicating what an agent is doing right now.

**Dot specs**: 8px × 8px circle, `border-radius: 50%`, `display: inline-block`.

**States**:

```
● Working   — #5B7EF8 filled, + animated ring pulse
● Idle      — #6B6B8A filled, static
● Ready     — #22C55E filled, static (no animation — green is enough signal)
● Exited    — #3E3E54 filled, static
● Error     — #EF4444 filled, static
```

**Pulse animation for Working state**:
```css
@keyframes activity-pulse {
  0%, 100% { box-shadow: 0 0 0 0 rgba(91, 126, 248, 0.4); }
  50% { box-shadow: 0 0 0 4px rgba(91, 126, 248, 0); }
}
.dot--working {
  background: #5B7EF8;
  animation: activity-pulse 2s ease-in-out infinite;
}
```

The ring expands and fades — it doesn't change dot size, so no layout shift. Period is 2s — feels alive but not anxious.

**Label alongside dot**: 11px Inter 500, same color as dot. Shown on cards. In condensed views (list mode), only the dot.

**In zone headers**: A larger version (10px dot) with the zone count badge.

---

### CI Status Badge

**Anatomy**: `[icon] [text]` in a pill container.

**Dimensions**: height 20px, padding 0 8px, border-radius 10px.

**Visual spec per state**:

| State | Background | Text | Border | Icon |
|-------|-----------|------|--------|------|
| Passing | `rgba(34,197,94,0.12)` | `#22C55E` | none | `CheckCircle2` 12px |
| Failing | `rgba(239,68,68,0.12)` | `#EF4444` | none | `XCircle` 12px |
| Running | `rgba(91,126,248,0.12)` | `#5B7EF8` | none | `Loader2` 12px, spinning |
| Skipped | `rgba(107,107,138,0.12)` | `#6B6B8A` | none | `Minus` 12px |
| Queued | `rgba(245,158,11,0.12)` | `#F59E0B` | none | `Clock` 12px |

**Text labels**: "Passing", "Failing", "Running", "Queued". 11px Inter 500. Never just a color with no text (accessibility).

**Multiple CI jobs**: Show the worst-state badge. On hover, expand to show all job names + individual states in a popover (dark background, same visual system).

**Position on card**: Row 4, inline with review badge and timestamp.

---

### PR Merge Button

This is the highest-priority action on the dashboard. When ready, it must visually compete for attention.

**Ready to merge**:
```
background:    #22C55E
color:         #0C0C11 (dark text on green)
border-radius: 6px
height:        28px
padding:       0 12px
font:          12px Inter 600
icon:          GitMerge 14px (left of text)
label:         "Merge PR"
hover:         transform: translateY(-1px), brightness(1.05)
active:        transform: translateY(0)
```

The green button at 28px tall on a dark card background is the most visually dominant element on the Ready card. It should be.

**Blocked — CI failing**:
```
background:    #1C1C24
color:         #50506A
border:        1px solid #2E2E40
cursor:        not-allowed
label:         "Merge PR" (same label)
tooltip:       "CI failing — 2 checks must pass"
```

**Blocked — review required**:
```
Same as CI failing
tooltip:       "Awaiting review approval"
```

**Blocked — conflicts**:
```
background:    rgba(239,68,68,0.12)
color:         #EF4444
border:        1px solid rgba(239,68,68,0.3)
label:         "Conflicts"
```

**After merge confirmation** (optimistic UI):
```
background:    rgba(34,197,94,0.12)
color:         #22C55E
label:         "Merged ✓"
```

The merge button only appears in the card actions row (row 5) when a PR exists. In zone view, the "Needs Merge" zone header's count badge pulses softly green when there are merge-ready sessions.

---

### Terminal Panel

The embedded terminal for a session — shows raw agent output, can be used for interactive access.

**Location**: Expands below the card (pushes other cards down in the grid) or opens as a right-side drawer panel (preferred for 30-agent view — doesn't reflow the grid).

**Right-side drawer variant** (recommended):
- Width: 480px or 40% of viewport, whichever is larger
- Slides in from right: `transform: translateX(100%)` → `translateX(0)`, 200ms ease
- Overlay: `rgba(0,0,0,0.4)` backdrop
- Header: session name + `[Detach]` + `[Close ✕]`

**Terminal area**:
```
background:       #0A0A0F (slightly darker than page bg — the terminal is "deeper")
font:             JetBrains Mono 13px / 1.5 line height
text color:       #D4D4D8 (standard terminal foreground — not pure white)
cursor:           block cursor, #5B7EF8 (brand blue, not white — distinguishes from content)
scrollbar:        4px, --border-default color, no track
padding:          12px 16px
```

**Log entry prefixes**: Timestamp in `--text-tertiary`, then content. System messages from ao itself (not the agent) in `--status-attention` amber so the user can distinguish orchestrator-injected messages from agent output.

```
  10:23:41  Spawning agent on branch session/ao-58...
  10:23:44  Agent ready. Claude session: f81637f1
  10:24:12  Running tests...
  10:24:45  Tests passed. Committing.
```

**Interactive input**: Standard xterm.js implementation. When the agent is running and has accepted stdin, show a `[Agent has control]` banner. When the orchestrator has injected a message, briefly highlight the injected text in `rgba(91,126,248,0.2)`.

**Resize handle**: 4px drag handle on left edge of the drawer. Minimum 320px, maximum 60vw.

---

### Attention Zone Headers

The dashboard is divided into horizontal zones. Each zone is a group of session cards. The zone header is the navigation and triage anchor.

**Zones (ordered by priority, top to bottom)**:
1. **Needs Merge** — PRs approved + CI passing, waiting for you to click Merge
2. **Needs Response** — review comments, CI failures, conflicts requiring human input
3. **Working** — agents actively doing their job, no action needed
4. **Idle** — agents running but inactive
5. **Done** — completed sessions ready for cleanup

**Zone header anatomy**:

```
[●] NEEDS MERGE   ─────────────────────────────────   [3]
```

- Left: Status dot (10px, zone's primary color)
- Zone name: 10px Inter 600, uppercase, 0.12em letter-spacing, `--text-secondary`
- Divider line: `flex: 1`, `1px solid --border-subtle` — full-width horizontal rule
- Right: Count badge — pill with session count, 11px, zone color text, subtle zone-color background

**Left border accent on zone name**: 2px left border in the zone's status color, 16px tall, centered vertically. Adds a crisp zone-identification stripe without dominating.

**Spacing**: 20px top margin above zone header (8px if first zone), 12px bottom margin before cards.

**Visual differentiation by zone**:

| Zone | Dot color | Name color | Count badge bg |
|------|-----------|------------|----------------|
| Needs Merge | `--status-ready` `#22C55E` | `#22C55E` | `rgba(34,197,94,0.12)` |
| Needs Response | `--status-attention` `#F59E0B` | `#F59E0B` | `rgba(245,158,11,0.12)` |
| Working | `--status-working` `#5B7EF8` | `#5B7EF8` | `rgba(91,126,248,0.12)` |
| Idle | `--status-idle` `#6B6B8A` | `#8888A4` | `rgba(107,107,138,0.12)` |
| Done | `--status-done` `#3E3E54` | `#50506A` | `rgba(62,62,84,0.12)` |

**Empty zones**: Collapse entirely (no header shown) unless the user has toggled "show empty zones" in settings. This keeps the viewport focused on actionable content.

**Zone collapse**: Clicking the zone header toggles card visibility. Collapsed state shows header + count only (32px). Useful for suppressing the "Done" zone after reviewing.

---

## 4. Inspiration References

### Vercel Deployments List
**URL**: https://vercel.com/dashboard (requires auth) / https://vercel.com
**Why relevant**: The deployment list row pattern — compact rows with inline status dot, deployment name (monospace), branch, and a merge-like "Promote to Production" action — is the closest existing product to what ao's session card in compact/list mode should be. Pure restraint: the status dot carries enormous signal on a dark background with nothing competing for attention.

### Linear Issue List
**URL**: https://linear.app
**Why relevant**: The tightest example of information-dense card/row design in developer tools. Each issue shows: state dot, priority indicator, title, assignee, estimate, and labels — all in a compact row with zero wasted pixels. The state dot system (colored circles for Todo/In Progress/Done/Cancelled) is directly applicable to ao's working/idle/ready/exited states. The row hover state (very subtle background change) is the right level of interactivity feedback.

### Grafana Dashboard (Dense Panel Layout)
**URL**: https://grafana.com/grafana/dashboards (community dashboards)
**Why relevant**: Grafana demonstrates that 30+ data panels can coexist in a single viewport without overwhelming users — when the data is organized by visual weight and semantic color. The panel border system (1px subtle borders, consistent padding), the metric display pattern (large number + small label + sparkline), and the zone/row organization all have direct analogues to ao's session grid.

### GitHub Actions Workflow Visualization
**URL**: https://docs.github.com/en/actions
**Why relevant**: The job graph in GitHub Actions shows dependency chains between CI steps with status-colored nodes (green pass, red fail, amber in-progress, gray skipped). This is the best existing model for representing "pipeline state at a glance." The status dot → label → duration pattern for each job is directly applicable to ao's CI status display.

### VS Code GitHub Copilot Chat Panel (Agent Mode)
**URL**: https://code.visualstudio.com/blogs/2025/02/24/introducing-copilot-agent-mode
**Why relevant**: The sequential tool-invocation list ("Analyzing files... Running tests... Proposing edits...") inside the Copilot chat panel is the right model for ao's terminal activity feed — transparent, labeled steps rather than raw log output. Each step is collapsible. This makes AI activity *legible* rather than just *visible*.

---

## 5. What to Avoid

### Anti-patterns specific to this product category

**1. Spacious single-project layout**
Linear, Notion, and most project management tools are designed for one project at a time. ao has 30 sessions simultaneously. Do not adopt their card proportions. A 320×240px card works for one project on screen; at 30 sessions, it requires 4 viewports of scrolling.

**2. Status color overloading**
Using the same amber for "warning" as for "this agent has been idle for 3 hours" vs. "CI is failing" vs. "review changes requested" — these are different severities that should have different visual treatments. Define strict semantic rules for each status color and don't let the same color mean two different things.

**3. Badge spam**
Every badge must earn its visual weight. A card shouldn't have 6 badges. If a session is "Working, CI passing, review approved, 3 commits, labeled feature, linked to epic" — the rule is: show only the badges that are *different from the happy path*. CI passing and review approved are expected; don't show badges for them. Show CI *failing* and review *rejected*.

**4. Modals for primary actions**
The merge action should be one click on the card — not "click merge → confirm modal → click confirm in modal." Destructive actions (kill session, delete worktree) use confirmation. Merging a pre-approved PR is not destructive — it's the *goal*. One click.

**5. Sidebar-heavy navigation**
A wide left sidebar eats horizontal space that could show more columns of cards. ao has two states: dashboard view (all sessions) and single-session view (one terminal). Navigation should be a top bar (32px) or a narrow 48px icon rail, not a 240px sidebar.

**6. Light mode as the design authority**
If you design light mode first and adapt to dark, you'll get light-mode design thinking applied to dark backgrounds (gray instead of true near-black, drop shadows instead of border-based elevation, etc.). Dark mode must be the primary design direction.

**7. Animations that compete with status**
If both the working-state dot AND card borders AND zone headers are all animating simultaneously, the eye has no resting point. The *only* continuous animation is the working-state dot pulse. Everything else is transition-on-change.

**8. Full-width single-column layout**
Some dashboards present each item in a full-width row (like a GitHub notifications list). At 30 sessions, this creates an impossibly long page. The grid layout (3–4 columns) with zone headers is mandatory.

**9. Hiding the session terminal behind many clicks**
The terminal is a primary debugging surface. It should be one click from any session card — not buried in a detail page behind 3 navigation layers.

**10. Generic icon set without semantic consistency**
Mixing Heroicons for some components and FontAwesome for others, or using `info` icons for 6 different meanings. Pick Lucide (or Heroicons — but pick one) and define a mapping: each semantic concept has one icon, used consistently.

**11. Treating "Done" sessions identically to active ones**
Done sessions should visually recede. Lower contrast, dimmed colors, collapsed by default. The eye should naturally skip over them. Don't give them the same visual weight as "Needs Merge" sessions.

**12. Conflating "activity state" and "attention state"**
These are different dimensions:
- **Activity state**: Is the agent running, idle, or stopped? (working/idle/exited)
- **Attention state**: Does the human need to act? (needs merge/needs response/fine/done)

A working agent can be in "Needs Response" (CI failing while it runs). An idle agent can be in "Needs Merge" (PR ready, agent finished). The UI must show both — the left border strip shows attention state; the activity dot shows activity state.

---

## Implementation Notes

**Recommended stack**: Next.js 15 + Tailwind CSS + shadcn/ui (Radix UI primitives). This is what Supabase uses — validated for serious developer tooling at scale.

**Terminal**: xterm.js with `@xterm/addon-fit`. Use the dracula or custom dark theme matching the color system above.

**Real-time updates**: Server-Sent Events (already in ao's architecture) for status changes. Status transitions should animate (200ms ease) — not snap — so the user can track what changed.

**Design token implementation**: CSS custom properties on `:root`. All color tokens defined as custom properties, not Tailwind color classes directly. This enables runtime theme switching and makes the semantic token system enforceable.

**Accessibility**: Status indicators must not rely on color alone. Every status dot also has a text label. Badge text is always present (not icon-only). Focus rings use `--accent-blue` at 2px offset. Tab order follows visual reading order.

---

*Design brief compiled February 2026. Based on visual analysis of: Linear, Vercel, Railway, Fly.io, Inngest, Temporal, Grafana, WandB, LangSmith, Retool, Render, PlanetScale, Supabase, GitHub Copilot.*
