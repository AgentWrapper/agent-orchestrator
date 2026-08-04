# Browser Tab Overlay Recovery Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Prevent a captured Browser-menu frame from remaining over the newly selected native browser tab.

**Architecture:** Keep Electron main as the authority for tab activation and bounds. Make the renderer-owned tabs menu explicitly finish its mirror lifecycle, and remove the redundant tab-switch screenshot so menu teardown and tab selection cannot race two stale image layers.

**Tech Stack:** Electron 33 `WebContentsView`, React 19, TypeScript, Radix DropdownMenu, Vitest, Testing Library.

## Global Constraints

- Keep the change limited to issue #3445; do not add the PR #3444 `+` button or shortcuts.
- Preserve snapshot/mirror behavior for overlays and browser pop-out transitions.
- Do not change daemon APIs, persistence, or generated artifacts.
- Follow test-driven development: observe each behavior test fail before editing production code.
- Verify in the real isolated Electron desktop app on Windows.

---

### Task 1: Make browser overlay cleanup explicit

**Files:**
- Modify: `frontend/src/renderer/hooks/useBrowserView.ts`
- Test: `frontend/src/renderer/hooks/useBrowserView.test.tsx`

**Interfaces:**
- Consumes: existing `prepareForOverlay(): Promise<void>`, `scheduleSettleMeasure(): void`, and browser bridge `selectTab({ viewId, tabId })`.
- Produces: `BrowserViewModel.finishOverlay(): void`; `selectTab(tabId)` no longer captures a `tab-switch` frame.

- [ ] **Step 1: Replace the old tab-transition expectation with a failing no-snapshot test**

Replace `holds a captured frame while selecting a tab so the native handoff does not flash` with:

```tsx
it("switches tabs without placing the outgoing tab over the selected tab", async () => {
	const bridge = setupBridge();
	const { result } = renderHook(() => useBrowserView({ sessionId: "sess-1", active: true, poppedOut: false }));
	await waitFor(() => expect(result.current.viewId).toBe("42:sess-1"));
	act(() =>
		bridge.emit({
			viewId: "42:sess-1",
			url: "http://localhost:3000/",
			title: "First tab",
			canGoBack: false,
			canGoForward: false,
			isLoading: false,
		}),
	);

	await act(() => result.current.selectTab("t2"));

	expect(bridge.selectTab).toHaveBeenCalledWith({ viewId: "42:sess-1", tabId: "t2" });
	expect(bridge.capture).not.toHaveBeenCalled();
	expect(result.current.visualTransition).toBeNull();
});
```

- [ ] **Step 2: Run the focused hook test and verify RED**

Run:

```powershell
cd frontend
npm.cmd test -- src/renderer/hooks/useBrowserView.test.tsx -t "switches tabs without placing"
```

Expected: FAIL because `selectTab` calls `showVisualTransition`, so `bridge.capture` is called.

- [ ] **Step 3: Add a failing explicit-cleanup test**

Add beside `primes a browser frame before opening renderer overlays above the native view`:

```tsx
it("explicitly finishes a prepared overlay and restores the live view", async () => {
	const bridge = setupBridge();
	const slot = createSlot();
	const { result } = renderHook(() => useBrowserView({ sessionId: "sess-1", active: true, poppedOut: false }));
	await waitFor(() => expect(result.current.viewId).toBe("42:sess-1"));
	act(() =>
		bridge.emit({
			viewId: "42:sess-1",
			url: "http://localhost:3000/",
			title: "First tab",
			canGoBack: false,
			canGoForward: false,
			isLoading: false,
		}),
	);
	act(() => result.current.slotRef(slot));
	await act(() => result.current.prepareForOverlay());
	expect(result.current.mirrorUrl).toBe("data:image/jpeg;base64,snapshot");

	bridge.setBounds.mockClear();
	act(() => {
		(result.current as typeof result.current & { finishOverlay?: () => void }).finishOverlay?.();
	});

	expect(result.current.mirrorUrl).toBe("");
	await waitFor(() =>
		expect(bridge.setBounds).toHaveBeenCalledWith({
			viewId: "42:sess-1",
			rect: { x: 12, y: 34, width: 320, height: 240 },
			visible: true,
		}),
	);
});
```

- [ ] **Step 4: Run the explicit-cleanup test and verify RED**

