# UI Revamp — PR Breakdown

All commits on `feat/ui-revamp` that are original to this branch (excluding upstream cherry-picks), grouped into small, independently-mergeable PRs.

---

## PR 1 — Design tokens + core layout foundation

**Commits**
- `d722ce60` feat(ui): revamp board, topbar, sidebar, settings, and design tokens
- `5f066c63` fix(ui): align sidebar footer insets, center-panel radius formula, resize zone, and border tokens
- `368a8380` feat(frontend): unify Reverb workspace top bars

**What it does**
- Introduces the new CSS token set: `--border` lightened to 7%, `--background` for topbar, `--radius-window`-derived center-panel radius (12px), sidebar padding symmetry.
- Establishes the framed inset center panel that every subsequent PR builds on.
- Wires the shared Reverb topbar component so every surface (board, session, settings) gets the same chrome.

---

## PR 2 — Topbar unified action row + kill button

**Commits**
- `e74c2af6` feat(topbar): unified action row, plain bell + red badge, brighter dark overlays
- `b110e0d5` feat: animate topbar board icon shift with Motion CSS variable
- `f843f9c8` fix: remove hardcoded pr-4/pr-4.5 from topbar containers
- `1615a575` fix: remove right padding from topbar so notification button hugs the edge
- `ba98d97f` fix: set topbar right padding to 2px
- `7d5b7339` fix: add 2px right margin to notification bell button
- `83813e9a` fix: increase bell button right margin to 4px
- `1b25e654` fix: style kill button as icon-only with tooltip to match topbar buttons

**What it does**
- Removes the separator between orchestrator icon and bell; bell is always plain `Bell` with a red unread badge.
- Board icon and title slide with a Framer Motion CSS variable instead of snapping when the sidebar toggles.
- Tightens the right edge: kills hardcoded `pr-4`/`pr-4.5`, sets `padding-inline-end: 2px`, adds `mr-1` to the bell.
- Converts the kill button from a labeled red button to an icon-only button with a tooltip, matching the other topbar actions.

---

## PR 3 — Sidebar chrome, animations, and peek

**Commits**
- `f3a5ccb4` feat: port PR #3310 sidebar content (Pinned/Projects sections, new nav chrome)
- `04ac2446` fix: sidebar Pinned spacer, project/session height animations, settings button size
- `cf363750` feat: sidebar project animations, card hover brightness, UX polish
- `ce254b6c` fix(sidebar): no startup animation — mount directly at correct open/closed state
- `d633a8ca` feat(sidebar): peek shows real sidebar content via peekReveal offset
- `5012db40` fix(sidebar): make projects container scrollable
- `c295d17c` fix(sidebar): match the search field radius to the cards
- `2b3e1d3f` fix: reduce sidebar project children left indent

**What it does**
- Pinned and Projects are separate collapsible sections; each project gets a two-letter monogram avatar with a deterministic oklch colour pair.
- Projects and sessions animate height 0↔auto with slide-up/fade (0.14s) on expand/collapse. Sidebar mounts at its final state with no boot animation.
- Hovering within 60px of the left edge shows a content-accurate sidebar peek via `peekReveal` offset.
- Projects container scrolls when sessions overflow. Child session rows use less left indent. Search field radius matches project cards.

---

## PR 4 — Board column headers, archive toggle, and session cards

**Commits**
- `8f0faf9c` feat(ui): archive toggle, search button, topbar tweaks, dev fixtures
- `b1fcf086` fix(board): polish column headers, archive animation, topbar spacing
- `201873f1` fix(board): card bg → bg-card for dark mode elevation
- `1969314e` test: fix SessionsBoard test assertions after UI revamp

**What it does**
- Column header names are sentence-case sans-serif (not `ALLCAPS font-mono`). Status indicators are 10×10 rounded-square chips instead of vertical bars.
- The entire archive header row is a clickable button that toggles the session grid with a height-0-to-auto animation and rotating chevron.
- Idle column is hidden when empty; its header is a button that collapses its sessions with the same animation. Avoids double-borders when collapsed.
- Session cards use `bg-card` (elevated in dark mode). Bottom-bar divider removed. Cursor stays default on hover. Gap added below the last working card.
- Test assertions updated to match the new class names and DOM structure.

---

## PR 5 — Animations, press feedback, and menus

