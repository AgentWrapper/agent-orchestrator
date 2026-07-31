# UI Revamp — PR Breakdown

Commits on `feat/ui-revamp` in merge-ready order. Each PR lists what it depends on so you know what must land first. Commits are shown oldest → newest within each PR.

---

## Standalone backend PRs (no frontend dependency, can land any time)

### BE-1 — tmux: unset CI/color env vars in panes
**`d722ce60`** (backend portion only — `tmux.go`, `tmux_test.go`)
— Introduces `ambientColorSuppressors` (`CI`, `NO_COLOR`, `FORCE_COLOR`, `COLOR`). Unsets these inside every tmux pane so agent TUIs (Claude, etc.) render colors correctly even when the daemon was launched from a CI or coding-agent terminal that set them.
**Depends on:** nothing

### BE-2 — tmux: always use POSIX shell for the pane interpreter
**`8f0faf9c`** (backend portion only — `tmux.go`, `tmux_test.go`)
— The pane interpreter is pinned to a POSIX shell (`/bin/sh`) rather than `$SHELL` so that `buildLaunchCommand`'s `export`/`unset` syntax works even when the user's shell is fish or nushell. The user's interactive shell is still used for the keep-alive via `exec "${SHELL:-/bin/sh}" -i`.
**Depends on:** nothing (can merge before or after BE-1)

---

## Standalone asset PR

### ASSET-1 — macOS app icon update
**`5ab515f08`** `chore: update macOS app icon to flat full-bleed square`
**`c46970391`** `chore: shrink icon — 82% scale with transparent border`
— Binary asset changes only. New icon artwork, then scaled to 82% with transparent padding so macOS squircle mask clips it at the correct visual weight.
**Depends on:** nothing

---

## Frontend PR chain

> Every PR below depends on the one above it unless marked otherwise.

---

### FE-1 — Reverb topbar wiring (foundation)
**`368a83800`** `feat(frontend): unify Reverb workspace top bars`
Files: `ReverbTopbar.tsx` (new), `useReverbTopbarModel.ts` (new), `ShellTopbar.tsx`, `SessionView.tsx`, `SessionsBoard.tsx`, `CenterPane.tsx`, `NotificationCenter.tsx`, `SessionInspector.tsx`, `styles.css`, `tokens.css` (+32 more)
— Introduces `ReverbTopbar` as the shared topbar component and wires it into every surface. Adds `useReverbTopbarModel` hook. Full test suite for `ReverbTopbar`, `WindowTitlebar`, `TitlebarNav`.
**Depends on:** nothing (this is the baseline the entire revamp builds on)

---

### FE-2 — Design tokens, board layout, and settings modal (foundation)
**`d722ce60`** `feat(ui): revamp board, topbar, sidebar, settings, and design tokens` (frontend portion)
Files: `tokens.css`, `styles.css`, `SessionsBoard.tsx`, `Sidebar.tsx`, `SettingsDialog.tsx` (new), `GlobalSettingsForm.tsx`, `TopbarButton.tsx`, `dev-board-fixtures.ts` (new), `ui/button.tsx`, `ui/badge.tsx`, `ui/card.tsx`, `ui/tabs.tsx`, `ui/input.tsx`, `ui/dialog.tsx`, `ui/sidebar.tsx`, `ui/switch.tsx`, `ui/dropdown-menu.tsx`, + others
— The foundational commit. Rewrites `tokens.css` (border to 7%, center-panel radius formula, sidebar tokens). Converts board to split-lane model. Converts settings from a page-route to `SettingsDialog` modal. Seeds `dev-board-fixtures.ts`. Removes `TopbarActivityStatus`.
**Depends on:** FE-1

---

### FE-3 — Token and layout corrections
**`5f066c63`** `fix(ui): align sidebar footer insets, center-panel radius formula, resize zone, and border tokens`
Files: `tokens.css`, `styles.css`, `Sidebar.tsx`, `SettingsDialog.tsx`, `SessionsBoard.tsx`
— Corrects center-panel radius to `window-radius − inset` (12px). Sidebar footer uses `--size-center-panel-*` tokens instead of hardcoded margins. Resize zone and border tokens tightened.
**Depends on:** FE-2

---

### FE-4 — Topbar board-icon spring animation
**`b110e0d57`** `feat: animate topbar board icon shift with Motion CSS variable`
Files: `CenterPanelShell.tsx`, `Sidebar.tsx`, `ui/sidebar.tsx`, `TitlebarNav.tsx`, `WindowTitlebar.tsx`, `_shell.tsx`
— Animates `--cp-titlebar-pl` via Framer Motion so the topbar icon slides with the sidebar spring instead of snapping. Adds `motion/react` dependency.
**Depends on:** FE-3

