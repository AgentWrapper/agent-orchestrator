# UI Revamp — PR Breakdown

Commits on `feat/ui-revamp` that are original to this branch, grouped into small independently-mergeable PRs. Each entry lists the commit SHA, files changed, and exactly what the diff does.

---

## PR 1 — Reverb topbar wiring

**`368a8380`** `feat(frontend): unify Reverb workspace top bars`
Files: `ReverbTopbar.tsx`, `ShellTopbar.tsx`, `SessionView.tsx`, `SessionsBoard.tsx`, `CenterPane.tsx`, `NotificationCenter.tsx`, `SessionInspector.tsx`, `styles.css`, `tokens.css` (+42 files)
— Introduces the shared `ReverbTopbar` component and wires it into every surface (board, session, settings, browser). Adds `useReverbTopbarModel` hook. Writes the full topbar test suite (`ReverbTopbar.test.tsx`, `WindowTitlebar.test.tsx`, `TitlebarNav.test.tsx`).

---

## PR 2 — Design tokens, core layout, and board foundation

**`d722ce60`** `feat(ui): revamp board, topbar, sidebar, settings, and design tokens`
Files: `tokens.css`, `styles.css`, `SessionsBoard.tsx`, `Sidebar.tsx`, `SettingsDialog.tsx`, `GlobalSettingsForm.tsx`, many UI primitives, `DESIGN.md`, `ui-system-audit.md`
— Rewrites `tokens.css` (lighter borders, center-panel radius formula, sidebar tokens). Converts the board layout to the split-lane model. Converts settings from a page-route to a `SettingsDialog` modal. Seeds `dev-board-fixtures.ts` for dev testing. Removes `TopbarActivityStatus`. Updates shadcn primitives (`button`, `badge`, `card`, `tabs`, `input`, `switch`, `dialog`, `sidebar`).

**`5f066c63`** `fix(ui): align sidebar footer insets, center-panel radius formula, resize zone, and border tokens`
Files: `tokens.css`, `styles.css`, `Sidebar.tsx`, `SettingsDialog.tsx`, `SessionsBoard.tsx`
— Corrects center-panel radius to `window-radius − inset` (12px). Sidebar footer uses the correct `--size-center-panel-*` inset tokens instead of hardcoded margins. Resize zone width and border tokens tightened.

---

## PR 3 — Topbar board-icon animation

**`b110e0d5`** `feat: animate topbar board icon shift with Motion CSS variable`
Files: `CenterPanelShell.tsx`, `Sidebar.tsx`, `ui/sidebar.tsx`, `TitlebarNav.tsx`, `WindowTitlebar.tsx`, `_shell.tsx`
— Adds a Framer Motion CSS variable (`--cp-titlebar-pl`) so the topbar icon and title slide in sync with the sidebar spring instead of snapping. Cleans up `WindowTitlebar` and `TitlebarNav` to use the new variable.

---

## PR 4 — Sidebar: Pinned sections, project animations, peek

**`f3a5ccb4`** (implicitly folded into `d633a8c0` and `cf363750b` — sidebar chrome was built incrementally)

**`04ac2446`** `fix: sidebar Pinned spacer, project/session height animations, settings button size`
Files: `Sidebar.tsx`, `Sidebar.test.tsx`
— Adds height 0↔auto animations on project expand/collapse and per-session slide (y -12px, 0.14s). Fixes the Pinned spacer and settings button sizing.

**`cf363750`** `feat: sidebar project animations, card hover brightness, UX polish`
Files: `Sidebar.tsx`, `SessionsBoard.tsx`
— Adds card hover brightness (`color-mix` lightening in dark, darkening in light). Refines the fold/unfold timing and easing on project rows.

**`d633a8ca`** `feat(sidebar): peek shows real sidebar content via peekReveal offset`
Files: `Sidebar.tsx`, `CenterPane.tsx`, `SessionInspector.tsx`, `SettingsDialog.tsx`, `ShellTerminalsView.tsx`, `ShellTerminalTab.tsx`, `ui/command.tsx`, `ReverbTopbar.tsx`
— Implements the floating peek: hovering within 60px of the left edge slides the sidebar partially into view using a `peekReveal` CSS offset. Crossing 25px reveals it fully. Restructures `CenterPane` and `ShellTerminalsView` layout to support the overlay.

**`ce254b6c`** `fix(sidebar): no startup animation — mount directly at correct open/closed state`
Files: `ui/sidebar.tsx`, `_shell.tsx`
— Removes 14 lines of mount-animation logic so the sidebar snaps to its final open/closed position on boot instead of animating in on every route change.

