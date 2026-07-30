# Design System — ReverbCode

> Source of truth for the ReverbCode desktop UI (Electron + React 19 + Tailwind v4
>
> - Radix/shadcn + xterm, in `frontend/src/renderer`). Read this before any visual
>   or UI change. Created by `/design-consultation` on 2026-06-09.

## ⚠️ Design direction — clone agent-orchestrator verbatim (SUPERSEDES prior direction · 2026-06-10)

By explicit user decision (2026-06-10), the renderer **clones the
agent-orchestrator web app verbatim** in looks and design. This **supersedes the
"match the reference" direction** documented in _Aesthetic Direction_ and the palette
sections below — where they conflict, **agent-orchestrator wins**. Do not re-flag
"this doesn't match the old reference" in QA/review; flag divergence from **agent-orchestrator**.

- **Reference (the user's own app):** `~/Projects/agent-orchestrator/packages/web/src`
  — `app/globals.css`, `app/mc-board.css`, `app/mc-sidebar.css`,
  `components/{ProjectSidebar,Dashboard,SessionCard,SessionDetailHeader,SessionInspector,StatusBadge}.tsx`.
- **Palette (live in `frontend/src/styles/tokens.css`):** shadcn `base-luma` with
  the `olive` base (`b6tOz2I0x` preset), expressed in OKLCH for both themes.
  Product status colors and the terminal palette remain independent semantic
  signals; the dark sidebar primary remains the preset's blue live edge.
- **Cloned surfaces:** the four-column gradient kanban board, the `ProjectSidebar`
  (brand + project disclosure + nested session rows + Settings menu footer), the
  session topbar (Kanban back button + identity + breathing `StatusBadge` pill), and
  the shared `DashboardTopbar`/`DashboardSubhead` chrome (Coding/Reviews tabs · "N
  working" pill · subhead) reused across board/review/PR/settings.
- **Build with shadcn primitives** where a component fits (`components/ui/*`:
  dropdown-menu, select, card, table, tooltip, …); agent-orchestrator's own
  hand-rolled CSS components are structure/behaviour reference only.
- The terminal keeps its own palette. Everything else tracks the selected
  shadcn preset and agent-orchestrator's product structure.
- **Approved divergence (2026-06-10):** on macOS, a titlebar cluster (sidebar toggle +
  back/forward history arrows, `TitlebarNav`) lives in the sidebar header below the
  traffic lights — the web reference has no window chrome, so no analogue exists.
  The toggle is pinned in the icon-rail column so it stays put during expand/collapse;
  arrows hide when the sidebar is collapsed.
- **Approved divergence (2026-06-10):** the session inspector rail is fully
  collapsible, built on the shadcn resizable primitive (`pnpm dlx shadcn add
resizable`, react-resizable-panels v4 `collapsible` panel + imperative API,
  user-requested). The panel animates to 0% via a flex-grow transition while the
  content keeps a stable min-width (yyork-style, no mid-animation reflow). Toggled
  by a `PanelRight` icon button in the session topbar and ⌘⇧B; open state + split
  width persist. The AO reference keeps the rail always visible.
- **Approved divergence (2026-06-12):** on Win/Linux the shell topbar spans the
  window and the sidebar hangs below it so the sidebar border stops at the header.
  On macOS the shell topbar is hidden (in-panel actions) and the sidebar is
  full-height; traffic-light clearance uses `--size-traffic-light-clearance` for
  both the sidebar header pad and the window-drag strip.

## The contract (read this before adding any value)

Everything below this heading is the enforceable part of the design system. It is
numbers, not adjectives, so it can be checked in review and in CI. Sections
further down describe product structure and history; where they disagree with the
contract, **the contract wins**.

**The one rule:** if you need a value that is not on a scale below, change the
scale — do not add an exception. A token names a **role** it plays
(`--color-border-strong`, `--size-control-md`), never a **place** it appears
(`--radius-settings-row`). A place-named token can only ever have one caller,
which is how a token layer grows to 438 properties and stops constraining
anything.

Current state and the gap to this contract are measured in
[`frontend/docs/ui-system-audit.md`](frontend/docs/ui-system-audit.md). Items
marked **target** are not fully true in the code yet.

### Type — five sizes (target)

| Utility      | Size | Use                             |
| ------------ | ---- | ------------------------------- |
| `text-micro` | 10px | counts, keycaps, dense metadata |
| `text-2xs`   | 11px | secondary labels                |
| `text-xs`    | 12px | default UI text                 |
| `text-sm`    | 14px | emphasis, card and row titles   |
| `text-base`  | 16px | dialog titles, the rare heading |

Weights: 400 normal, 500 medium, 600 for a card title. No half-pixel sizes, no
`text-[13px]` literals. Anything above 16px is a single-surface decision and stays
a local class, not a global token. Geist Sans for all UI; Geist Mono only for
literal code and terminal output.

### Radius — one base, derived steps (target)

| Utility          | Value | Use                                           |
| ---------------- | ----- | --------------------------------------------- |
| `rounded-swatch` | 2px   | status squares (the only sub-scale exception) |
| `rounded-xs`     | 4px   | scrollbars, tiny chips                        |
| `rounded-sm`     | 6px   | inputs, small controls                        |
| `rounded-md`     | 8px   | buttons, rows, menu items                     |
| `rounded-lg`     | 10px  | cards, panels                                 |
| `rounded-xl`     | 14px  | modals, sheets                                |
| `rounded-full`   | pill  | badges, avatars, dots                         |

7px, 12px, 16px, 17px, and 20px are not reachable from the base and must not be
reintroduced.

### Spacing — 4px base, Tailwind scale only

`1`=4 · `1.5`=6 · `2`=8 · `2.5`=10 · `3`=12 · `4`=16 · `5`=20 · `6`=24. Control
heights `h-6` 24px xs · `h-7` 28px sm · `h-8` 32px default. No `p-[19px]`.

Within a container, outer padding and the gap between its items are the same
value unless there is a stated reason.

### Color — roles, never literals

Use the semantic roles in `frontend/src/styles/tokens.css`: `--color-bg-*`,
`--color-text-*`, `--color-border-*`, `--color-accent-*`, `--color-status-*`. No
raw hex in the renderer. Board and topbar status hues (working blue, needs-you
orange, in-review yellow, ready green) come from `--color-status-*` and are
defined once for both themes.

### Motion — three durations, two easings (target)

`fast` 100ms · `normal` 150ms · `slow` 240ms. Enter `ease-out`, exit `ease-in`;
exits are shorter than entries. Status pulse 1.8s loop is the one expressive
exception. Never animate layout or text. Honour `motion-reduce`.

### Control recipe — what goes with what

Scales alone don't produce consistency; the combinations have to be fixed too.
Pick the row by control height and take the whole row. This is what stops
"which radius goes on a 28px button" from being re-decided per component.

| Height     | Radius           | Padding x | Gap       | Icon | Text       |
| ---------- | ---------------- | --------- | --------- | ---- | ---------- |
| 24px `h-6` | `rounded-sm` 6px | `px-2`    | `gap-1.5` | 13px | `text-2xs` |
| 28px `h-7` | `rounded-md` 8px | `px-2.5`  | `gap-2`   | 14px | `text-xs`  |
| 32px `h-8` | `rounded-md` 8px | `px-3`    | `gap-2`   | 16px | `text-xs`  |
| 36px+ rows | `rounded-md` 8px | `px-3`    | `gap-2`   | 16px | `text-sm`  |

A square icon-only control uses the same radius and drops the padding to a
centred grid. Radius never exceeds a quarter of the control height — that is the
line between "rounded rectangle" and "accidental pill".

### Alignment

- **Text-bearing controls are left-aligned.** `justify-center` is for icon-only
  controls. A centred label in a full-width row is a bug, not a style.
- **Icon and label are optically centred** on the text, not the box: `flex
items-center` with the icon at `shrink-0`.
- **Sibling rows share a left edge.** A row's icon column, a section heading, and
  the row content below it all start at the same x.
- **Numbers that update in place use `tabular-nums`** so they don't jitter.

### Components — compose, do not re-roll

Build from `components/ui/*`. One `Button` with variants, one `Badge`, one row
primitive. A raw `<button>` outside `components/ui/` is a bug: it re-specifies
height, padding, radius, hover, focus, and disabled state, and each of those is a
chance to diverge. Icons are lucide only.

### Copy

Sentence case everywhere — never all caps, not even for labels. No slashes as
separators (use `·`). Short labels; no explanatory sentences in chrome.

## Product Context

- **What this is:** ReverbCode is an Electron desktop app for supervising many parallel
  AI coding-agent sessions, backed by a Go daemon (`backend/`). The `ao` CLI is the
  thin client over the same daemon.
- **Who it's for:** professional software engineers running multiple coding agents at
  once who need to delegate, watch, intervene, and ship PRs.
- **Space/peers:** agent orchestration / parallel-agent desktop tools.
- **Project type:** dark-mode-primary desktop app; terminal-dense; keyboard-driven;
  runs all day.
- **The one memorable thing:** leverage and speed — "I'm more in control here than
  babysitting N terminal tabs myself."

### Product flow (what the UI must serve)

ReverbCode is **orchestrator-led**, which is the one thing that differs from a flat
list of independent sessions. Grounded in the daemon
(`backend/internal/session_manager/manager.go`, `docs/architecture.md`):

- A **Project** is a registered git repo.
- Per project there is **one active Orchestrator** session plus **N Worker** sessions.
  Both are the same underlying "session" (durable facts: `activity_state`,
  `is_terminated`, PR facts); they differ only by `Kind` (`KindOrchestrator` vs the
  default worker). A project may run the orchestrator on a different agent than its workers.
- The **Orchestrator is the human-facing coordinator**: you talk to it; it spawns
  workers (`ao spawn`), messages them (`ao send`), tracks progress, and synthesizes
  results. It avoids implementing unless necessary.
- A **Worker is a normal agent session** — nothing special-cased. It runs one focused
  task in an isolated git worktree + branch, with the agent CLI in a terminal as the
  conversation, producing a diff → commit/push → PR. It escalates to the orchestrator
  only for true blockers or cross-session coordination.
- The daemon **observes** runtime + PR/CI/review facts and **derives** display status
  at read time: `working`, `needs_input`, `ci_failed`, `changes_requested`,
  `mergeable`, `approved`, `review_pending`, `pr_open`, `idle`, `terminated`, `merged`.
  Never store display status; keep session facts small.

## Aesthetic Direction

> **Superseded (2026-06-10):** see the _Design direction — clone agent-orchestrator
> verbatim_ banner at the top. The earlier reference framing below is retained for
> history; the live look tracks agent-orchestrator (same flat near-black / hairline
> family, so most of this still reads true).

- **Direction:** flat, near-black, hairline-bordered, utilitarian. Industrial control
  surface, calm chrome, the terminal as the center of gravity.
- **Decoration level:** minimal. Type + 1px hairlines do all the work. No gradients,
  glow, blobs, or emoji.
- **Mood:** low-glare, dense, keyboard-native; signal-over-noise.
- **Reference:** a flat, hairline-bordered desktop control surface (primary, visual +
  structural). Tokens below were derived from that reference's renderer CSS.
- **Deliberate tradeoff:** to match that reference, we use the **system font stack** (not
  a custom typeface) and its neutral palette. We diverge in exactly one place: the
  accent is ReverbCode's **refined blue**, not the reference's jade green. The terminal
  keeps green (it is the agent CLI).

## Typography

The renderer bundles the variable Geist families locally; it makes no Google
Fonts or other runtime font requests.

- **UI / body / display:** `Geist Variable`, then system sans fallbacks.
- **Mono / terminal / code:** `Geist Mono Variable`, then the existing Nerd Font
  and system mono fallbacks. **Mono is for literal code and terminal output only**
  — no mono in UI chrome (labels, counts, timestamps, paths). Use
  `tabular-nums` where numbers need to align.
- **Superseded (2026-07-30):** eyebrow labels are no longer mono or uppercase, and
  the old six-step scale is replaced by the five sizes in _The contract_. All-caps
  is banned everywhere by explicit user rule.

## Color

A flat Radix-neutral near-black ramp carries the whole interface; color is rare
and meaningful. Values are sRGB approximations of the reference's `color(display-p3 …)` tokens.

### Dark (primary)

| Role                                 | Hex             |
| ------------------------------------ | --------------- |
| `--bg` canvas                        | `#111111`       |
| `--bg-1` surface                     | `#191919`       |
| `--bg-2` raised / hover / active row | `#222222`       |
| `--bg-3`                             | `#2a2a2a`       |
| `--fg` text                          | `#eeeeee`       |
| `--fg-muted`                         | `#b4b4b4`       |
| `--fg-passive`                       | `#6e6e6e`       |
| `--border` hairline                  | `#3a3a3a`       |
| `--border-1`                         | `#484848`       |
| **`--accent` (blue)**                | **`#5b9dff`**   |
| `--needs-you` / in-progress (amber)  | `#ffcc4a`       |
| `--success` / mergeable (green)      | `#6cb16c`       |
| terminal green                       | `#7bd88f`       |
| `--error` (red)                      | `#d4544f`       |
| text selection                       | `#3f8ef7` @ 35% |
| terminal bg                          | `#161616`       |

### Light (supported, not primary)

| Role                      | Hex                               |
| ------------------------- | --------------------------------- |
| canvas / surface / raised | `#fcfcfc` / `#ffffff` / `#ededee` |
| text / muted / passive    | `#1a1a1a` / `#666666` / `#9a9a9a` |
| border                    | `#e3e3e5`                         |
| accent (blue)             | `#2563eb`                         |
| amber / green / red       | `#9a6b00` / `#1a7f37` / `#c0392b` |

### Accent rules

- **Blue** = the live edge only: primary buttons, the active/selected session, focus
  rings. Never decorative.
- **Amber** = an agent needs you (blocked / `needs_input` / `review_pending`).
- **Green** = `mergeable`/success and terminal/agent CLI text.
- **Red** = `ci_failed` / destructive.
- These map 1:1 to the daemon's derived statuses.

### Status indicator

> **Superseded in part (2026-07-30):** the board pairs a 8px `rounded-swatch`
> colour square with a text label, matching the landing hero's board preview. The
> topbar shows no status at all — its centre context pill (branch/orchestrator +
> activity) was removed the same day, leaving breadcrumbs on the left and controls
> on the right. Session activity now reaches assistive tech through the
> orchestrator control's accessible name. The glyph rules below still govern the
> side rail's Workers list.

Session status is a single ~14px glyph in one fixed slot, never a text pill/badge:

- **Working / active** → an animated spinner (accent).
- **Has an open PR** → a PR icon, tinted by PR state: mergeable/approved green,
  `ci_failed` red, review/`changes_requested` amber, plain `pr_open` muted.
- **Otherwise** → a filled dot: `needs_input` amber (pulsing), idle/done muted gray.

Precedence: **working spinner > PR icon > dot**. Implemented as `StatusGlyph` in
`components/SideRail.tsx`; used in the orchestrator's Workers list. (Worker rows in the
left rail stay name-only — no glyph.)

## Spacing

- **Base unit:** 4px (Tailwind scale: 1=4, 1.5=6, 2=8, 3=12, 4=16, 5=20, 6=24).
- **Density:** compact / desktop-tight.
- **Control + row height:** `h-8` = 32px default; `h-7` = 28px small; `h-6` = 24px xs.
- Inputs `px-2.5 py-1`; buttons `px-2.5`, gap 1–1.5.

## Layout

- **Approach:** fixed three-pane app shell, opens into the workbench (no marketing/dashboard home).
- **Panes:** `[ rail 240px ] [ center 1fr ] [ side rail 316px ]`.
- **Rail (240px), top → bottom:**
  1. **Orchestrator anchor** — pinned, single, visually distinct (blue 2px left bar,
     `--bg-2` fill, hub/`waypoints` icon, name "Orchestrator", a `5 agents · 2 need you`
     mono summary). This is ReverbCode's one addition over the reference. Default landing view.
  2. `PROJECTS` eyebrow label + a `+`.
  3. Project rows (folder icon + name) with nested **worker rows beneath**. Each project
     row has a hover-revealed **`+`** that opens the New-worker modal pre-scoped to that
     project (distinct from the `PROJECTS` header `+`, which registers a repo).
  4. **Footer:** `Search ⌘K`, `Settings ⌘,`. (No Library.)
  5. **Account** row pinned at the very bottom.
- **Worker rows are name-only.** Just the session name, truncated. Status, branch, diff,
  and PR live in the panes and topbar, never in the row. Selection = `--bg-2` fill + a
  2px blue left bar. (the reference itself shows a faint trailing timestamp; we omit it by choice.)
- **Center = the conversation.** Orchestrator → its coordination terminal (delegate here;
  composer reads "tell the orchestrator what to build"). Worker → the agent CLI terminal
  (tabbed per agent, e.g. `claude-code (1)`), with a composer (model selector, worktree
  path, `Accept edits`). The terminal **is** the conversation; no separate chat surface.
- **Side rail (316px):** orchestrator → a quiet **Workers** list (name + project + derived
  status). Worker → the **Git review rail**: `Changed N` → All files / Discard all / Stage
  all → file rows (`+adds −dels`, stage toggle) → `Commit message` + `Description` →
  **Commit & Push** (primary blue) → branch + `Create PR`.
- **Border radius:** see _The contract_ (the values above were the 2026-06-09
  reference scale and no longer match the token base).
- **Icons:** **lucide** only. No emoji.

### Topbar

- **Left (both):** `project / session` breadcrumb + pin; for the orchestrator, a hub icon
  - `Orchestrator`.
- **Right — worker session:** a **PR/CI status pill** that is the action
  (`PR #156 · mergeable` green / `CI failed` red / `review requested` amber /
  `Open PR` when none) → **Changes / Files / Terminal** view toggles → **⋯ session menu**
  (rename, restart, kill, claim PR — the `ao session …` commands).
- **Right — orchestrator:** **+ New worker** → Terminal toggle → **⋯ menu**. No diff toggles.

### Spawn-worker modal (mirrors the reference's Create Task)

You mostly let the orchestrator spawn workers from its conversation; the manual paths
(the topbar `+ New worker`, a project row's hover `+`, or `ao spawn`) open a modal that
mirrors the reference exactly. Launching from a project row pre-fills the Project field:

- Centered dialog, **12px radius**, `max-w` ~512px, `bg` canvas, `ring-1` at 10% fg,
  fade + zoom-95 enter.
- **Header:** eyebrow mono-uppercase title `New worker` + `×` close.
- **Body** (`gap` 15–16px): a **borderless large name field** (18px, auto-focus, slug
  rule "letters, numbers, hyphens") → **Project** selector → **Agent** selector
  (claude-code / codex / opencode / …) → a **"Based on"** bordered card with a segmented
  control `Branch · Issue · Pull Request` revealing a combobox → a **Prompt / Workspace**
  tab where Prompt is the worker's initial task (textarea).
- **Footer:** right-aligned single primary **`Spawn worker`** (blue) with a `⌘↵` keycap,
  disabled until valid.

## Motion

- **Approach:** minimal-functional. The one expressive exception: a status dot/spinner
  pulse on active/working sessions (opacity breathe) so "alive" is glanceable. Never
  animate text or layout.
- **Easing and duration:** see _The contract_. Modals are 110ms in / 80ms out,
  opacity + scale; the exit is deliberately shorter than the entrance.

## Implementation notes

- **Stale (2026-07-30):** the Inter → system-stack migration note that used to sit
  here is done and wrong twice over — the renderer bundles Geist, not Inter, and
  not the system stack. Typography is governed by _The contract_.
- Keep tokens as CSS custom properties under `.dark` and `:root[data-theme="light"]`
  in `frontend/src/styles/tokens.css`.
- Current drift from the contract, with counts and a migration sequence:
  [`frontend/docs/ui-system-audit.md`](frontend/docs/ui-system-audit.md).
- A faithful HTML reference of all of the above (both views + topbar + spawn modal,
  light/dark) is saved under
  `~/.gstack/projects/aoagents-agent-orchestrator/designs/design-system-20260609/`.

## Decisions Log

| Date       | Decision                                                                | Rationale                                                                                        |
| ---------- | ----------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| 2026-06-09 | Match the reference's visual language exactly                           | User direction; the reference is the demonstrated model for this app's UI.                       |
| 2026-06-09 | System font, not a custom typeface (e.g. Geist)                         | The reference uses the system stack; fidelity + native feel + zero font payload over brand type. |
| 2026-06-09 | Refined **blue** accent, not the reference's jade green                 | User's explicit pick; blue for primary/active/focus, terminal stays green.                       |
| 2026-06-09 | Single global **Orchestrator** anchor, orchestrator-first default view  | The one real difference from the reference; orchestrator is the human-facing coordinator.        |
| 2026-06-09 | **Name-only** worker rows                                               | User direction; status/branch/diff live in panes + topbar, not the row.                          |
| 2026-06-09 | Removed **Library** from the rail footer                                | User direction; footer is Search + Settings only.                                                |
| 2026-06-09 | Topbar right = PR/CI pill + view toggles + ⋯ menu (worker)              | Surfaces the actionable PR/CI state from the daemon; desktop-tool precedent.                     |
| 2026-06-09 | Spawn modal mirrors the reference's Create Task                         | Consistency with the reference; mapped to `ao spawn` params.                                     |
| 2026-07-30 | Sentence case everywhere; no all-caps labels, no slash separators       | User direction; all-caps eyebrows read as shouting in dense chrome.                              |
| 2026-07-30 | Geist Sans for all UI chrome; mono only for code and terminal output    | User direction; mono in labels made the chrome look like output.                                 |
| 2026-07-30 | Board lane colours + swatch headers cloned from the landing hero        | User direction; the marketing preview is the demonstrated target for the board.                  |
| 2026-07-30 | Added _The contract_: enforceable numeric scales at the top of this doc | The doc had drifted from the code; prose rules don't hold, checkable numbers do.                 |
| 2026-07-30 | Removed the topbar's centre context pill                                | User direction; a bordered card floating in the bar competed with the page it heads.             |
| 2026-07-30 | Hairlines dropped to 7% white (dark) / oklch 0.945 (light)              | User direction; borders were reading as decoration rather than separation.                       |
| 2026-07-30 | Sidebar projects start collapsed, but always list the open session      | User direction; the rail stays scannable without ever hiding where you are.                      |
