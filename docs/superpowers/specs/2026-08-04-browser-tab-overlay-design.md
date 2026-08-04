# Browser Tab Overlay Recovery Design

**Issue:** [#3445](https://github.com/Untrivial-ai/agent-orchestrator/issues/3445)

**Goal:** Ensure that selecting a browser tab always reveals that tab's own content and leaves the tabs menu usable.

## Problem

AO renders each browser tab in a native Electron `WebContentsView`. Renderer menus cannot naturally appear above that native surface, so `useBrowserView` captures the active page, parks the native view off-screen, and displays the capture while a renderer overlay is open.

The issue reproduces on Windows with three tabs. After selecting a blank or localhost tab, the address bar and active-tab state change, but the viewport continues to show a Google page from the previous tab. AO's empty-page text can appear over the Google content, and later tab selections can stop working.

That mixed rendering identifies the stale layer as renderer-owned captured content rather than the selected tab's live `WebContentsView`. Reordering child views and hiding all inactive native views cannot remove a renderer snapshot, which explains why those earlier approaches did not resolve the bug.

## Current Flow

1. `BrowserPanel` warms a captured frame before opening the tabs dropdown.
2. `useBrowserView` observes the open Radix menu, marks an overlay active, and parks the native view.
3. `selectTab` captures another transition frame and invokes the main-process `browser:selectTab` handler.
4. `activateTab` hides the prior native view, updates `activeTabId`, and applies the session bounds to the selected view.
5. Renderer cleanup depends on observing the menu's closing DOM mutation and delayed timers that clear `mirrorUrl` and `visualTransition`.

The problematic boundary is step 5: tab selection has no explicit ownership of overlay cleanup. A missed or reordered Radix mutation can leave the session parked and its previous capture visible even though main-process tab state advanced correctly.

## Considered Approaches

### 1. Explicit tab-menu cleanup and no tab-switch transition — recommended

Treat the tabs dropdown as a controlled overlay. When it closes or selects an item, explicitly end its captured-frame lifecycle, clear the held mirror, stop mirror work, and restore the current native view's bounds. Remove `showVisualTransition("tab-switch")`; tab switches do not change viewport geometry and therefore do not need the maximize/pop-out handoff animation.

This is surgical, removes the racing snapshot layer, and retains snapshot handling for overlays and pop-out transitions that genuinely need it.

### 2. Strengthen native view hiding and stacking

Hide every inactive view and re-add the active child view to the top of Electron's content stack. Both variants were attempted during issue triage and did not eliminate the reproduction because the incorrect pixels can come from a renderer image after the native views are already correct.

### 3. Remove captured overlay rendering entirely

Never park the native view or mirror it for menus. This would let `WebContentsView` paint over renderer-owned dropdowns and dialogs, regressing the overlay behavior fixed by earlier browser-panel work.

## Design

### Overlay lifecycle

`useBrowserView` will expose `finishOverlay(): void` alongside `prepareForOverlay()`. The callback will:

- invalidate any active mirror loop;
- cancel delayed mirror cleanup;
- stop a mirror stream;
- clear `mirrorUrl` immediately;
- clear any tab-switch transition frame;
- mark the overlay presentation inactive; and
- schedule the native view to be measured and restored at the selected tab's current bounds.

The existing DOM observer remains as a fallback for other menus and dialogs. Correctness for the controlled tabs menu will no longer depend on that observer noticing Radix's `data-state` transition.

### Tab selection

`BrowserPanel` will close its controlled dropdown before invoking tab selection. Its tab-selection handler will call `finishOverlay()` in a `finally` block, and its `onOpenChange(false)` path will call the same idempotent function when the menu closes without a selection. A rejected IPC request therefore cannot leave a captured page covering the panel.

`useBrowserView.selectTab` will call `browser.selectTab` directly without creating a `tab-switch` visual transition. The main process remains the authority for `activeTabId`, native bounds, and visibility.

### Native activation invariant

The main-process activation path will retain the invariant that the previous view is hidden and moved off-screen before the selected view receives session bounds. A regression test will exercise repeated alternating selection and assert this invariant, without adding new production stacking behavior.

### Failure behavior

If tab selection fails, the tabs state remains unchanged, but renderer cleanup still removes the mirror and restores the currently active native view. Existing IPC error handling remains unchanged; this fix does not add a new error surface.

## Testing

### Renderer hook tests

- Selecting a tab does not capture or create a `tab-switch` visual transition.
- Ending the tabs overlay clears a held `mirrorUrl`, cancels mirror work, and requests visible bounds again.
- Cleanup still runs when `browser.selectTab` rejects.

### Browser panel tests

- Selecting a dropdown item closes the controlled menu and invokes the requested tab ID.
- Closing the menu without selecting also ends the prepared overlay.

### Main-process tests

- Repeated `t2 -> t3 -> t2 -> t3` activation hides the previous view and leaves only the selected view at visible session bounds.
- Selecting a blank tab reports that tab's navigation state while the prior Google tab remains hidden.

### Manual verification

On Windows 11 in the real isolated Electron app:

1. Open a session Browser panel.
2. Create a Google tab and a blank tab with `ao browser tab new`.
3. Alternate between them using the tabs dropdown.
4. Confirm the URL, selected checkmark, and viewport always agree.
5. Confirm the dropdown can be reopened after every selection.
6. Repeat with rapid switching and reduced-motion enabled.

Run `npm run typecheck`, the focused Vitest suites for `useBrowserView`, `BrowserPanel`, and `browser-view-host`, then `npm run build`.

## Non-goals

- Adding the `+` tab button or keyboard shortcuts from PR #3444.
- Changing browser command APIs, daemon routes, or persistence.
- Replacing Electron `WebContentsView`.
- Refactoring overlay handling outside the browser panel.