**`5012db40`** `fix(sidebar): make projects container scrollable`
Files: `Sidebar.tsx`
— Changes the projects `motion.div` overflow from `hidden` to `clip` so the list scrolls when sessions overflow without trapping scroll events.

**`c295d17c`** `fix(sidebar): match the search field radius to the cards`
Files: `Sidebar.tsx`
— One-line change: search button `rounded-md` → `rounded-lg` to match project card corners.

**`2b3e1d3f`** `fix: reduce sidebar project children left indent`
Files: `Sidebar.tsx`
— `ml-3.5` → `ml-1.5` on the sub-menu container, `pl-7` → `pl-3` on each session item. Session rows sit closer to the left edge.

---

## PR 5 — Dead code removal

**`852a6f18`** `feat(animations): improve-animations audit — blur transitions, press feedback, popover curves, dead code`
Files deleted: `DashboardSubhead.tsx`, `MigrationSection.tsx`, `OrchestratorActivityIndicator.tsx`, `settings/SettingsPanel.tsx`, `settings/SettingsPageShell.tsx`, `hooks/useEventsConnection.ts`
Files updated: `ui/button.tsx`, `ui/context-menu.tsx`, `ui/dropdown-menu.tsx`, `ui/popover.tsx`, `ui/sheet.tsx`, `ui/sidebar.tsx`, `ui/tooltip.tsx`, `styles.css`
— Deletes 6 components/hooks with no remaining imports. Adds modal `animate-modal-in/out` keyframes. Adds `popover-in/out` keyframe (scale 0.95→1, blur 4→0) to all menus and popovers. Adds `active:scale-[0.97]` press feedback to `Button`.

---

## PR 6 — Context menu and dropdown menu styling

**`c77bd2489`** `feat(context-menu): brighter bg, padded container, gap-px, no separators`
Files: `ui/context-menu.tsx`, `Sidebar.tsx`
— `ContextMenuContent` gets `bg-card p-[3px] gap-px`. Removes 3 lines of manual separator config from `Sidebar.tsx` that are now handled by the menu primitive.

---

## PR 7 — Press feedback

**`6b0766ca`** `feat(press-feedback): scale-on-active across sidebar tracks, board cards, topbar, settings nav`
Files: `Sidebar.tsx`, `SessionsBoard.tsx`, `SettingsDialog.tsx`, `styles.css`
— Adds `active:scale-[0.97]` to sidebar buttons and settings nav items. Adds `active:scale-[0.98]` to board cards. Extends the `Button` transition in `styles.css` to include `transform`.

---

## PR 8 — Settings modal polish

**`d3b5ccb7`** `fix(settings): remove sidebar header title + border, nav starts directly`
Files: `SettingsDialog.tsx`
— Removes the large "Settings" heading and border-bottom, cutting 4 lines.

**`00115eec`** `fix(settings): remove top padding from sidebar nav`
Files: `SettingsDialog.tsx`
— Removes `pt-2` above the nav list.

**`2ecf5355`** `fix(settings): add small Settings label above sidebar nav`
Files: `SettingsDialog.tsx`
— Adds a dimmed `text-[10px]` "Settings" label directly above the nav buttons as a minimal anchor.

**`944866d7`** `fix(settings): transparent row bg in dark mode, dimmer dialog border (7%→3%)`
Files: `styles.css`, `tokens.css`
— Settings row background set to transparent. Dialog overlay border dimmed from 7% to 3% alpha.

**`f888834f`** `feat(settings): project settings sub-pages + brighter context menu icons`
Files: `ProjectSettingsForm.tsx`, `SettingsDialog.tsx`, `ui/context-menu.tsx`
— Splits project settings into four sub-pages (General, Agents, Workflow, Intake) using the same sidebar nav pattern as global settings. Context menu icons use `text-muted-foreground` and brighten on focus.

---

## PR 9 — New task modal

**`ac3256f9`** `fix(new-task): match textarea to Input styles, add exit animation, fix tab order`
Files: `NewTaskDialog.tsx`
— Textarea styled with matching border, ring, and background. `resize-none`. Tab order title → brief → submit. Exit animation matches settings modal.

**`164176492`** `fix(new-task): remove textarea resize handle`
Files: `NewTaskDialog.tsx`
— One-line `resize-none` correction (the previous commit left the handle; this removes it).

---

## PR 10 — Select component

