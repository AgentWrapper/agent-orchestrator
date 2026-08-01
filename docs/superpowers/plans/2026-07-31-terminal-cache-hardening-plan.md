# Terminal cache hardening implementation plan

1. Add failing unit tests for routed-target ownership, fatal recovery UI,
   background URL badges, reconnect preservation, generation replacement, and
   mux pooling.
2. Add failing real-xterm Chromium assertions for a single shared socket,
   reconnect state, latest-output activation after scrollback eviction, and hidden/preparing
   interaction.
3. Make reviewer and shell targets carry their session/generation identity and
   reject mismatched targets synchronously.
4. Keep attachment errors inside `AttachedTerminal`, preserving xterm and
   recovery controls while disposing only the failed transport.
5. Read current visibility from a ref in the URL watcher.
6. Remove same-handle reconnect clearing and add reviewer-generation
   replacement.
7. Add a lease-based shared terminal mux pool at the cache-provider boundary.
8. Fit retained terminals locally while hidden, scroll xterm and its public DOM
   viewport to the latest output, and reveal only after the bottom frame settles.
9. Keep preparing terminals transport-inert so local fitting cannot resize the
   PTY; publish the positive authoritative grid only in the visible phase.
10. Poll authoritative review ownership only while a reviewer renderer is
    retained, with handle and generation persisted together after a successful
    launch, and dispose it when a newer batch or handle supersedes it.
11. Run focused tests, Chromium, the relevant frontend suite, typecheck, build,
    diff review, and leak/focus/input self-review.
