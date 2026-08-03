# Session Terminal Top Bar Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Render one full-window session top bar whose terminal-specific controls track the live terminal pane bounds and whose permanent main-agent tab is visually prominent.

**Architecture:** Add a small portal host at shell scope so `CenterPane`, which owns terminal tabs and font controls, can render its header above the sidebar without lifting terminal state into the router. The shell becomes a header-plus-body column on session routes, while `CenterPane` measures its own live width and uses it as the maximum width of the terminal-specific region; the remaining header space carries session actions at the far right.

**Tech Stack:** React 19, TypeScript, TanStack Router, Tailwind CSS v4, Radix/shadcn primitives, Vitest, Testing Library, Electron Forge.

## Global Constraints

- Follow `DESIGN.md`: clone agent-orchestrator chrome, use shadcn primitives where appropriate, retain the refined blue accent only for meaningful live/focus states, and keep the terminal palette.
- The session top bar spans the full app window and pushes the sidebar and session workspace below it.
- Terminal tabs, New terminal, font-size controls, and fullscreen stay inside the live terminal pane x-axis.
- The main agent tab cannot close, is more prominent than auxiliary tabs, and is the only terminal tab with a harness avatar.
- Auxiliary terminal tabs retain close and rename behavior and do not receive harness avatars.
- Preserve terminal keyboard input behavior, tab keyboard navigation, tooltips, accessible names, zoom, fullscreen, and inspector controls.
- Do not add dependencies or change backend/API boundaries.

---

### Task 1: Add the shell-level session top-bar portal

**Files:**
- Create: `frontend/src/renderer/components/SessionTopbarPortal.tsx`
- Create: `frontend/src/renderer/components/SessionTopbarPortal.test.tsx`

**Interfaces:**
- Produces: `SessionTopbarProvider({ children }: { children: ReactNode })`, `SessionTopbarHost(props: ComponentProps<"div">)`, and `SessionTopbarPortal({ children }: { children: ReactNode })`.
- Behavior: a portal renders into the mounted host when the provider/host exist and renders inline when used in isolated component tests without a provider.

- [ ] **Step 1: Write the failing portal tests**

```tsx
it("renders session chrome into the shell host", () => {
  render(
    <SessionTopbarProvider>
      <SessionTopbarHost data-testid="host" />
      <SessionTopbarPortal><span>terminal tabs</span></SessionTopbarPortal>
    </SessionTopbarProvider>,
  );
  expect(within(screen.getByTestId("host")).getByText("terminal tabs")).toBeInTheDocument();
});

it("renders inline without a shell provider", () => {
  render(<SessionTopbarPortal><span>terminal tabs</span></SessionTopbarPortal>);
  expect(screen.getByText("terminal tabs")).toBeInTheDocument();
});
```

- [ ] **Step 2: Run the test and verify it fails**

Run: `cd frontend && npx vitest run src/renderer/components/SessionTopbarPortal.test.tsx`

Expected: FAIL because `SessionTopbarPortal.tsx` does not exist.

- [ ] **Step 3: Implement the provider, host, and portal**

Use a nullable host element in context, a callback ref on `SessionTopbarHost`, `createPortal(children, host)` when registered, and the inline fallback when no provider is present. Merge the callback ref with an optional caller ref so the host remains a normal `div` component.

- [ ] **Step 4: Run the portal tests and verify they pass**

Run: `cd frontend && npx vitest run src/renderer/components/SessionTopbarPortal.test.tsx`

Expected: PASS.

### Task 2: Give session routes a full-width header row

**Files:**
- Modify: `frontend/src/renderer/routes/_shell.tsx`
- Modify: `frontend/src/renderer/components/Sidebar.tsx`
- Modify: `frontend/src/renderer/styles.css`
- Modify: `frontend/src/renderer/components/Sidebar.test.tsx`

**Interfaces:**
- Consumes: `SessionTopbarProvider` and `SessionTopbarHost` from Task 1.
- Produces: `SidebarProps.topbarOffset` accepts `"session"`; `[data-topbar-offset="session"]` resolves to `--size-inspector-tabs`.

- [ ] **Step 1: Write the failing sidebar-offset test**

Add a test that renders `Sidebar` with `underTopbar` and `topbarOffset="session"`, then asserts its fixed container has `data-topbar-offset="session"`.

