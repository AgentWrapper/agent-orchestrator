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

## Viewport restoration

Parking captures xterm's canonical logical state:

- bottom-follow when `viewportY === baseY`; or
- a marker for the historical top line.

Activation reparents the retained container while hidden, fits locally only
when the grid changed, restores the canonical anchor, synchronizes the public
DOM scrollbar to that logical position, renders, crosses a paint boundary, and
only then reveals the container.

Exact restoration is bounded by xterm's existing 5,000-line scrollback. If
hidden output evicts the marker, activation clamps to the oldest line still in
the retained buffer. It never animates or repeatedly walks through intermediate
rows. The fix does not reduce the terminal history available today.

## Errors, exits, and notifications

Pane errors dispose the failed attachment but keep xterm, scrollback, the ended
strip, and session Restore controls mounted. Renderer initialization failures
are discarded when their pane is left. Exited content remains inspectable
without a live writer.

URL detection reads live visibility state. Output from a parked worker marks
the Browser tab unseen even if that session's persisted inspector preference is
Browser.

Reviewer targets carry a run-batch generation. A newly spawned reviewer that
reuses the same opaque handle cannot inherit an exited renderer from an older
run.

## Verification

Unit and real-xterm Chromium coverage will exercise:

- stale A-to-B reviewer and shell targets;
- fatal pane errors with Restore controls intact;
- hidden URL output;
- same-handle reconnect preserving buffer, viewport, and selection;
- reviewer generation replacement;
- one shared mux socket with independent writers and reconnect cleanup;
- six visited sessions, rapid A-B-A, hidden and return-time output;
- bottom and historical anchors, grid changes, and frame-sensitive reveal;
- marker eviction beyond 5,000 lines clamping to the oldest retained content;
- authoritative session removal, handle replacement, and provider teardown.

Focused tests run first, followed by the relevant frontend suite, typecheck,
build, and the isolated Chromium specification.