**`10b2bae9`** `fix(select): bg-card styling, single checkmark, Input-matched trigger`
Files: `ui/select.tsx`, `CreateProjectAgentSheet.tsx`
— `SelectContent` → `bg-card`. `SelectTrigger` matches `Input` border and height. Removes the duplicate checkmark so only `SelectItem` owns it.

---

## PR 11 — Global scrollbar hide

**`4dde3bda`** `fix(ui): hide all scrollbars app-wide via global * rule`
Files: `styles.css`
— Adds 11 lines: `* { scrollbar-width: none }` + `*::-webkit-scrollbar { display: none }`. All scrollbars gone app-wide; content remains scrollable.

---

## PR 12 — Topbar unified action row

**`e74c2af6`** `feat(topbar): unified action row, plain bell + red badge, brighter dark overlays`
Files: `NotificationCenter.tsx`, `ShellTopbar.tsx`, `tokens.css`
— Bell is always plain `Bell` icon. Unread badge is `bg-red-500` with a count. Removes the separator between orchestrator icon and bell. Updates `--color-overlay-subtle` token for brighter dark overlays.

---

## PR 13 — Board: card elevation

**`201873f1`** `fix(board): card bg → bg-card for dark mode elevation`
Files: `SessionsBoard.tsx`
— Two-line change: session cards get `bg-card` instead of `bg-surface`.

---

## PR 14 — Board: status pill removal and card cleanup

**`c8e6bca9`** `fix(board): declutter task cards — drop the redundant status pill`
Files: `SessionsBoard.tsx`, `SessionsBoard.test.tsx`
— Removes the per-card status badge (status is already encoded by the column). Tests updated.

**`90a9bb0ea`** `fix(board): keep single-colour agent logos legible in both themes`
Files: `AgentAvatar.tsx`
— Adds light/dark-aware fill logic so monochrome logos (Claude, Gemini) invert correctly.

**`6d5dd8d9`** `fix(board): shrink agent logos to 16px and even out their visual size`
Files: `AgentAvatar.tsx`
— Logo size normalised to 16px. Per-logo optical size overrides (Claude is 14px, Gemini 18px, etc.).

**`41be66a4`** `refactor(board): drive agent marks from a registry instead of inlined paths`
Files: `AgentAvatar.tsx`, `agent-logos.ts` (new), `agent-logos.test.ts` (new), `styles.css` + 24 SVG assets
— Extracts all inline SVG paths into a `lib/agent-logos.ts` registry. `AgentAvatar` resolves logos from the registry. Adds unit tests. Adds CSS for inline SVG sizing.

**`65a61b7d`** `a11y(board): keep the task status in the card's accessible name (sr-only)`
Files: `SessionsBoard.tsx`, `SessionsBoard.test.tsx`
— Adds a visually-hidden `<span>` with the status label inside each card so screen readers announce it. Tests cover the sr-only text.

**`df55dc77`** `fix(board): drop the per-card status pill entirely (author design call)`
Files: `SessionsBoard.tsx`, `SessionsBoard.test.tsx`, `smoke-board.spec.ts`
— Removes the remaining status pill element from the card DOM entirely. E2e smoke assertions updated.

**`dc06ec65`** `fix(board): address review — keep refining status + real diff source`
Files: `SessionsBoard.tsx`, `SessionsBoard.test.tsx`, `Sidebar.tsx`, `styles.css`, `tokens.css`, `smoke-board.spec.ts`
— Wires real diff data into the card (not fixture). Refines status label. Tightens column tokens.

---

## PR 15 — Board: column headers, archive animation, idle collapse

**`8f0faf9c`** `feat(ui): archive toggle, search button, topbar tweaks, dev fixtures`
Files: `SessionsBoard.tsx`, `CenterPane.tsx`, `GlobalSettingsForm.tsx`, `ShellTerminalTab.tsx`, `ShellTerminalsView.tsx`, `tmux.go`, `tmux_test.go`
— Introduces the archive toggle button and the collapsible idle column in the board. Tmux: unsets `CI`/`NO_COLOR`/`FORCE_COLOR` inside panes so terminal colours work.

**`b1fcf086`** `fix(board): polish column headers, archive animation, topbar spacing`
Files: `SessionsBoard.tsx`, `styles.css`
— Column headers: sentence-case sans-serif, 10×10 rounded-square indicators. Archive header is a full-width `<button>` with height 0↔auto animation and rotating chevron. Idle header button collapses sessions with the same animation. Double-border between adjacent headers fixed. Session cards: default cursor, no bottom divider, gap below last working card. Topbar `padding-inline-end` set to 2px. Notification button moved to rightmost position.