---

### FE-5 — Sidebar: no startup animation
**`ce254b6c`** `fix(sidebar): no startup animation — mount directly at correct open/closed state`
Files: `ui/sidebar.tsx`, `_shell.tsx`
— Removes mount-animation logic (14 lines deleted) so the sidebar snaps to its final state on boot. Must land before sidebar animation commits so the two don't conflict.
**Depends on:** FE-4

---

### FE-6 — Sidebar: section animations and card hover
**`04ac2446`** `fix: sidebar Pinned spacer, project/session height animations, settings button size`
**`cf363750`** `feat: sidebar project animations, card hover brightness, UX polish`
Files: `Sidebar.tsx`, `SessionsBoard.tsx`
— Height 0↔auto animations on project expand/collapse (y -12px, 0.14s). Per-session slide animation. Board card hover brightness via `color-mix`.
**Depends on:** FE-5

---

### FE-7 — Sidebar: floating peek
**`d633a8ca`** `feat(sidebar): peek shows real sidebar content via peekReveal offset`
Files: `Sidebar.tsx`, `CenterPane.tsx`, `SessionInspector.tsx`, `SettingsDialog.tsx`, `ShellTerminalsView.tsx`, `ShellTerminalTab.tsx`, `ui/command.tsx`, `ReverbTopbar.tsx`
— Adds `peekReveal` offset so hovering within 60px of the left edge slides the sidebar partially into view. Restructures `CenterPane` and `ShellTerminalsView` layout to support the overlay.
**Depends on:** FE-6

---

### FE-8 — Sidebar: scrollable projects + micro-fixes
**`5012db40`** `fix(sidebar): make projects container scrollable`
**`c295d17c`** `fix(sidebar): match the search field radius to the cards`
**`2b3e1d3f`** `fix: reduce sidebar project children left indent`
Files: `Sidebar.tsx` (all three)
— Projects `motion.div` overflow: `hidden` → `clip` so the list scrolls. Search field `rounded-md` → `rounded-lg`. Session child indent `ml-3.5 pl-7` → `ml-1.5 pl-3`.
**Depends on:** FE-7 (or FE-5 if landing separately — all touch only `Sidebar.tsx`)

---

### FE-9 — Dead code removal
**`852a6f18`** `feat(animations): …dead code` (dead code portion only)
Files deleted: `DashboardSubhead.tsx`, `MigrationSection.tsx`, `OrchestratorActivityIndicator.tsx`, `settings/SettingsPanel.tsx`, `settings/SettingsPageShell.tsx`, `hooks/useEventsConnection.ts`
— Removes 6 files with no remaining imports after the FE-2 rewrite. Pure deletion, no new logic.
**Depends on:** FE-2 (files became orphaned by it)
**Note:** This commit also adds animations (see FE-10 below) — it should be split if landing separately.

---

### FE-10 — Modal and popover animations + Button press feedback
**`852a6f18`** (animation portion)
Files: `ui/button.tsx`, `ui/context-menu.tsx`, `ui/dropdown-menu.tsx`, `ui/popover.tsx`, `ui/sheet.tsx`, `ui/sidebar.tsx`, `ui/tooltip.tsx`, `styles.css`
— `animate-modal-in/out` keyframes on all modals. `popover-in/out` keyframe (scale 0.95→1, blur 4→0) on all menus and popovers. `active:not-aria-[haspopup]:scale-[0.97]` and `translate-y-px` press feedback on `Button`.
**Depends on:** FE-2

---

### FE-11 — Context menu and dropdown styling
**`c77bd2489`** `feat(context-menu): brighter bg, padded container, gap-px, no separators`
Files: `ui/context-menu.tsx`, `Sidebar.tsx`
— `ContextMenuContent` gets `bg-card p-[3px] gap-px`. Removes 3 lines of manual separator config from `Sidebar.tsx`.
**Depends on:** FE-10 (consistent with popover style from FE-10)

---

### FE-12 — New task modal
**`ac3256f9`** `fix(new-task): match textarea to Input styles, add exit animation, fix tab order`
**`164176492`** `fix(new-task): remove textarea resize handle`
Files: `NewTaskDialog.tsx`
— Textarea styled identically to `Input`. Exit animation. Tab order: title → brief → submit. `resize-none`.
**Depends on:** FE-2

---