**Commits**
- `852a6f18` feat(animations): improve-animations audit — blur transitions, press feedback, popover curves, dead code
- `6b0766ca` feat(press-feedback): scale-on-active across sidebar tracks, board cards, topbar, settings nav
- `c77bd2489` feat(context-menu): brighter bg, padded container, gap-px, no separators

**What it does**
- Modals get opacity+scale+blur entrance/exit (`animate-modal-in/out`). All popovers, dropdowns, and tooltips share a `popover-in/out` keyframe (scale 0.95→1, blur 4→0).
- `active:scale-[0.97]` on sidebar buttons and topbar; `active:scale-[0.98]` on board cards.
- All menus (`ContextMenu`, `DropdownMenu`, `Select`, `Tooltip`, `Popover`) use `bg-card`, `p-[3px]` padding, `gap-px` between items.
- Dead components removed: `DashboardSubhead`, `OrchestratorActivityIndicator`, `MigrationSection`, `TopbarActivityStatus`, `SettingsPanel`, `SettingsPageShell`, `useEventsConnection`.

---

## PR 6 — Settings modal

**Commits**
- `d3b5ccb7` fix(settings): remove sidebar header title + border, nav starts directly
- `00115eec5` fix(settings): remove top padding from sidebar nav
- `2ecf5355` fix(settings): add small Settings label above sidebar nav
- `944866d7` fix(settings): transparent row bg in dark mode, dimmer dialog border (7%→3%)
- `f888834f` feat(settings): project settings sub-pages + brighter context menu icons

**What it does**
- Settings sidebar drops the large "Settings" header and border; a small dimmed 10px label replaces it directly above the nav buttons.
- Settings rows have a transparent background in dark mode. Dialog border is dimmed from 7% to 3%.
- Project settings split into four sub-pages: General, Agents, Workflow, Intake — same sidebar pattern as global settings.
- Context menu icons use `text-muted-foreground` and brighten on focus.

---

## PR 7 — New task modal

**Commits**
- `ac3256f9` fix(new-task): match textarea to Input styles, add exit animation, fix tab order
- `164176492` fix(new-task): remove textarea resize handle

**What it does**
- Textarea styled identically to `Input` (same border, ring, and background). `resize-none` applied. Tab order: title → brief → submit. Exit animation matches the settings modal.

---

## PR 8 — Select component and global scrollbars

**Commits**
- `10b2bae9` fix(select): bg-card styling, single checkmark, Input-matched trigger
- `4dde3bda` fix(ui): hide all scrollbars app-wide via global * rule

**What it does**
- `SelectContent` uses `bg-card` to match other menus. `SelectTrigger` matches `Input` style. Single checkmark, owned by `SelectItem`.
- `* { scrollbar-width: none }` + `*::-webkit-scrollbar { display: none }` removes all native scrollbars app-wide while keeping content scrollable.

---

## PR 9 — Named colour themes

**Commits**
- `edc05009` feat(themes): named palettes with a normalised contrast curve

**What it does**
- Theme selector and mode selector (light/dark/system) are separate controls in General settings.
- Five palettes alongside default Orchestrate: GitHub, Catppuccin, Dracula, Tokyo Night, Rosé Pine.
- All surfaces re-derived to trace the same lightness curve as Orchestrate. Body text ≥ 12.5:1 contrast; muted ≥ 5.0:1. Applied before first paint to avoid a colour flash.

---

## PR 10 — Inspector animation and tab styles

**Commits**
- `65691d61` feat(ui): right inspector spring animation, unified tab styles, optimistic tab close

**What it does**
- Inspector panel slides in/out with a spring. Tabs across the app share a single style. Tab close is optimistic (removes immediately, rolls back on error).

---

## PR 11 — macOS app icon

**Commits**
- `5ab515f0` chore: update macOS app icon to flat full-bleed square
- `c46970391` chore: shrink icon — 82% scale with transparent border so Dock size matches other apps

**What it does**
- Icon artwork scaled to 82% with a transparent border so macOS clips it through its squircle mask at the correct visual weight relative to system icons.

---

## Merge / test plumbing (not a standalone PR)

**Commits**
- `6047473e` merge: integrate upstream main (27 commits) into feat/ui-revamp
- `6a441928` chore: merge origin/main — resolve SessionView and SessionFilesView conflicts
- `704470fd` fix: repair 53 test failures from merge and PR cherry-picks
- `961078f7` fix: adapt type imports, session tabs, and TopbarButton for merged PRs

These are housekeeping commits that land automatically when the feature branch is squash-merged or rebased; they don't need their own PR.