- [ ] **Step 2: Run the focused test and verify it fails**

Run: `cd frontend && npx vitest run src/renderer/components/Sidebar.test.tsx`

Expected: FAIL at TypeScript transform/behavior because `"session"` is not an accepted offset.

- [ ] **Step 3: Implement the shell row**

Wrap the shell contents in `SessionTopbarProvider`. Make the `SidebarProvider` a column. On session routes, render `SessionTopbarHost` as a full-width `h-inspector-tabs` row, then render the existing sidebar and `main` inside a new `flex min-h-0 flex-1` body row. Pass `topbarOffset="session"` for session routes so the fixed sidebar begins below the new bar. Add:

```css
[data-topbar-offset="session"] {
  --sidebar-chrome-offset: var(--size-inspector-tabs);
}
```

Keep titlebar navigation, daemon banner, overlay sidebar, and non-session route branches in their existing ownership positions.

- [ ] **Step 4: Run shell/sidebar tests and verify they pass**

Run: `cd frontend && npx vitest run src/renderer/components/Sidebar.test.tsx src/renderer/components/ShellTopbar.test.tsx`

Expected: PASS.

### Task 3: Portal and constrain the terminal top bar

**Files:**
- Modify: `frontend/src/renderer/components/CenterPane.tsx`
- Modify: `frontend/src/renderer/components/CenterPane.test.tsx`

**Interfaces:**
- Consumes: `SessionTopbarPortal` from Task 1 and the existing `paneRef` terminal container.
- Produces: `data-testid="session-terminal-region"` for the terminal-bounded header area and `data-testid="session-action-region"` for the far-right session controls.

- [ ] **Step 1: Write failing layout tests**

Add assertions that:

```tsx
const terminalRegion = screen.getByTestId("session-terminal-region");
expect(terminalRegion).toContainElement(screen.getByRole("tablist", { name: "Open terminals" }));
expect(terminalRegion).toContainElement(screen.getByRole("button", { name: "New terminal" }));
expect(terminalRegion).toContainElement(screen.getByRole("toolbar", { name: "Terminal display controls" }));
expect(terminalRegion).not.toContainElement(screen.getByTestId("session-action-region"));
```

Also assert the tab list no longer has `pt-1.5`, and an unavailable left/right overflow button is absent instead of invisibly reserving width.

- [ ] **Step 2: Run the focused tests and verify they fail**

Run: `cd frontend && npx vitest run src/renderer/components/CenterPane.test.tsx`

Expected: FAIL because the header is still local to `CenterPane`, the regions do not exist, and hidden scroll buttons remain mounted.

- [ ] **Step 3: Implement the portaled header and width tracking**

Observe `paneRef.current` with `ResizeObserver`, store the latest content width, and wrap the header in `SessionTopbarPortal`. Render a full-width neutral header with:

```tsx
<div className="flex h-inspector-tabs w-full ...">
  <div className={isSidebarOpen ? "w-(--sidebar-width)" : "w-0"} />
  <div className="flex min-w-0 flex-1">
    <div data-testid="session-terminal-region" style={{ width: terminalWidth }} className="flex min-w-0 shrink ...">
      {tabsAndTerminalControls}
    </div>
    <div data-testid="session-action-region" className="ml-auto flex shrink-0 ...">
      {topbarActions}
    </div>
  </div>
</div>
```

Allow the terminal region to shrink before the action region when there is no inspector. Remove the local header from the terminal column so the terminal body begins directly below the shell bar. Conditionally render each overflow arrow only when its direction is scrollable. Preserve existing tab/zoom/fullscreen handlers and tooltip content.

- [ ] **Step 4: Run the CenterPane tests and verify they pass**

Run: `cd frontend && npx vitest run src/renderer/components/CenterPane.test.tsx`

Expected: PASS.

### Task 4: Refine permanent and auxiliary terminal tabs

**Files:**
- Modify: `frontend/src/renderer/components/CenterPane.tsx`
- Modify: `frontend/src/renderer/components/ShellTerminalTab.tsx`
- Modify: `frontend/src/renderer/components/CenterPane.test.tsx`
- Modify: `frontend/src/renderer/components/ShellTerminalTab.test.tsx`

**Interfaces:**
- Main agent tab: permanent `role="tab"`, harness avatar, activity label, no close button.
- Auxiliary tab: standard terminal glyph/title, optional close button, no `AgentAvatar`.