### FE-13 — Settings modal chrome polish
**`d3b5ccb7`** `fix(settings): remove sidebar header title + border, nav starts directly`
**`00115eec`** `fix(settings): remove top padding from sidebar nav`
**`2ecf5355`** `fix(settings): add small Settings label above sidebar nav`
**`944866d7`** `fix(settings): transparent row bg in dark mode, dimmer dialog border (7%→3%)`
Files: `SettingsDialog.tsx`, `styles.css`, `tokens.css`
— Drops the large "Settings" heading and border. Removes top padding. Adds 10px dimmed label. Settings rows transparent background. Dialog border dimmed 7%→3%.
**Depends on:** FE-2

---

### FE-14 — Project settings sub-pages
**`f888834f`** `feat(settings): project settings sub-pages + brighter context menu icons`
Files: `ProjectSettingsForm.tsx`, `SettingsDialog.tsx`, `ui/context-menu.tsx`
— Splits project settings into four sub-pages (General, Agents, Workflow, Intake) using the same sidebar nav pattern as global settings. Context menu icons use `text-muted-foreground`.
**Depends on:** FE-13

---

### FE-15 — Topbar: unified action row + bell badge
**`e74c2af6`** `feat(topbar): unified action row, plain bell + red badge, brighter dark overlays`
Files: `NotificationCenter.tsx`, `ShellTopbar.tsx`, `tokens.css`
— Bell is always plain `Bell` icon. Red badge with count. Separator between orchestrator and bell removed. `--color-overlay-subtle` token updated for brighter dark overlays.
**Depends on:** FE-2

---

### FE-16 — Press feedback on interactive elements
**`6b0766ca`** `feat(press-feedback): scale-on-active across sidebar tracks, board cards, topbar, settings nav`
Files: `Sidebar.tsx`, `SessionsBoard.tsx`, `SettingsDialog.tsx`, `styles.css`
— `active:scale-[0.97]` on sidebar buttons and settings nav. `active:scale-[0.98]` on board cards. `transform` added to `Button` transition in `styles.css`.
**Depends on:** FE-10 (extends the press feedback introduced there)

---

### FE-17 — Global scrollbar hide
**`4dde3bda`** `fix(ui): hide all scrollbars app-wide via global * rule`
Files: `styles.css`
— Adds `* { scrollbar-width: none }` + `*::-webkit-scrollbar { display: none }`. All scrollbars gone app-wide; content remains scrollable.
**Depends on:** FE-2 (any point after the base styles are in)

---

### FE-18 — Select component styling
**`10b2bae9`** `fix(select): bg-card styling, single checkmark, Input-matched trigger`
Files: `ui/select.tsx`, `CreateProjectAgentSheet.tsx`
— `SelectContent` → `bg-card`. `SelectTrigger` matches `Input` border and height. Single checkmark owned by `SelectItem`.
**Depends on:** FE-2

---

### FE-19 — Board card elevation
**`201873f16`** `fix(board): card bg → bg-card for dark mode elevation`
Files: `SessionsBoard.tsx`
— Two-line change: session cards use `bg-card` instead of `bg-surface`.
**Depends on:** FE-2

---

### FE-20 — Named colour themes
**`edc05009`** `feat(themes): named palettes with a normalised contrast curve`
Files: `tokens.css` (+299 lines), `GeneralSettingsSection.tsx`, `SettingsOptionMenu.tsx`, `apply-initial-theme.ts`, `theme.ts` (new), `ui-store.ts`, `_shell.tsx`
— Separate theme and mode selectors in General settings. Five palettes (GitHub, Catppuccin, Dracula, Tokyo Night, Rosé Pine). Surfaces re-derived from canonical background to trace the same contrast curve. Applied before first paint.
**Depends on:** FE-13 (needs the settings UI), FE-2 (tokens)

---

### FE-21 — Inspector spring animation + unified tab styles
**`65691d61`** `feat(ui): right inspector spring animation, unified tab styles, optimistic tab close`
Files: `SessionView.tsx`, `CenterPane.tsx`, `ShellTerminalTab.tsx`, `ShellTerminalsView.tsx`, `useShellTerminals.ts`, `styles.css`
— Inspector slides in/out with a spring. Tabs unified across the app. Tab close is optimistic. Removes 12 lines of overriding tab styles from `styles.css`.
**Depends on:** FE-7 (shares `CenterPane` and `ShellTerminalsView` restructure)

---