**`1969314e`** `test: fix SessionsBoard test assertions after UI revamp`
Files: `SessionsBoard.test.tsx`, `SessionsBoard.tsx`
— Updates font class assertions (`font-mono uppercase` → `font-sans`), border class (`border-y` → `border-b`), archive button regex (`/archive/i` → `/^archive,/i`), restores `role="group"` inside the collapsible button. Removes a stale `not.toBeInTheDocument` assertion.

---

## PR 16 — Board: test fixtures

**`eae2046ad`** `test(board): cover every lane and harness in the browser-preview fixtures`
Files: `lib/mock-data.ts`, `tokens.css`
— Expands `mock-data.ts` by 189 lines with fixtures for every board lane (idle, working, needs-review, merged, archived) and every agent harness. Used by browser-preview dev mode.

**`039955e02`** `test(e2e): assert card identity/column, not the removed status pill`
Files: `e2e/smoke-board.spec.ts`, `e2e/smoke-sessions.spec.ts`
— Updates e2e assertions to use `data-column` and card title instead of the removed status pill text.

---

## PR 17 — Inspector animation and tab styles

**`65691d61`** `feat(ui): right inspector spring animation, unified tab styles, optimistic tab close`
Files: `SessionView.tsx`, `SessionView.test.tsx`, `CenterPane.tsx`, `CenterPane.test.tsx`, `ShellTerminalTab.tsx`, `ShellTerminalsView.tsx`, `useShellTerminals.ts`, `styles.css`
— Inspector slides in/out with a spring. Tab styles unified across the app. Tab close is optimistic. Removes 12 lines from `styles.css` that were overriding tab styles. `SessionView.test.tsx` cut from 333 lines to a focused set.

---

## PR 18 — Named colour themes

**`edc05009`** `feat(themes): named palettes with a normalised contrast curve`
Files: `tokens.css`, `GeneralSettingsSection.tsx`, `SettingsOptionMenu.tsx`, `apply-initial-theme.ts`, `theme.ts` (new), `ui-store.ts`, `_shell.tsx`
— Adds 299 lines to `tokens.css` for 5 palettes (GitHub, Catppuccin, Dracula, Tokyo Night, Rosé Pine). Separate theme and mode selectors in General settings. `theme.ts` derives surfaces from the canonical background so every palette traces the same contrast curve. Applied before first paint in `apply-initial-theme.ts`.

---

## PR 19 — macOS app icon

**`5ab515f08`** `chore: update macOS app icon to flat full-bleed square`
**`c46970391`** `chore: shrink icon — 82% scale with transparent border so Dock size matches other apps`
Files: icon assets only (binary, no code changes)
— New icon artwork. Then scaled to 82% with transparent border so macOS squircle mask clips it at the correct visual weight.

---

## PR 20 — Topbar spacing + kill button

**`f843f9c8`** `fix: remove hardcoded pr-4/pr-4.5 from topbar containers`
Files: `SessionsBoard.tsx`, `TopbarButton.tsx`
— Removes `pr-4.5` and `pr-4` hardcoded on the two topbar container divs.

**`1615a575`** / **`ba98d97f`** `fix: topbar right padding`
Files: `styles.css`
— Sets `padding-inline-end` from `4px` → `0px` → `2px` on `.reverb-topbar`.

**`7d5b7339`** / **`83813e9a`** `fix: bell button right margin`
Files: `NotificationCenter.tsx`
— Adds `mr-[2px]` then `mr-1` (4px) to the bell `TopbarButton`.

**`1b25e654`** `fix: style kill button as icon-only with tooltip to match topbar buttons`
Files: `ShellTopbar.tsx`
— Converts the kill button from a labeled red button (`variant="kill"` + text) to `variant="icon"` with `text-error/70`, wrapped in a `Tooltip`. Matches the style of all other topbar actions.

---

## Merge / test plumbing (not standalone PRs)

**`961078f7`** — Extracts `SessionTerminationDialog`, adapts `TopbarButton`, fixes `ui-store` types after merging upstream PRs.
**`704470fd`** — Repairs 53 test failures introduced by upstream cherry-picks: notification mock, project settings form, board integration tests.
**`6047473e`** / **`6a441928`** — Upstream `main` merge commits and conflict resolution (`SessionFilesView`, `SessionView`, `SessionView.test`).
