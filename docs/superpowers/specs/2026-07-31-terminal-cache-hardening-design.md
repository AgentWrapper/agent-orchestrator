# Terminal cache hardening

## Goal

Retain the exact user-visible terminal state across navigation without allowing
stale routed targets, duplicate attachments, hidden input, recovery regressions,
or unbounded transport growth.

## Ownership

A retained renderer is owned by:

- the logical workspace session (or standalone shell);
- the terminal kind;
- the opaque runtime handle; and
- an explicit generation when a handle can be reused (shell creation time or
  reviewer run batch).

The route must validate that a selected reviewer or shell belongs to the
currently rendered session before a cache entry can be created. Authoritative
workspace and shell data remove entries when a session disappears, a handle or
generation changes, or the shell closes. A same-handle transient WebSocket
reconnect keeps the existing xterm and its buffer.

Visited live terminals remain retained for the lifetime of their authoritative
session instead of being evicted by count. This preserves exact state for any
number of visited sessions. Renderers are still created lazily, only when a
terminal is first visited.

## Transport and interaction

All retained terminal attachments share one browser-to-daemon mux WebSocket.
Each attachment still owns its own handle listeners, writer, replay state, and
cleanup lease. Losing the shared socket causes each live attachment to reacquire
one replacement shared socket without duplicating handle writers.

A parked or preparing terminal remains connected for output but is inert,
blurred, hidden from accessibility, and unable to forward keyboard, paste,
drop, wheel, or resize input. It becomes interactive only after its viewport
has been synchronized and its first correct frame is ready.

There is no protocol acknowledgement that a SIGWINCH-driven application repaint
has reached the browser. Preparation therefore never fits or resizes the PTY.
If reparenting changed the available grid, the retained frame is painted while
still inert and the normal interactive fit path performs the resize afterward.

## Viewport restoration

Parking captures xterm's canonical logical state:

- bottom-follow when `viewportY === baseY`; or
- a marker for the historical top line.

Activation reparents the retained container while hidden, applies current local
font metrics, restores the canonical anchor, synchronizes the public DOM
scrollbar to that logical position, renders, and exposes that settled frame
while the entry remains `aria-hidden`, inert, and unable to send input. After a
browser paint boundary the entry becomes interactive. A changed grid is fitted
only in that final phase, because local render completion cannot prove that a
remote TUI repaint has landed.

Exact restoration is bounded by xterm's existing 5,000-line scrollback. If
hidden output evicts the marker, activation clamps to the oldest line still in
the retained buffer. It never animates or repeatedly walks through intermediate
rows. The fix does not reduce the terminal history available today.

## Errors, exits, and notifications

Pane errors dispose the failed attachment but keep xterm and scrollback
mounted. Terminated sessions retain their ended strip and Restore controls;
active sessions retain the error banner until authoritative session state
changes. Renderer initialization failures are discarded when their pane is
left. Exited content remains inspectable without a live writer.

URL detection reads live visibility state. Output from a parked worker marks
the Browser tab unseen even if that session's persisted inspector preference is
Browser.

Reviewer targets carry a run-batch generation. A newly spawned reviewer that
reuses the same opaque handle cannot inherit an exited renderer from an older
run. The daemon persists that generation beside the handle only after Spawn or
Notify succeeds; a preflight, spawn, or notify failure cannot assign an
unlaunched batch to the previous live handle. Existing databases cannot prove
which historical run owned their stored handle, so migration uses that handle
as an opaque legacy generation rather than inferring from run history. The next
successful launch replaces it with its batch generation. While a reviewer
renderer is retained, the provider polls the authoritative session reviews
endpoint every 2.5 seconds, including while the window is in the background. A
superseded parked renderer is disposed immediately. A superseded active renderer
stays inspectable until the user leaves it, then is disposed, so an asynchronous
ownership update cannot blank the selected terminal. Sessions whose reviewer
terminal has never been visited add no review polling.

## Verification

Unit and real-xterm Chromium coverage will exercise:

- stale A-to-B reviewer and shell targets;
- fatal pane errors with Restore controls intact;
- hidden URL output;
- same-handle reconnect preserving buffer, viewport, and selection;
- reviewer generation replacement, including an authoritative background
  update while parked;
- one shared mux socket with independent writers and reconnect cleanup;
- six visited sessions, rapid A-B-A, hidden and return-time output;
- bottom and historical anchors, grid changes, and frame-sensitive reveal;
- marker eviction beyond 5,000 lines clamping to the oldest retained content;
- authoritative session removal, handle replacement, and provider teardown.

Focused tests run first, followed by the relevant frontend suite, typecheck,
build, and the isolated Chromium specification.

## Platform boundary

Windows ConPTY replays a raw, bounded scrollback snapshot on every fresh host
connection. Retaining xterm removes navigation-time reattachment, so ordinary
session switching is covered. A genuine mux reconnect can still replay lines
already present in the retained xterm because the ConPTY protocol carries no
sequence or resume offset. Clearing or text matching would destroy viewport
state or misclassify valid repeated output. Exact ConPTY reconnect
reconciliation therefore requires a versioned transport-level replay boundary
or offset and is outside this frontend ownership change.