Run:

```powershell
npm.cmd test -- src/renderer/hooks/useBrowserView.test.tsx -t "explicitly finishes"
```

Expected: FAIL because `finishOverlay` is absent and the held `mirrorUrl` remains set.

- [ ] **Step 5: Implement the minimal hook behavior**

Add `finishOverlay` to `BrowserViewModel`, implement it next to `prepareForOverlay`, and return it:

```tsx
const finishOverlay = useCallback(() => {
	modalOpenRef.current = false;
	mirrorTokenRef.current += 1;
	clearMirrorTimer();
	stopMirrorStream();
	setMirrorUrl("");
	setVisualTransition(null);
	clearVisualTransitionTimer();
	scheduleSettleMeasure();
}, [clearMirrorTimer, clearVisualTransitionTimer, scheduleSettleMeasure, stopMirrorStream]);
```

Change `selectTab` to invoke the bridge directly:

```tsx
const selectTab = useCallback(
	async (tabId: string) => {
		const viewId = viewIdRef.current;
		if (!viewId || !hasNativeBrowser) return;
		const state = await window.ao!.browser.selectTab({ viewId, tabId });
		if (viewIdRef.current === state.viewId) setTabsState(state);
	},
	[hasNativeBrowser],
);
```

- [ ] **Step 6: Run the hook suite and verify GREEN**

Run:

```powershell
npm.cmd test -- src/renderer/hooks/useBrowserView.test.tsx
```

Expected: PASS. Delete the obsolete `does not block tab switching on a slow transition capture` test because tab selection no longer performs a capture; retain pop-out transition coverage.

- [ ] **Step 7: Commit Task 1**

```powershell
git add frontend/src/renderer/hooks/useBrowserView.ts frontend/src/renderer/hooks/useBrowserView.test.tsx
git commit -m "fix(browser): make overlay cleanup explicit"
```

---

### Task 2: Tie the controlled tabs menu to overlay cleanup

**Files:**
- Modify: `frontend/src/renderer/components/BrowserPanel.tsx`
- Test: `frontend/src/renderer/components/BrowserPanel.test.tsx`

**Interfaces:**
- Consumes: `BrowserViewModel.finishOverlay(): void` from Task 1.
- Produces: a controlled tab-selection path that closes the dropdown and always releases its captured frame.

- [ ] **Step 1: Extend the hook mock and write the failing selection-cleanup assertion**

Add `finishOverlay: vi.fn()` to `hookState`, return it from the mocked `useBrowserView`, and reset it through the existing `vi.clearAllMocks()` setup. Extend `shows a compact tab count and lets the user select and close tabs`:

```tsx
await userEvent.click(tabsButton);
await userEvent.click(screen.getByText("First app"));
await waitFor(() => expect(hookState.selectTab).toHaveBeenCalledWith("t1"));
expect(hookState.finishOverlay).toHaveBeenCalled();
expect(screen.queryByRole("menu")).not.toBeInTheDocument();
```

- [ ] **Step 2: Run the focused panel test and verify RED**

Run:

```powershell
npm.cmd test -- src/renderer/components/BrowserPanel.test.tsx -t "compact tab count"
```

Expected: FAIL because `BrowserPanel` does not call `finishOverlay`.

- [ ] **Step 3: Implement controlled selection cleanup**

Destructure `finishOverlay` from `browserView`. Make menu close idempotently release its captured presentation:

```tsx
const handleTabsMenuOpenChange = useCallback(
	(next: boolean) => {
		if (!next) {
			setTabsMenuOpen(false);
			finishOverlay();
			return;
		}
		void openTabsMenu();
	},
	[finishOverlay, openTabsMenu],
);

const handleSelectTab = useCallback(
	async (tabId: string) => {
		setTabsMenuOpen(false);
		try {
			await selectTab(tabId);
		} catch {
			// The existing tab remains active; overlay cleanup still runs below.
		} finally {
			finishOverlay();
		}
	},
	[finishOverlay, selectTab],
);
```

Change the tab item to `onSelect={() => void handleSelectTab(tab.id)}`.

- [ ] **Step 4: Add and run the rejected-selection cleanup test**

Add:

