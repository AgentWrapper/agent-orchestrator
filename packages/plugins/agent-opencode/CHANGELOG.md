# @aoagents/ao-plugin-agent-opencode

## 0.5.0

### Patch Changes

- Updated dependencies [dd07b6b]
  - @aoagents/ao-core@0.5.0

## 0.4.0

### Patch Changes

- 4701122: opencode: bound /tmp blast radius and consolidate session-list cache

  Addresses review feedback on PR #1478:
  - **TMPDIR isolation.** Every `opencode` child we spawn now points at
    `~/.agent-orchestrator/.bun-tmp/` via `TMPDIR`/`TMP`/`TEMP`. Bun's
    embedded shared-library extraction lands there instead of the system
    `/tmp`, so the cli janitor only ever sweeps AO-owned files. Other
    users' or other applications' Bun artifacts on a shared host can no
    longer be touched by the regex.
  - **Single shared session-list cache.** Core and the agent-opencode
    plugin previously kept independent caches; per poll cycle the system
    spawned at least two `opencode session list` processes instead of
    one. Both consumers now use the shared cache exported from
    `@aoagents/ao-core` (`getCachedOpenCodeSessionList`).
  - **TTL no longer covers the send-confirmation loop.** The cache TTL
    dropped from 3s to 500ms so the
    `updatedAt > baselineUpdatedAt` delivery signal in
    `sendWithConfirmation` actually fires. Concurrent callers still
    share the in-flight promise.
  - **Delete invalidates the cache.** `deleteOpenCodeSession` now calls
    `invalidateOpenCodeSessionListCache()` on success so reuse, remap,
    and restore code paths cannot observe a deleted session id within
    the TTL window.
  - **Janitor reliability.** `sweepOnce` now filters synchronously
    before allocating per-file promises (matters on hosts with thousands
    of `/tmp` entries), and `stopBunTmpJanitor()` is now async and awaits
    any in-flight sweep so SIGTERM cannot exit while `unlink` is mid-flight.
  - **Janitor observability.** The sweep callback in `ao start` now logs
    successful reclaims, not just errors, so operators can confirm the
    janitor is doing useful work.

- Updated dependencies [2306078]
- Updated dependencies [faaddb1]
- Updated dependencies [f330a1e]
- Updated dependencies [a862327]
- Updated dependencies [331f1ce]
- Updated dependencies [703d584]
- Updated dependencies [f674422]
- Updated dependencies [62353eb]
- Updated dependencies [bd36c7b]
- Updated dependencies [e7ad928]
- Updated dependencies [ca8c4cc]
- Updated dependencies [7b82374]
- Updated dependencies [4701122]
- Updated dependencies [c8af50f]
- Updated dependencies [bcdda4b]
- Updated dependencies [1cbf657]
- Updated dependencies [c447c7c]
- Updated dependencies [a45eb32]
- Updated dependencies [7072143]
- Updated dependencies [ed2dcea]
  - @aoagents/ao-core@0.4.0

## 0.2.0

### Patch Changes

- 3a650b0: Zero-friction onboarding: `ao start` auto-detects project, generates config, and launches dashboard — no prompts, no manual setup. Renamed npm package to `@composio/ao`. Made `@composio/ao-web` publishable with production entry point. Cross-platform agent detection. Auto-port-finding. Permission auto-retry in shell scripts.
- Updated dependencies [3a650b0]
  - @composio/ao-core@0.2.0
