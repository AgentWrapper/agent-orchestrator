# Terminal cache hardening

## Goal

Retain each terminal and its latest output across navigation without allowing
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
drop, wheel, or PTY resize input. It becomes interactive only after its latest
viewport has been synchronized and its first correct frame is ready.

## Latest-output activation

Returning to a retained terminal always shows its latest output. The terminal
is a progress surface, so navigation does not preserve a historical viewport
the user happened to leave behind. Manual scrolling still works while the
terminal remains active, and the full 5,000-line xterm scrollback remains
available.

Activation reparents the retained container while hidden, fits xterm locally
to the destination slot, scrolls its logical buffer to the bottom, synchronizes
the public DOM scrollbar, renders, and crosses a paint boundary before reveal.
The terminal-session hook suppresses the fit-generated PTY resize while the
entry is preparing; the visible phase publishes one authoritative positive
grid. No historical row or intermediate reflow position can paint during the
switch.

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
- same-handle reconnect preserving buffer and selection;
- reviewer generation replacement, including an authoritative background
  update while parked;
- one shared mux socket with independent writers and reconnect cleanup;
- six visited sessions, rapid A-B-A, hidden and return-time output;
- latest-output activation, grid changes, and frame-sensitive reveal;
- hidden output beyond 5,000 lines still revealing the newest retained content;
- authoritative session removal, handle replacement, and provider teardown.

Focused tests run first, followed by the relevant frontend suite, typecheck,
build, and the isolated Chromium specification.

## Platform boundary

Windows ConPTY replays a raw, bounded scrollback snapshot on every fresh host
connection. Retaining xterm removes navigation-time reattachment, so ordinary
session switching is covered. A genuine mux reconnect can still replay lines
already present in the retained xterm because the ConPTY protocol carries no
sequence or resume offset. Clearing or text matching would destroy retained
scrollback or misclassify valid repeated output. Exact ConPTY reconnect
reconciliation therefore requires a versioned transport-level replay boundary
or offset and is outside this frontend ownership change.
