# Feature 4 Animation Fidelity Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Feature 4 visually match the landing Hero and animate the real existing-project Project Settings → Agents workflow with accurately targeted cursor clicks.

**Architecture:** Keep the landing demo self-contained and simulated. Move the choreography into a typed scene module, render a compact Hero-matched shell plus a settings view in `ProjectAgentsDemo.tsx`, and resolve cursor positions from semantic DOM targets instead of percentage guesses.

**Tech Stack:** React 19, TypeScript 6, motion/react, lucide-react, Next Image, Vitest, Testing Library.

## Global Constraints

- Preserve checkpoint commit `b3ec4ffb1` as the rollback point.
- Copy the Hero preview's exact dark tokens, sidebar dimensions, spacing, project-row anatomy, and action cluster; do not invent a third visual language.
- The flow is existing project → kebab → Project settings → Agents → worker Codex to Cursor → orchestrator Codex to Claude Code → Save changes → Saving… → Saved.
- Do not use the sidebar `+`, create-project modal, issue-intake form, or “Create and start” copy.
- Keep the demo presentational: no daemon, router, mutation, or Electron bridge calls.
- Autoplay pauses while out of view; reduced motion renders the saved settings frame.
- Every scripted click must target a mounted element and show both cursor press and a visible ripple.
- No new dependency.

---

### Task 1: Typed settings-flow choreography

**Files:**
- Create: `frontend/src/landing/src/app/components/FeaturesSection/components/ProjectAgentsDemo/ProjectAgentsDemo.scenes.ts`
- Create: `frontend/src/landing/src/app/components/FeaturesSection/components/ProjectAgentsDemo/ProjectAgentsDemo.scenes.test.ts`
- Modify: `frontend/src/landing/src/app/components/FeaturesSection/components/ProjectAgentsDemo/ProjectAgentsDemo.tsx`

**Interfaces:**
- Produces: `CursorTarget`, `ProjectAgentsScene`, `PROJECT_AGENT_SCENES`, `SAVED_PROJECT_AGENT_SCENE`, and `cursorPositionForRects(root, target)`.
- Consumes: no runtime state outside the demo.

- [ ] **Step 1: Write the failing scene-order and cursor-geometry tests**

```ts
import { cursorPositionForRects, PROJECT_AGENT_SCENES } from "./ProjectAgentsDemo.scenes";

test("follows the existing-project settings journey", () => {
	expect(PROJECT_AGENT_SCENES.map((scene) => scene.id)).toEqual([
		"board-idle", "project-hover", "actions-click", "settings-click",
		"settings-open", "worker-click", "worker-hover", "worker-pick",
		"orchestrator-click", "orchestrator-hover", "orchestrator-pick",
		"save-hover", "save-click", "saving", "saved", "reset",
	]);
	expect(PROJECT_AGENT_SCENES.filter((scene) => scene.click).map((scene) => scene.target)).toEqual([
		"project-actions", "project-settings", "worker-trigger", "worker-cursor",
		"orchestrator-trigger", "orchestrator-claude", "save",
	]);
});

test("places the cursor tip at the measured target center", () => {
	const root = { left: 100, top: 40, width: 500, height: 300 };
	const target = { left: 200, top: 100, width: 40, height: 20 };
	expect(cursorPositionForRects(root, target)).toEqual({ x: 24, y: 23.333333333333332 });
});
```

- [ ] **Step 2: Run the focused test and verify RED**

Run: `npm --prefix frontend test -- --run src/landing/src/app/components/FeaturesSection/components/ProjectAgentsDemo/ProjectAgentsDemo.scenes.test.ts`

Expected: FAIL because `ProjectAgentsDemo.scenes.ts` does not exist.

- [ ] **Step 3: Implement the typed scene table and geometry helper**

```ts
export type CursorTarget =
	| "board-idle" | "project-row" | "project-actions" | "project-settings"
	| "worker-trigger" | "worker-cursor" | "orchestrator-trigger"
	| "orchestrator-claude" | "save";

export function cursorPositionForRects(root: Rect, target: Rect) {
	return {
		x: ((target.left + target.width / 2 - root.left) / root.width) * 100,
		y: ((target.top + target.height / 2 - root.top) / root.height) * 100,
	};
}
```

Define the complete 16-scene table with durable view/menu/agent/save state on every scene, and export the final saved frame separately for reduced motion.

- [ ] **Step 4: Run the focused test and verify GREEN**

Run: `npm --prefix frontend test -- --run src/landing/src/app/components/FeaturesSection/components/ProjectAgentsDemo/ProjectAgentsDemo.scenes.test.ts`

Expected: PASS with 2 tests.

- [ ] **Step 5: Commit the scene model**

```bash
git add frontend/src/landing/src/app/components/FeaturesSection/components/ProjectAgentsDemo
git commit -m "test(landing): define feature 4 settings flow"
```

### Task 2: Hero-matched shell and project settings surface

**Files:**
- Modify: `frontend/src/landing/src/app/components/FeaturesSection/components/ProjectAgentsDemo/ProjectAgentsDemo.tsx`
- Create: `frontend/src/landing/src/app/components/FeaturesSection/components/ProjectAgentsDemo/ProjectAgentsDemo.test.tsx`
- Reference: `frontend/src/landing/src/app/components/HeroSection/components/AppMockup/AppMockup.tsx:58`
- Reference: `frontend/src/landing/src/app/components/HeroSection/components/AppMockup/AppMockup.tsx:1299`
- Reference: `frontend/src/renderer/components/Sidebar.tsx:552`
- Reference: `frontend/src/renderer/components/ProjectSettingsForm.tsx:260`