### FE-22 — Board: agent logo refactor chain
**`90a9bb0ea`** `fix(board): keep single-colour agent logos legible in both themes`
**`6d5dd8d9`** `fix(board): shrink agent logos to 16px and even out their visual size`
**`41be66a4`** `refactor(board): drive agent marks from a registry instead of inlined paths`
Files: `AgentAvatar.tsx`, `agent-logos.ts` (new), `agent-logos.test.ts` (new), `styles.css` + 24 SVG assets
— Light/dark-aware fill logic for monochrome logos. Size normalised to 16px with per-logo optical overrides. All inline SVG paths extracted into a `lib/agent-logos.ts` registry.
**Depends on:** FE-2

---

### FE-23 — Board: status pill removal chain
**`c8e6bca9`** `fix(board): declutter task cards — drop the redundant status pill`
**`039955e02`** `test(e2e): assert card identity/column, not the removed status pill`
**`dc06ec65`** `fix(board): address review — keep refining status + real diff source`
**`df55dc77`** `fix(board): drop the per-card status pill entirely (author design call)`
**`65a61b7d`** `a11y(board): keep the task status in the card's accessible name (sr-only)`
Files: `SessionsBoard.tsx`, `SessionsBoard.test.tsx`, `smoke-board.spec.ts`, `Sidebar.tsx`, `styles.css`, `tokens.css`
— Sequential chain. Each commit removes more of the status pill or responds to review feedback. Must land in order.
**Depends on:** FE-2, FE-22 (logos refactor is referenced in same file)

---

### FE-24 — Board test fixtures
**`eae2046ad`** `test(board): cover every lane and harness in the browser-preview fixtures`
Files: `lib/mock-data.ts`, `tokens.css`
— Expands `mock-data.ts` with fixtures for every lane and harness. No production code changes.
**Depends on:** FE-23

---

### FE-25 — Board: archive toggle + board micro-fixes (frontend portion of `8f0faf9c`)
**`8f0faf9c`** (frontend portion only)
Files: `SessionsBoard.tsx`, `CenterPane.tsx`, `GlobalSettingsForm.tsx`, `ShellTerminalTab.tsx`, `ShellTerminalsView.tsx`
— Introduces the archive toggle button on the board. `ShellTerminalTab` and `ShellTerminalsView` micro-fixes.
**Depends on:** FE-21 (shares `ShellTerminalTab` restructure), FE-19

---

### FE-26 — Board: column header polish + archive animation
**`b1fcf086`** `fix(board): polish column headers, archive animation, topbar spacing`
Files: `SessionsBoard.tsx`, `styles.css`
— Column headers: sentence-case sans-serif, 10×10 rounded-square indicators. Archive header is a full-width button with height 0↔auto animation. Idle column collapses with the same animation. Double-border fixed. Cards: default cursor, no bottom divider, gap below last working card.
**Depends on:** FE-25

---

### FE-27 — Board tests updated for revamp
**`1969314e`** `test: fix SessionsBoard test assertions after UI revamp`
Files: `SessionsBoard.tsx`, `SessionsBoard.test.tsx`
— Font class assertions (`font-mono uppercase` → `font-sans`), border class (`border-y` → `border-b`), archive button regex, restores `role="group"`, removes stale assertion.
**Depends on:** FE-26

---

### FE-28 — Topbar spacing + kill button icon-only
**`f843f9c8`** `fix: remove hardcoded pr-4/pr-4.5 from topbar containers`
**`1615a575`** / **`ba98d97f`** — topbar `padding-inline-end` 4px → 2px
**`7d5b7339`** / **`83813e9a`** — bell button `mr-[2px]` → `mr-1` (4px)
**`1b25e654`** `fix: style kill button as icon-only with tooltip to match topbar buttons`
Files: `SessionsBoard.tsx`, `TopbarButton.tsx`, `styles.css`, `NotificationCenter.tsx`, `ShellTopbar.tsx`
— Removes hardcoded right padding from topbar containers. Sets `padding-inline-end: 2px` on `.reverb-topbar`. Adds `mr-1` to bell button. Converts kill button to `variant="icon"` with a tooltip.
**Depends on:** FE-15, FE-26

---

## Merge / test plumbing (not standalone PRs)

**`961078f7`** — Extracts `SessionTerminationDialog`, adapts `TopbarButton`, fixes `ui-store` types after upstream merges.
**`704470fd`** — Repairs 53 test failures from upstream cherry-picks.
**`6047473e`** / **`6a441928`** — Upstream `main` merge commits and conflict resolution.
**`ad5f6f556`** / **`c30ecf506`** — This doc.