```tsx
it("releases the tabs overlay when tab selection fails", async () => {
	hookState.tabs = [
		{ id: "t1", url: "http://localhost:3000/", title: "First app", active: true },
		{ id: "t2", url: "http://localhost:4173/", title: "Second app", active: false },
	];
	hookState.selectTab.mockRejectedValueOnce(new Error("selection failed"));
	render(<BrowserPanel active onTogglePopOut={() => undefined} poppedOut={false} session={session} />);

	await userEvent.click(screen.getByRole("button", { name: "Browser tabs (2)" }));
	await userEvent.click(screen.getByText("Second app"));

	await waitFor(() => expect(hookState.finishOverlay).toHaveBeenCalled());
	expect(screen.queryByRole("menu")).not.toBeInTheDocument();
});
```

Run:

```powershell
npm.cmd test -- src/renderer/components/BrowserPanel.test.tsx
```

Expected: PASS without an unhandled rejection.

- [ ] **Step 5: Run both renderer suites and commit Task 2**

```powershell
npm.cmd test -- src/renderer/hooks/useBrowserView.test.tsx src/renderer/components/BrowserPanel.test.tsx
git add frontend/src/renderer/components/BrowserPanel.tsx frontend/src/renderer/components/BrowserPanel.test.tsx
git commit -m "fix(browser): release tab menu mirror on selection"
```

---

### Task 3: Lock down native tab activation invariants

**Files:**
- Test: `frontend/src/main/browser-view-host.test.ts`

**Interfaces:**
- Consumes: existing agent action `host.execute(sessionId, "tab-select", { tabId })`.
- Produces: regression coverage proving main-process tab state and native visibility remain correct through repeated activation.

- [ ] **Step 1: Extend the existing stable-tab test with repeated selection**

After the first `tab-select` assertions in `keeps stable logical tab IDs, separate targets, and the selected tab active`, add:

```tsx
await host.execute("sess-1", "tab-select", { tabId: "t2" });
await host.execute("sess-1", "tab-select", { tabId: "t1" });
await host.execute("sess-1", "tab-select", { tabId: "t2" });

expect(views[0].setVisible).toHaveBeenLastCalledWith(false);
expect(views[0].setBounds).toHaveBeenLastCalledWith({
	x: -10_000,
	y: -10_000,
	width: 1280,
	height: 720,
});
expect(views[1].setVisible).toHaveBeenLastCalledWith(true);
```

This is characterization coverage for the unchanged main-process invariant; the renderer tests in Tasks 1 and 2 provide the failing regression tests for the production fix.

- [ ] **Step 2: Run the main-process browser host suite**

Run:

```powershell
npm.cmd test -- src/main/browser-view-host.test.ts
```

Expected: PASS, confirming no additional native stacking change is necessary.

- [ ] **Step 3: Commit Task 3**

```powershell
git add frontend/src/main/browser-view-host.test.ts
git commit -m "test(browser): cover repeated native tab activation"
```

---

### Task 4: Verify the complete fix

**Files:**
- Verify only; no generated artifacts or API changes expected.

**Interfaces:**
- Consumes: completed Tasks 1–3.
- Produces: automated and native Windows evidence that issue #3445 is resolved.

- [ ] **Step 1: Run all focused tests**

```powershell
cd frontend
npm.cmd test -- src/renderer/hooks/useBrowserView.test.tsx src/renderer/components/BrowserPanel.test.tsx src/main/browser-view-host.test.ts
```

Expected: PASS.

- [ ] **Step 2: Run frontend static and build gates**

```powershell
npm.cmd run typecheck
npm.cmd run build
```

Expected: both commands exit 0.

- [ ] **Step 3: Restart and manually reproduce in the real app**

Restart Electron because the hook/renderer should be checked from a clean state. Launch isolated dev mode with `npm.cmd run dev`, then from the visible AO session run:

```powershell
ao preview https://example.com
ao browser tab new https://google.com
ao browser tab new
```

Alternate repeatedly between the localhost, Google, and blank tabs. Verify the URL, selected checkmark, and visible content always match, and the tabs menu reopens after each selection.

- [ ] **Step 4: Inspect the final diff and working tree**

```powershell
git diff upstream/main...HEAD --check
git status --short
git log --oneline upstream/main..HEAD
```

Expected: only the design, plan, four frontend source/test files, and intended commits are present; no runtime data or generated artifacts appear.