- [ ] **Step 1: Write failing tab-identity tests**

Assert that the main agent tab has an `img[aria-hidden="true"]`, has no descendant close button, and uses the prominent neutral active classes without `before:bg-accent`. Render auxiliary tabs and assert their tab containers have no harness image, retain `Close <title>` buttons, and also omit the blue active hairline. Assert the activity-dot wrapper has an explicit optical-centering class.

- [ ] **Step 2: Run both tab test files and verify they fail**

Run: `cd frontend && npx vitest run src/renderer/components/CenterPane.test.tsx src/renderer/components/ShellTerminalTab.test.tsx`

Expected: FAIL on the blue active hairline, missing prominence/centering classes, or avatar/close identity assertions.

- [ ] **Step 3: Implement the approved tab styling**

Remove the blue `before` hairline from both connected tab variants. Give the main tab a persistent restrained surface/border, medium label weight, and stronger active neutral fill so it remains the workspace anchor even when an auxiliary terminal is active. Keep `AgentAvatar` only in `SessionPaneTab`; never pass it into `ShellTerminalTab`. Keep the main tab free of an `onClose` callback. Use a `leading-none` label row and direct flex centering for the activity dot; give the auxiliary terminal glyph its own optical adjustment.

- [ ] **Step 4: Run both tab test files and verify they pass**

Run: `cd frontend && npx vitest run src/renderer/components/CenterPane.test.tsx src/renderer/components/ShellTerminalTab.test.tsx`

Expected: PASS.

### Task 5: Regression and live-app verification

**Files:**
- Modify if test expectations require it: `frontend/src/renderer/components/SessionView.test.tsx`
- Modify: `frontend/src/renderer/test/shell-new-session-shortcut.test.tsx`
- Update: PR screenshots and PR description through GitHub CLI

**Interfaces:**
- Verifies existing behavior only; no new production interface.

- [ ] **Step 1: Run focused terminal/session regression tests**

Add a shell integration case to the existing shell test that sets the route to a session, renders `_shell.tsx`, and asserts the `SessionTopbarHost` precedes the body row containing the sidebar and `<main>`. Assert the host has `h-inspector-tabs` and the sidebar receives `data-topbar-offset="session"`.

Run:

```bash
cd frontend && npx vitest run \
  src/renderer/test/shell-new-session-shortcut.test.tsx \
  src/renderer/components/SessionTopbarPortal.test.tsx \
  src/renderer/components/CenterPane.test.tsx \
  src/renderer/components/ShellTerminalTab.test.tsx \
  src/renderer/components/SessionView.test.tsx \
  src/renderer/components/ShellTopbar.test.tsx \
  src/renderer/components/XtermTerminal.test.tsx \
  src/renderer/lib/terminal-tabs.test.ts
```

Expected: PASS.

- [ ] **Step 2: Run finite frontend verification**

Run:

```bash
npm run frontend:typecheck
cd frontend && npx vite build --config vite.renderer.config.ts
cd frontend && npx vitest run
```

Expected: typecheck, build, and all frontend tests PASS.

- [ ] **Step 3: Verify in the already-running Electron development app**

Using the real local daemon/session, verify:

- the bar spans the full window and the sidebar begins below it,
- terminal controls remain over the terminal while dragging the sidebar and inspector split,
- the main agent tab has the sole harness avatar, is visually prominent, and has no close affordance,
- the activity dot is vertically centered,
- New terminal opens an auxiliary tab,
- auxiliary tabs select, rename, and close,
- zoom and fullscreen still respond,
- Kill, Orchestrator, inspector, and notification controls remain at the far right,
- terminal paste and Ctrl+Arrow navigation remain functional.

- [ ] **Step 4: Capture the after screenshot and update the PR**

Capture the full session view with the revised bar and at least one auxiliary terminal open. Add the screenshot to the PR body beside the existing before image and retain references to issues #3479 and #3303.

- [ ] **Step 5: Commit and push**

```bash
git add frontend docs/superpowers/plans/2026-08-03-session-terminal-topbar.md
git commit -m "feat(frontend): span session terminal bar across window"
git push
```

- [ ] **Step 6: Check PR status**

Run: `gh pr checks 3480 --watch`

Expected: all required PR checks PASS. Fix any in-scope failure before reporting completion.
