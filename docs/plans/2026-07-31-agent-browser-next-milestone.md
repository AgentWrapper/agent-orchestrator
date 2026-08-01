# Invisible agent browser integration

Status: implemented; cross-platform and manual acceptance pending

## Product outcome

AO's Browser should feel like one shared browser for the user and their agent.
The user opens the normal Browser panel and can watch or take over while the
agent navigates, inspects, clicks, types, waits, and verifies the page.

The integration must not expose implementation details. Users should not need
to know about agent-browser, CDP, ports, namespaces, feature flags, setup
commands, or a second browser automation interface.

## Scope for this milestone

1. Bundle a pinned, checksum-verified agent-browser binary for each supported
   desktop platform. Remove the manual preparation step and enable it by
   default.
2. Make agent-browser the single automation engine. Remove the experimental
   nested command and the legacy browser-automation fallback once parity is
   verified. Keep only the internal AO plumbing needed for targeting,
   permissions, and lifecycle management.
3. Bind the engine automatically to the current worker's visible browser.
   Connection details stay inside AO, and separate workers cannot accidentally
   target each other's pages.
4. Support the core loop reliably: navigation, compact semantic snapshots,
   element discovery, click/fill/type/keyboard actions, hover/focus/scroll/drag,
   state inspection, waits, tabs and popups, frames, dialogs, screenshots,
   console errors, and bounded network diagnostics.
5. Keep automation working while the Browser panel is hidden. Reconnect after
   navigation, renderer replacement, or a sidecar crash, and clean up every
   process and endpoint when the worker or AO closes.
6. Show only quiet product-level feedback: a subtle browser-activity state,
   optional temporary element highlighting, and clear reconnect/failure
   messages. Never show raw commands or connection details in the normal UI.

## Explicitly deferred

- Design Mode / point-to-code handoff.
- Named browser profiles and imported login identities.
- Responsive-device presets and emulation.
- Advanced downloads, PDF export, and video replay.
- Broad unrestricted JavaScript or credential access.

DevTools is now integrated as Chromium's own frontend. AO exposes it through a
direct browser-toolbar button, a keyboard shortcut, and `ao browser devtools`
commands. The agent and DevTools share a worker-scoped CDP multiplexer, while
agent-issued CDP remains policy-limited and user DevTools retains the normal
Chromium inspection/debugging surface.

The remaining deferred items should be designed after the invisible core is
stable. DevTools uses one direct browser-toolbar button plus the existing
shortcut and View menu; it opens as a detached desktop window with normal OS
window controls rather than a docked browser pane.

## Implementation approach

- Preserve the existing Browser panel and worker lifecycle rather than adding a
  new browser UI.
- Install the native binary as a packaged desktop resource and resolve it
  internally in development and packaged builds.
- Give each worker a private runtime namespace and bind it to that worker's
  browser target automatically.
- Keep browser output marked as untrusted external content and retain bounded
  output limits.
- Prefer the native agent-browser command behavior internally instead of
  maintaining a parallel AO command language.
- Remove the old path only after the native path passes the focused acceptance
  checks, so the final change has one engine without an intermediate regression.

## Focused validation

Automated checks should cover only the changed boundaries:

- packaged and development binary resolution;
- worker targeting and two-worker isolation;
- connection, reconnection, timeout, and shutdown cleanup;
- navigation plus snapshot/action/wait verification;
- tab and popup targeting;
- shared agent + Chromium DevTools attachment, including tab retargeting and
  normal detached-window close/reopen behavior;
- hidden-panel operation;
- safe error handling and output limits.

Manual acceptance:

1. Start AO normally with no setup command or environment flag.
2. Ask an agent to test a local web app without mentioning browser tooling.
3. Watch the agent operate the same visible Browser panel.
4. Take over manually, then let the agent continue from the resulting state.
5. Hide and reopen the panel and confirm the shared page state is preserved.
6. Run two workers and confirm their pages, tabs, cookies, and actions remain
   isolated.
7. Close the worker and AO and confirm no sidecar or debugging endpoint remains.

## Definition of done

A new user can ask an agent to test or debug a web application and watch it use
AO's built-in Browser without installing anything, enabling a flag, reading a
command, or learning which automation engine AO uses.