**Interfaces:**
- Consumes: `ProjectAgentsScene` and `CursorTarget` from Task 1.
- Produces: semantic elements marked `data-cursor-target="<CursorTarget>"` for every scene target.

- [ ] **Step 1: Write a reduced-motion render regression test**

Render the real `ProjectAgentsDemo` with `matchMedia('(prefers-reduced-motion: reduce)')` returning `matches: true`. Assert that the static saved frame exposes the Settings title, project path, Agents heading, both default-agent row labels, Cursor, Claude Code, Save changes, and Saved. Assert that Create and start and Enable issue intake are absent. Mock only `next/image` at the framework boundary if Vitest cannot render it directly.

- [ ] **Step 2: Run the focused test and verify RED**

Run: `npm --prefix frontend test -- --run src/landing/src/app/components/FeaturesSection/components/ProjectAgentsDemo/ProjectAgentsDemo.test.tsx`

Expected: FAIL because the checkpoint still renders the create-project sheet.

- [ ] **Step 3: Replace the board shell with the Hero visual recipe**

Use the Hero's exact `oklch` token values, darker `--sidebar` equivalent, 12px labels, 36px project row, `FolderOpen`, and the three action icons. Render the project actions dropdown beside the kebab with `New session`, `Project settings`, and `Remove project`; only `Project settings` is highlighted during its scene.

- [ ] **Step 4: Replace the modal with the compact settings page**

Render the real anatomy: `Settings` header and project path, `Agents` section, bare settings-option triggers, inline menus with real icons/status text, refresh row, Save button, Saving label, and Saved success text. Preserve the selected worker/orchestrator values across later scenes.

- [ ] **Step 5: Run both focused tests and verify GREEN**

Run: `npm --prefix frontend test -- --run src/landing/src/app/components/FeaturesSection/components/ProjectAgentsDemo/ProjectAgentsDemo.scenes.test.ts src/landing/src/app/components/FeaturesSection/components/ProjectAgentsDemo/ProjectAgentsDemo.test.tsx`

Expected: PASS and no create-flow copy remains.

- [ ] **Step 6: Commit the visual correction**

```bash
git add frontend/src/landing/src/app/components/FeaturesSection/components/ProjectAgentsDemo
git commit -m "fix(landing): match feature 4 to project settings"
```

### Task 3: Target-anchored cursor and visible clicks

**Files:**
- Modify: `frontend/src/landing/src/app/components/FeaturesSection/components/ProjectAgentsDemo/ProjectAgentsDemo.tsx`
- Test: `frontend/src/landing/src/app/components/FeaturesSection/components/ProjectAgentsDemo/ProjectAgentsDemo.scenes.test.ts`

**Interfaces:**
- Consumes: `scene.target`, `scene.click`, and `cursorPositionForRects`.
- Produces: cursor coordinates measured from `[data-cursor-target]` elements after every scene/layout change.

- [ ] **Step 1: Add a failing assertion that every click scene has a unique semantic target**

```ts
for (const scene of PROJECT_AGENT_SCENES.filter((candidate) => candidate.click)) {
	expect(scene.target).not.toBe("board-idle");
}
```

- [ ] **Step 2: Run the test and verify RED if any click remains untargeted**

Run the Task 1 test command.

- [ ] **Step 3: Measure the active target and animate the cursor tip to it**

On each scene change, resolve the target under `rootRef`, measure both rectangles in `requestAnimationFrame`, convert them with `cursorPositionForRects`, and update on resize. Keep the previous valid position until a newly mounted menu/settings target is measurable.

- [ ] **Step 4: Make click feedback unmistakable**

Scale the cursor to `0.78` during press, render a keyed 28px two-ring ripple centered on the cursor tip, and keep the pulse mounted for its complete 500ms animation even when the next scene begins.

- [ ] **Step 5: Verify the focused tests**

Run the Task 1 test command.

Expected: PASS.

### Task 4: Build and visual verification

**Files:**
- Modify only if verification exposes a concrete defect: `frontend/src/landing/src/app/components/FeaturesSection/components/ProjectAgentsDemo/ProjectAgentsDemo.tsx`

**Interfaces:**
- Consumes: completed Feature 4 demo.
- Produces: verified landing build and observed animation loop.

- [ ] **Step 1: Run the production build**

Run: `npm --prefix frontend/src/landing run build`

Expected: compiled successfully, TypeScript succeeds, and 90 static pages generate. If Google Fonts is blocked by the sandbox, rerun the same command with network approval.

- [ ] **Step 2: Run the landing page and open it through AO preview**

Start the landing dev server, then from the AO session run `ao preview http://127.0.0.1:<reported-port>/#features` so the result appears in the inspector rail's Browser tab.

- [ ] **Step 3: Exercise one complete loop**

Verify sidebar/theme parity with Hero, kebab → Project settings routing story, both agent selections, Save/Saving/Saved states, cursor-tip alignment, visible ripples, reset, and reduced-motion static saved state.

- [ ] **Step 4: Review the final diff and commit**

```bash
git diff --check
git status --short
git add frontend/src/landing/src/app/components/FeaturesSection/components/ProjectAgentsDemo
git commit -m "fix(landing): align feature 4 animation flow"
```
