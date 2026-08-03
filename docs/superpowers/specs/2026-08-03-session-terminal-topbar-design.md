# Session Terminal Top Bar Design

## Goal

Replace the session view's fragmented terminal and action chrome with one intentional top bar that spans the app window, while keeping terminal-specific controls horizontally bounded to the terminal pane.

## Approved layout

- The session top bar spans the full app window and sits above both the sidebar and session workspace.
- The sidebar and the complete session workspace begin below the bar.
- The bar has three visual regions whose boundaries follow the live layout below it:
  1. shell/sidebar chrome,
  2. terminal tabs and terminal controls,
  3. session-level actions at the far right.
- The terminal region starts at the terminal pane's left edge and ends at its live right edge. Terminal tabs, New terminal, font-size controls, and fullscreen must never extend into the sidebar or inspector regions.
- Session actions such as Kill, Orchestrator, inspector visibility, and notifications remain grouped at the far right of the full-width bar.
- The existing resizable sidebar and inspector remain authoritative for horizontal boundaries. The header follows those widths instead of introducing a second independent split.

## Terminal tabs

- Remove the top padding above the tabs and the permanently reserved space for invisible scroll buttons.
- Replace the blue selected-tab hairline with a quiet neutral selected surface, brighter text, and restrained border treatment consistent with the inspector tabs.
- The main agent session tab is a permanent workspace anchor:
  - it is always the first terminal tab,
  - it cannot be closed,
  - it receives stronger neutral emphasis than auxiliary terminals,
  - it alone displays the configured harness avatar,
  - its activity indicator appears directly after the label and is optically centered with the text.
- Auxiliary shell terminals use the standard terminal glyph/text treatment, retain per-tab close actions, and do not display a harness avatar.
- Existing tab keyboard behavior, rename behavior, overflow scrolling, and shell creation/closure behavior remain unchanged.

## Controls and interaction

- New terminal remains an explicit labeled action adjacent to terminal tabs.
- Font decrease, current size, font increase, and fullscreen remain in the terminal region.
- Existing tooltips, accessible names, pressed states, keyboard shortcuts, and focus-visible treatments remain intact.
- The terminal palette and terminal canvas are unchanged.
- Existing terminal input behavior, including the Ctrl+Arrow and Ctrl+V fixes associated with issue #2586, is outside the chrome refactor and must not regress.

## Responsive behavior

- The terminal tab list is the flexible/overflowing element. It yields space before terminal controls do.
- Overflow arrows only occupy layout space when scrolling in that direction is possible.
- The terminal controls stay inside the terminal region at all sidebar and inspector sizes.
- The session action cluster stays pinned to the right edge and may not overlap the terminal controls.
- macOS traffic-light and drag-region behavior, Windows custom-titlebar behavior, fullscreen behavior, and sidebar hover-preview behavior must continue to work.

## Verification

- Component tests cover the full-width session-header host, terminal-region containment, permanent main agent tab, harness-avatar exclusivity, neutral active styling, activity-indicator alignment, and conditional overflow controls.
- Existing CenterPane, SessionView, ShellTopbar, shell-route, terminal tab navigation, and xterm input tests remain green.
- Frontend typecheck and finite test/build commands pass.
- In the live Electron app connected to the local daemon, verify that the sidebar begins below the bar; sidebar and inspector resizing keep terminal controls aligned; the main agent tab is prominent and not closable; auxiliary terminals can be opened, selected, renamed, and closed; and the activity indicator is vertically centered.

