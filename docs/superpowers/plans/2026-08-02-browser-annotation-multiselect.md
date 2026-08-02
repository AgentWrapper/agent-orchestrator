# Browser Annotation Multi-Select Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a user in the in-app browser's annotation tool select multiple DOM
elements — via a Shift-key toggle, not a hold-and-click gesture — before opening
a single annotation prompt covering the whole selection.

**Architecture:** The existing single-element annotation tool
(`frontend/src/annotate-preload.ts`, injected into the previewed page) gains a
second interaction mode reachable by pressing Shift. Pressing Shift once enters
"multi-select" mode: subsequent plain clicks toggle elements in/out of an
accumulating selection (highlighted, prompt stays closed). Pressing Shift again
exits the mode and — if at least one element was picked — opens the same prompt
UI used today, now labeled with the selection count. The wire payload
(`frontend/src/shared/browser-annotations.ts`) gains a `kind: "element" |
"elements"` discriminated union so the main process
(`frontend/src/main/browser-view-host.ts`) and the message formatter can branch
on it. The plain single-click flow (click an element, prompt opens immediately)
is untouched behaviorally.

**Tech Stack:** TypeScript, Electron (`ipcRenderer`/`ipcMain`), Vitest + jsdom
for preload/unit tests, React Testing Library for the renderer panel test.

## Global Constraints

- Scope is click-based multi-select only. Do **not** implement the Shift+drag
  lasso gesture or bounding-box screenshot capture — those are explicitly out
  of scope for this pass (confirmed with the user).
- Plain click (no Shift involved) must remain byte-identical in behavior to
  today: select one element, open the prompt immediately. Every existing test
  that exercises this path must keep passing without changes to its
  assertions about *behavior* (only mechanical payload-shape updates are
  allowed, since the wire type changes).
- No backend/Go changes. The formatted message is a plain string handed to the
  existing `/api/v1/sessions/{sessionId}/send` endpoint — nothing about the
  wire contract there changes.
- No renderer (`BrowserPanel.tsx`) behavior changes. The toolbar's "Annotate
  page" toggle, its status label, and IPC wiring stay as they are; the new
  interaction lives entirely inside the injected preload overlay.
- Follow AGENTS.md: keep changes surgical, no drive-by cleanup, conventional
  commit messages (`feat:`, `test:`, etc.).
- Run tests with `npx vitest run --config vite.renderer.config.ts <path>` from
  `frontend/` (the repo's `npm test` wraps this same command).

---

### Task 1: Selection payload type + multi-element message formatting

**Files:**
- Modify: `frontend/src/shared/browser-annotations.ts`
- Create: `frontend/src/shared/browser-annotations.test.ts`

**Interfaces:**
- Produces: `BrowserAnnotationSelection` (discriminated union: `{ kind:
  "element"; context: BrowserAnnotationContext }` or `{ kind: "elements";
  contexts: BrowserAnnotationContext[] }`), used by every later task.
- Produces: `BrowserAnnotationPageSubmitPayload = { instruction: string;
  selection: BrowserAnnotationSelection }` (replaces the old `{ instruction;
  context }` shape).
- Produces: `formatBrowserAnnotationMessage(payload: BrowserAnnotationSubmitPayload): string`
  (existing export, new internal branching — signature unchanged).

- [ ] **Step 1: Write the failing tests**

Create `frontend/src/shared/browser-annotations.test.ts`:

```typescript
import { describe, expect, it } from "vitest";
import {
	formatBrowserAnnotationMessage,
	MAX_BROWSER_ANNOTATION_MESSAGE_LENGTH,
	type BrowserAnnotationContext,
	type BrowserAnnotationSubmitPayload,
} from "./browser-annotations";

function context(overrides: Partial<BrowserAnnotationContext> = {}): BrowserAnnotationContext {
	return {
		url: "http://localhost:5173/",
		tag: "button",
		classes: [],
		selector: "button#save",
		rect: { x: 10, y: 20, width: 80, height: 30 },
		nearbyText: [],
		computedStyle: {},
		...overrides,
	};
}

describe("formatBrowserAnnotationMessage", () => {
	it("formats a single-element selection exactly as before", () => {
		const payload: BrowserAnnotationSubmitPayload = {
			viewId: "1:sess-1",
			instruction: "Make this button blue.",
			selection: { kind: "element", context: context({ id: "save", selector: "button#save" }) },
		};

		const message = formatBrowserAnnotationMessage(payload);

		expect(message).toBe(
			[
				"The user selected an element in the AO browser preview and asked for a change.",
				"",
				"Change request:",
				"Make this button blue.",
				"",
				"Selected element context:",
				"- URL: http://localhost:5173/",
				"- Element: button#save",
				"- Selector: button#save",
				"- Bounds: x=10, y=20, width=80, height=30",
				"",
				"Execution constraints:",
				"- Make the smallest source change that satisfies the request.",
				"- Do not start, restart, or background a dev server.",
				"- Do not run watch-mode or long-running commands.",
				"- If verification is needed, use a finite command only; otherwise rely on the existing preview watcher or dev-server refresh.",
			].join("\n"),
		);
	});

	it("lists every element for a multi-element selection", () => {
		const payload: BrowserAnnotationSubmitPayload = {
			viewId: "1:sess-1",
			instruction: "Align these two buttons.",
			selection: {
				kind: "elements",
				contexts: [
					context({ id: "save", selector: "button#save" }),
					context({ id: "cancel", selector: "button#cancel" }),
				],
			},
		};

		const message = formatBrowserAnnotationMessage(payload);

		expect(message).toContain("The user selected 2 elements in the AO browser preview and asked for a change.");
		expect(message).toContain("Selected elements (2) at http://localhost:5173/:");
		expect(message).toContain("1. button#save (selector: button#save, bounds: x=10, y=20, width=80, height=30)");
		expect(message).toContain("2. button#cancel (selector: button#cancel, bounds: x=10, y=20, width=80, height=30)");
	});

	it("truncates an oversized multi-element message to the shared cap", () => {
		const contexts = Array.from({ length: 200 }, (_, index) =>
			context({ id: `el-${index}`, selector: `button#el-${index}` }),
		);
		const payload: BrowserAnnotationSubmitPayload = {
			viewId: "1:sess-1",
			instruction: "Update all of these.",
			selection: { kind: "elements", contexts },
		};

		const message = formatBrowserAnnotationMessage(payload);

		expect(message.length).toBeLessThanOrEqual(MAX_BROWSER_ANNOTATION_MESSAGE_LENGTH);
		expect(message.endsWith("[truncated]")).toBe(true);
	});
});
```

- [ ] **Step 2: Run the tests to verify they fail**

```bash
cd frontend
npx vitest run --config vite.renderer.config.ts src/shared/browser-annotations.test.ts
```

Expected: FAIL — `payload.selection` does not exist on the current
`BrowserAnnotationSubmitPayload` type (TypeScript error surfaced through
vitest's esbuild transform).

- [ ] **Step 3: Update the type + rewrite the formatter**

In `frontend/src/shared/browser-annotations.ts`, replace lines 47-54:

```typescript
export type BrowserAnnotationPageSubmitPayload = {
	instruction: string;
	context: BrowserAnnotationContext;
};

export type BrowserAnnotationSubmitPayload = BrowserAnnotationPageSubmitPayload & {
	viewId: string;
};
```

with:

```typescript
export type BrowserAnnotationSelection =
	| { kind: "element"; context: BrowserAnnotationContext }
	| { kind: "elements"; contexts: BrowserAnnotationContext[] };

export type BrowserAnnotationPageSubmitPayload = {
	instruction: string;
	selection: BrowserAnnotationSelection;
};

export type BrowserAnnotationSubmitPayload = BrowserAnnotationPageSubmitPayload & {
	viewId: string;
};
```

Then replace `formatBrowserAnnotationMessage` (current lines 108-141):

```typescript
export function formatBrowserAnnotationMessage(payload: BrowserAnnotationSubmitPayload): string {
	const context = payload.context;
	const lines = [
		"The user selected an element in the AO browser preview and asked for a change.",
		"",
		"Change request:",
		compactText(payload.instruction, MAX_INSTRUCTION_LENGTH) || "(empty)",
		"",
		"Selected element context:",
		`- URL: ${context.url || "(unknown)"}`,
		context.title ? `- Title: ${compactText(context.title, 160)}` : null,
		`- Element: ${elementSummary(context)}`,
		`- Selector: ${context.selector}`,
		`- Bounds: x=${context.rect.x}, y=${context.rect.y}, width=${context.rect.width}, height=${context.rect.height}`,
		context.visibleText ? `- Visible text: ${compactText(context.visibleText, MAX_TEXT_FIELD_LENGTH)}` : null,
		context.selectedText ? `- Selected text: ${compactText(context.selectedText, MAX_TEXT_FIELD_LENGTH)}` : null,
		context.ariaRole ? `- ARIA role: ${compactText(context.ariaRole, 120)}` : null,
		context.ariaLabel ? `- ARIA/name: ${compactText(context.ariaLabel, 180)}` : null,
		context.nearbyText.length > 0
			? `- Nearby text: ${compactText(context.nearbyText.join(" | "), MAX_NEARBY_TEXT_LENGTH)}`
			: null,
		Object.keys(context.computedStyle).length > 0
			? `- Computed style: ${compactText(JSON.stringify(context.computedStyle), 700)}`
			: null,
		"",
		"Execution constraints:",
		"- Make the smallest source change that satisfies the request.",
		"- Do not start, restart, or background a dev server.",
		"- Do not run watch-mode or long-running commands.",
		"- If verification is needed, use a finite command only; otherwise rely on the existing preview watcher or dev-server refresh.",
	].filter((line): line is string => line !== null);

	return limitMessage(lines.join("\n"), MAX_BROWSER_ANNOTATION_MESSAGE_LENGTH);
}

function elementSummary(context: BrowserAnnotationContext): string {
```

with:

```typescript
export function formatBrowserAnnotationMessage(payload: BrowserAnnotationSubmitPayload): string {
	const selection = payload.selection;
	const lines = [
		selection.kind === "element"
			? "The user selected an element in the AO browser preview and asked for a change."
			: `The user selected ${selection.contexts.length} elements in the AO browser preview and asked for a change.`,
		"",
		"Change request:",
		compactText(payload.instruction, MAX_INSTRUCTION_LENGTH) || "(empty)",
		"",
		...(selection.kind === "element"
			? elementSelectionLines(selection.context)
			: elementsSelectionLines(selection.contexts)),
		"",
		"Execution constraints:",
		"- Make the smallest source change that satisfies the request.",
		"- Do not start, restart, or background a dev server.",
		"- Do not run watch-mode or long-running commands.",
		"- If verification is needed, use a finite command only; otherwise rely on the existing preview watcher or dev-server refresh.",
	];

	return limitMessage(lines.join("\n"), MAX_BROWSER_ANNOTATION_MESSAGE_LENGTH);
}

function elementSelectionLines(context: BrowserAnnotationContext): string[] {
	return [
		"Selected element context:",
		`- URL: ${context.url || "(unknown)"}`,
		context.title ? `- Title: ${compactText(context.title, 160)}` : null,
		`- Element: ${elementSummary(context)}`,
		`- Selector: ${context.selector}`,
		`- Bounds: x=${context.rect.x}, y=${context.rect.y}, width=${context.rect.width}, height=${context.rect.height}`,
		context.visibleText ? `- Visible text: ${compactText(context.visibleText, MAX_TEXT_FIELD_LENGTH)}` : null,
		context.selectedText ? `- Selected text: ${compactText(context.selectedText, MAX_TEXT_FIELD_LENGTH)}` : null,
		context.ariaRole ? `- ARIA role: ${compactText(context.ariaRole, 120)}` : null,
		context.ariaLabel ? `- ARIA/name: ${compactText(context.ariaLabel, 180)}` : null,
		context.nearbyText.length > 0
			? `- Nearby text: ${compactText(context.nearbyText.join(" | "), MAX_NEARBY_TEXT_LENGTH)}`
			: null,
		Object.keys(context.computedStyle).length > 0
			? `- Computed style: ${compactText(JSON.stringify(context.computedStyle), 700)}`
			: null,
	].filter((line): line is string => line !== null);
}

function elementsSelectionLines(contexts: BrowserAnnotationContext[]): string[] {
	const url = contexts.find((context) => context.url)?.url || "(unknown)";
	const items = contexts.map((context, index) => {
		const bounds = `x=${context.rect.x}, y=${context.rect.y}, width=${context.rect.width}, height=${context.rect.height}`;
		const text = context.visibleText ? ` — ${compactText(context.visibleText, 160)}` : "";
		return `${index + 1}. ${elementSummary(context)} (selector: ${context.selector}, bounds: ${bounds})${text}`;
	});
	return [`Selected elements (${contexts.length}) at ${url}:`, ...items];
}

function elementSummary(context: BrowserAnnotationContext): string {
```

(The trailing `function elementSummary(context: BrowserAnnotationContext): string {` line is
included in both the old and new block only to anchor the edit — its body is
unchanged.)

- [ ] **Step 4: Run the tests to verify they pass**

```bash
cd frontend
npx vitest run --config vite.renderer.config.ts src/shared/browser-annotations.test.ts
```

Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add frontend/src/shared/browser-annotations.ts frontend/src/shared/browser-annotations.test.ts
git commit -m "feat(browser-annotations): add multi-element selection payload and formatting"
```

---

### Task 2: Main-process IPC forwarder validates the new selection shape

**Files:**
- Modify: `frontend/src/main/browser-view-host.ts`
- Modify: `frontend/src/main/browser-view-host.test.ts`

**Interfaces:**
- Consumes: `BrowserAnnotationSelection`, `BrowserAnnotationPageSubmitPayload`,
  `BrowserAnnotationSubmitPayload` from Task 1.
- Produces: nothing new consumed elsewhere — this task only makes the existing
  `browser:annotation:submit` → `browser:annotation:submitted` forwarding path
  correct for the new payload shape.

- [ ] **Step 1: Update the failing/changed test first**

In `frontend/src/main/browser-view-host.test.ts`, replace the existing test at
lines 1270-1294:

```typescript
	it("forwards preview annotation submissions to the renderer-owned view", async () => {
		const { invoke, send, sent } = setupHost();
		await invoke("browser:ensure", "sess-1");

		send("browser:annotation:submit", 99, {
			instruction: "Make this button blue.",
			context: {
				url: "http://localhost:5173/",
				tag: "button",
				classes: [],
				selector: "button",
				rect: { x: 0, y: 0, width: 80, height: 30 },
				computedStyle: {},
			},
		});

		expect(sent).toContainEqual({
			channel: "browser:annotation:submitted",
			payload: expect.objectContaining({
				viewId: "1:sess-1",
				instruction: "Make this button blue.",
				context: expect.objectContaining({ selector: "button" }),
			}),
		});
	});
```

with:

```typescript
	it("forwards a single-element preview annotation submission to the renderer-owned view", async () => {
		const { invoke, send, sent } = setupHost();
		await invoke("browser:ensure", "sess-1");

		send("browser:annotation:submit", 99, {
			instruction: "Make this button blue.",
			selection: {
				kind: "element",
				context: {
					url: "http://localhost:5173/",
					tag: "button",
					classes: [],
					selector: "button",
					rect: { x: 0, y: 0, width: 80, height: 30 },
					computedStyle: {},
				},
			},
		});

		expect(sent).toContainEqual({
			channel: "browser:annotation:submitted",
			payload: expect.objectContaining({
				viewId: "1:sess-1",
				instruction: "Make this button blue.",
				selection: expect.objectContaining({
					kind: "element",
					context: expect.objectContaining({ selector: "button" }),
				}),
			}),
		});
	});

	it("forwards a multi-element preview annotation submission to the renderer-owned view", async () => {
		const { invoke, send, sent } = setupHost();
		await invoke("browser:ensure", "sess-1");

		send("browser:annotation:submit", 99, {
			instruction: "Align these two.",
			selection: {
				kind: "elements",
				contexts: [
					{
						url: "http://localhost:5173/",
						tag: "button",
						classes: [],
						selector: "button#a",
						rect: { x: 0, y: 0, width: 80, height: 30 },
						computedStyle: {},
					},
					{
						url: "http://localhost:5173/",
						tag: "button",
						classes: [],
						selector: "button#b",
						rect: { x: 100, y: 0, width: 80, height: 30 },
						computedStyle: {},
					},
				],
			},
		});

		expect(sent).toContainEqual({
			channel: "browser:annotation:submitted",
			payload: expect.objectContaining({
				viewId: "1:sess-1",
				instruction: "Align these two.",
				selection: expect.objectContaining({
					kind: "elements",
					contexts: [
						expect.objectContaining({ selector: "button#a" }),
						expect.objectContaining({ selector: "button#b" }),
					],
				}),
			}),
		});
	});

	it("ignores a malformed annotation selection instead of forwarding it", async () => {
		const { invoke, send, sent } = setupHost();
		await invoke("browser:ensure", "sess-1");

		send("browser:annotation:submit", 99, {
			instruction: "Make this button blue.",
			selection: { kind: "elements", contexts: [] },
		});

		expect(sent.some((entry) => entry.channel === "browser:annotation:submitted")).toBe(false);
	});
```

- [ ] **Step 2: Run the tests to verify they fail**

```bash
cd frontend
npx vitest run --config vite.renderer.config.ts src/main/browser-view-host.test.ts -t "annotation"
```

Expected: FAIL — the current forwarder still validates `payload.context`, so
the new `selection`-shaped payloads are silently dropped (no
`browser:annotation:submitted` is ever sent) and the malformed-selection test
has nothing to assert against yet (it will pass vacuously, which is fine, but
the two forwarding tests fail).

- [ ] **Step 3: Implement the validator and update the forwarder**

In `frontend/src/main/browser-view-host.ts`, update the type-only import at
lines 12-18 to add `BrowserAnnotationSelection`:

```typescript
import type {
	BrowserAnnotationCancelPayload,
	BrowserAnnotationModeInput,
	BrowserAnnotationPageCancelPayload,
	BrowserAnnotationPageSubmitPayload,
	BrowserAnnotationSelection,
	BrowserAnnotationSubmitPayload,
} from "../shared/browser-annotations";
```

Then replace `forwardAnnotationSubmit` (current lines 689-712):

```typescript
	const forwardAnnotationSubmit = (
		event: IpcMainEvent,
		payload: BrowserAnnotationPageSubmitPayload | undefined,
	): void => {
		const entry = tabsByWebContentsId.get(event.sender.id);
		const viewId = entry?.state.viewId;
		if (
			!viewId ||
			!entry ||
			!payload ||
			typeof payload.instruction !== "string" ||
			typeof payload.context !== "object" ||
			payload.context === null
		) {
			return;
		}
		entry.annotationEnabled = false;
		const forwarded: BrowserAnnotationSubmitPayload = {
			viewId,
			instruction: payload.instruction,
			context: payload.context,
		};
		options.mainWindow.webContents.send("browser:annotation:submitted", forwarded);
	};
```

with:

```typescript
	const forwardAnnotationSubmit = (
		event: IpcMainEvent,
		payload: BrowserAnnotationPageSubmitPayload | undefined,
	): void => {
		const entry = tabsByWebContentsId.get(event.sender.id);
		const viewId = entry?.state.viewId;
		if (
			!viewId ||
			!entry ||
			!payload ||
			typeof payload.instruction !== "string" ||
			!isValidAnnotationSelection(payload.selection)
		) {
			return;
		}
		entry.annotationEnabled = false;
		const forwarded: BrowserAnnotationSubmitPayload = {
			viewId,
			instruction: payload.instruction,
			selection: payload.selection,
		};
		options.mainWindow.webContents.send("browser:annotation:submitted", forwarded);
	};
```

Finally, add the validator as a module-level function. Insert it directly
above `export type BrowserRect` (current line 22), i.e. right after the import
block:

```typescript
function isValidAnnotationSelection(value: unknown): value is BrowserAnnotationSelection {
	if (typeof value !== "object" || value === null) return false;
	const selection = value as { kind?: unknown; context?: unknown; contexts?: unknown };
	if (selection.kind === "element") {
		return typeof selection.context === "object" && selection.context !== null;
	}
	if (selection.kind === "elements") {
		return Array.isArray(selection.contexts) && selection.contexts.length > 0;
	}
	return false;
}

export type BrowserRect = Pick<Rectangle, "x" | "y" | "width" | "height">;
```

- [ ] **Step 4: Run the tests to verify they pass**

```bash
cd frontend
npx vitest run --config vite.renderer.config.ts src/main/browser-view-host.test.ts
```

Expected: PASS (full file — confirms this change did not regress any other
`browser-view-host.test.ts` suite).

- [ ] **Step 5: Commit**

```bash
git add frontend/src/main/browser-view-host.ts frontend/src/main/browser-view-host.test.ts
git commit -m "feat(browser-view-host): forward and validate multi-element annotation selections"
```

---

### Task 3: Update renderer test fixtures for the new payload shape

**Files:**
- Modify: `frontend/src/renderer/components/BrowserPanel.test.tsx`

**Interfaces:**
- Consumes: `BrowserAnnotationSelection`, `BrowserAnnotationContext` from Task 1.
- No production code changes in this task — `BrowserPanel.tsx` never
  destructures `.context`/`.selection` itself (it passes the payload through
  opaquely to `formatBrowserAnnotationMessage`), so only the test fixtures
  that build literal payloads need updating to keep compiling and passing.

- [ ] **Step 1: Update the import and the shared `annotationPayload` helper**

In `frontend/src/renderer/components/BrowserPanel.test.tsx`, update the import
at line 7:

```typescript
import type { BrowserAnnotationCancelPayload, BrowserAnnotationSubmitPayload } from "../../shared/browser-annotations";
```

to:

```typescript
import type {
	BrowserAnnotationCancelPayload,
	BrowserAnnotationContext,
	BrowserAnnotationSubmitPayload,
} from "../../shared/browser-annotations";
```

Then replace the `annotationPayload` helper (current lines 86-100):

```typescript
function annotationPayload(instruction: string): BrowserAnnotationSubmitPayload {
	return {
		viewId: "42:sess-1",
		instruction,
		context: {
			url: "http://localhost:5173/",
			tag: "button",
			classes: [],
			selector: "button",
			rect: { x: 0, y: 0, width: 80, height: 30 },
			nearbyText: [],
			computedStyle: {},
		},
	};
}
```

with:

```typescript
type ElementAnnotationPayload = BrowserAnnotationSubmitPayload & {
	selection: { kind: "element"; context: BrowserAnnotationContext };
};

function annotationPayload(instruction: string): ElementAnnotationPayload {
	return {
		viewId: "42:sess-1",
		instruction,
		selection: {
			kind: "element",
			context: {
				url: "http://localhost:5173/",
				tag: "button",
				classes: [],
				selector: "button",
				rect: { x: 0, y: 0, width: 80, height: 30 },
				nearbyText: [],
				computedStyle: {},
			},
		},
	};
}
```

- [ ] **Step 2: Update the four inline payload literals**

Replace (current lines 397-412):

```typescript
					listener({
						viewId: "42:sess-1",
						instruction: "Make this button blue.",
						context: {
							url: "http://localhost:5173/",
							title: "Preview",
							tag: "button",
							id: "save",
							classes: ["primary"],
							selector: "button#save",
							rect: { x: 16, y: 24, width: 140, height: 36 },
							visibleText: "Save changes",
							nearbyText: ["Profile settings"],
							computedStyle: {},
						},
					}),
```

with:

```typescript
					listener({
						viewId: "42:sess-1",
						instruction: "Make this button blue.",
						selection: {
							kind: "element",
							context: {
								url: "http://localhost:5173/",
								title: "Preview",
								tag: "button",
								id: "save",
								classes: ["primary"],
								selector: "button#save",
								rect: { x: 16, y: 24, width: 140, height: 36 },
								visibleText: "Save changes",
								nearbyText: ["Profile settings"],
								computedStyle: {},
							},
						},
					}),
```

Replace (current lines 546-558):

```typescript
		const payload = {
			viewId: "42:sess-1",
			instruction: "Make this button yellow.",
			context: {
				url: "http://localhost:5173/",
				tag: "button",
				classes: [],
				selector: "button",
				rect: { x: 0, y: 0, width: 80, height: 30 },
				nearbyText: [],
				computedStyle: {},
			},
		};
```

with:

```typescript
		const payload: BrowserAnnotationSubmitPayload = {
			viewId: "42:sess-1",
			instruction: "Make this button yellow.",
			selection: {
				kind: "element",
				context: {
					url: "http://localhost:5173/",
					tag: "button",
					classes: [],
					selector: "button",
					rect: { x: 0, y: 0, width: 80, height: 30 },
					nearbyText: [],
					computedStyle: {},
				},
			},
		};
```

Replace (current lines 602-614):

```typescript
					listener({
						viewId: "42:sess-1",
						instruction: "Move this card higher.",
						context: {
							url: "http://localhost:5173/",
							tag: "section",
							classes: [],
							selector: "section",
							rect: { x: 0, y: 0, width: 320, height: 180 },
							nearbyText: [],
							computedStyle: {},
						},
					}),
```

with:

```typescript
					listener({
						viewId: "42:sess-1",
						instruction: "Move this card higher.",
						selection: {
							kind: "element",
							context: {
								url: "http://localhost:5173/",
								tag: "section",
								classes: [],
								selector: "section",
								rect: { x: 0, y: 0, width: 320, height: 180 },
								nearbyText: [],
								computedStyle: {},
							},
						},
					}),
```

Replace (current lines 662-674):

```typescript
					listener({
						viewId: "42:sess-1",
						instruction: "Make this button blue.",
						context: {
							url: "http://localhost:5173/",
							tag: "button",
							classes: [],
							selector: "button",
							rect: { x: 0, y: 0, width: 80, height: 30 },
							nearbyText: [],
							computedStyle: {},
						},
					}),
```

with:

```typescript
					listener({
						viewId: "42:sess-1",
						instruction: "Make this button blue.",
						selection: {
							kind: "element",
							context: {
								url: "http://localhost:5173/",
								tag: "button",
								classes: [],
								selector: "button",
								rect: { x: 0, y: 0, width: 80, height: 30 },
								nearbyText: [],
								computedStyle: {},
							},
						},
					}),
```

- [ ] **Step 3: Update the spread-and-override literal**

Replace (current lines 690-698):

```typescript
					listener({
						...payload,
						context: {
							...payload.context,
							selector: "button#save",
						},
					}),
```

with:

```typescript
					listener({
						...payload,
						selection: {
							kind: "element",
							context: { ...payload.selection.context, selector: "button#save" },
						},
					}),
```

- [ ] **Step 4: Run the full suite to verify it passes**

```bash
cd frontend
npx vitest run --config vite.renderer.config.ts src/renderer/components/BrowserPanel.test.tsx
```

Expected: PASS (all tests in the file — this task only touches fixtures, so
every existing assertion should hold unchanged).

- [ ] **Step 5: Commit**

```bash
git add frontend/src/renderer/components/BrowserPanel.test.tsx
git commit -m "test(browser-panel): update annotation fixtures for the selection payload shape"
```

---

### Task 4: Preload script — Shift-toggle multi-select interaction

**Files:**
- Modify: `frontend/src/annotate-preload.ts`
- Modify: `frontend/src/annotate-preload.test.ts`

**Interfaces:**
- Consumes: `BrowserAnnotationSelection`, `BrowserAnnotationPageSubmitPayload`
  from Task 1; `AnnotationRectLike`, `promptPositionForRect` from
  `frontend/src/shared/browser-annotation-overlay.ts` (unchanged).
- Produces: no new exports — this is the leaf of the flow. The only observable
  effect outside the file is what gets sent over
  `ipcRenderer.send("browser:annotation:submit", payload)`, which now carries
  a `selection` field matching Task 1's type.

- [ ] **Step 1: Update the existing single-element test's assertions**

In `frontend/src/annotate-preload.test.ts`, replace the test at lines 131-142:

```typescript
	it("submits the captured selected element after an ignored page click", () => {
		const first = elementWithBounds("first", { left: 12, top: 24, width: 120, height: 40 });
		const second = elementWithBounds("second", { left: 240, top: 160, width: 80, height: 30 });

		dispatchPageEvent(first, "click");
		dispatchPageEvent(second, "click");

		const payload = submitPrompt("Make this button blue.");

		expect(payload.instruction).toBe("Make this button blue.");
		expect(payload.context.selector).toBe("button#first");
	});
```

with:

```typescript
	it("submits the captured selected element after an ignored page click", () => {
		const first = elementWithBounds("first", { left: 12, top: 24, width: 120, height: 40 });
		const second = elementWithBounds("second", { left: 240, top: 160, width: 80, height: 30 });

		dispatchPageEvent(first, "click");
		dispatchPageEvent(second, "click");

		const payload = submitPrompt("Make this button blue.");

		expect(payload.instruction).toBe("Make this button blue.");
		expect(payload.selection.kind).toBe("element");
		if (payload.selection.kind !== "element") throw new Error("expected an element selection");
		expect(payload.selection.context.selector).toBe("button#first");
	});
```

- [ ] **Step 2: Add the new multi-select tests**

Add a `shiftKeyDown` helper and `selectionBoxes`/`promptForm` helpers right
after the existing `highlightStyle` helper (current lines 71-75 in
`frontend/src/annotate-preload.test.ts`):

```typescript
function shiftKeyDown(repeat = false): void {
	document.dispatchEvent(new KeyboardEvent("keydown", { key: "Shift", bubbles: true, cancelable: true, repeat }));
}

function selectionBoxes(): HTMLDivElement[] {
	return Array.from(overlayRoot().querySelectorAll<HTMLDivElement>(".selections .highlight--selected"));
}

function promptForm(): HTMLFormElement | null {
	return overlayRoot().querySelector<HTMLFormElement>("form");
}
```

Then add these tests inside the existing `describe("annotate preload", ...)`
block, after the last test ("keeps prompt controls active for cancel and
escape"):

```typescript
	it("accumulates a multi-selection on Shift and toggles a re-clicked element back out", () => {
		const first = elementWithBounds("first", { left: 12, top: 24, width: 120, height: 40 });
		const second = elementWithBounds("second", { left: 240, top: 160, width: 80, height: 30 });

		shiftKeyDown();
		dispatchPageEvent(first, "click");
		dispatchPageEvent(second, "click");
		expect(selectionBoxes()).toHaveLength(2);

		dispatchPageEvent(first, "click");
		expect(selectionBoxes()).toHaveLength(1);
		expect(selectionBoxes()[0].style.left).toBe("240px");
		expect(promptForm()).toBeNull();
	});

	it("opens the prompt with every selected element when Shift is pressed again", () => {
		const first = elementWithBounds("first", { left: 12, top: 24, width: 120, height: 40 });
		const second = elementWithBounds("second", { left: 240, top: 160, width: 80, height: 30 });

		shiftKeyDown();
		dispatchPageEvent(first, "click");
		dispatchPageEvent(second, "click");
		shiftKeyDown();

		const payload = submitPrompt("Align these two.");

		expect(payload.selection.kind).toBe("elements");
		if (payload.selection.kind !== "elements") throw new Error("expected an elements selection");
		expect(payload.selection.contexts.map((context) => context.selector)).toEqual(["button#first", "button#second"]);
	});

	it("does not open the prompt when Shift is pressed again with nothing selected", () => {
		shiftKeyDown();
		shiftKeyDown();

		expect(promptForm()).toBeNull();
		expect(electronMocks.send).not.toHaveBeenCalledWith("browser:annotation:submit", expect.anything());
	});

	it("ignores a held-down Shift key repeat so multi-select mode does not toggle off early", () => {
		const first = elementWithBounds("first", { left: 12, top: 24, width: 120, height: 40 });

		shiftKeyDown();
		shiftKeyDown(true);
		dispatchPageEvent(first, "click");

		expect(selectionBoxes()).toHaveLength(1);
		expect(promptForm()).toBeNull();
	});

	it("cancels an in-progress multi-selection on Escape", () => {
		const first = elementWithBounds("first", { left: 12, top: 24, width: 120, height: 40 });

		shiftKeyDown();
		dispatchPageEvent(first, "click");
		document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));

		expect(electronMocks.send).toHaveBeenCalledWith("browser:annotation:cancel", { reason: "escape" });
		expect(document.querySelector("[data-ao-annotation-root]")).toBeNull();
	});
```

- [ ] **Step 3: Run the tests to verify they fail**

```bash
cd frontend
npx vitest run --config vite.renderer.config.ts src/annotate-preload.test.ts
```

Expected: FAIL — the preload script has no Shift handling yet and still sends
`{ instruction, context }`, so both the updated existing test and every new
test fail (some with a TypeScript error on `payload.selection`, others because
`.selections` is never populated).

- [ ] **Step 4: Implement the state machine in `annotate-preload.ts`**

Replace the whole file content (current 365 lines) with:

```typescript
import { ipcRenderer } from "electron";
import {
	createBrowserAnnotationContext,
	type BrowserAnnotationCancelReason,
	type BrowserAnnotationContext,
	type BrowserAnnotationPageSubmitPayload,
} from "./shared/browser-annotations";
import { promptPositionForRect, type AnnotationRectLike } from "./shared/browser-annotation-overlay";

let enabled = false;
let selectedElement: Element | null = null;
let selectedContext: BrowserAnnotationContext | null = null;
let multiSelectActive = false;
let multiSelectElements: Element[] = [];
let multiSelectContexts: BrowserAnnotationContext[] | null = null;
let host: HTMLDivElement | null = null;
let shadow: ShadowRoot | null = null;

ipcRenderer.on("browser:annotation:setMode", (_event, input: { enabled?: boolean }) => {
	setEnabled(Boolean(input?.enabled), "disabled");
});

window.addEventListener("beforeunload", () => {
	if (enabled) sendCancel("navigation");
	cleanupOverlay();
	enabled = false;
});

function setEnabled(next: boolean, cancelReason: BrowserAnnotationCancelReason): void {
	if (enabled === next) return;
	enabled = next;
	selectedElement = null;
	selectedContext = null;
	multiSelectActive = false;
	multiSelectElements = [];
	multiSelectContexts = null;
	if (enabled) {
		ensureOverlay();
		installListeners();
		renderHint();
	} else {
		removeListeners();
		cleanupOverlay();
		if (cancelReason !== "disabled") sendCancel(cancelReason);
	}
}

function installListeners(): void {
	document.addEventListener("pointerover", handlePointerMove, true);
	document.addEventListener("pointermove", handlePointerMove, true);
	document.addEventListener("click", handleClick, true);
	document.addEventListener("keydown", handleKeyDown, true);
	window.addEventListener("scroll", refreshHighlight, true);
	window.addEventListener("resize", refreshHighlight, true);
}

function removeListeners(): void {
	document.removeEventListener("pointerover", handlePointerMove, true);
	document.removeEventListener("pointermove", handlePointerMove, true);
	document.removeEventListener("click", handleClick, true);
	document.removeEventListener("keydown", handleKeyDown, true);
	window.removeEventListener("scroll", refreshHighlight, true);
	window.removeEventListener("resize", refreshHighlight, true);
}

function handlePointerMove(event: PointerEvent): void {
	if (!enabled || selectedContext || multiSelectContexts || isOverlayEvent(event)) return;
	const target = annotationTarget(event.target);
	if (!target || target === selectedElement) return;
	selectedElement = target;
	selectedContext = null;
	renderHighlight(target, false);
}

function handleClick(event: MouseEvent): void {
	if (!enabled || isOverlayEvent(event)) return;
	if (selectedContext || multiSelectContexts) {
		event.preventDefault();
		event.stopPropagation();
		event.stopImmediatePropagation();
		return;
	}
	const target = annotationTarget(event.target);
	if (!target) return;
	event.preventDefault();
	event.stopPropagation();
	event.stopImmediatePropagation();
	if (multiSelectActive) {
		toggleMultiSelectElement(target);
		return;
	}
	selectedElement = target;
	selectedContext = createBrowserAnnotationContext(target);
	renderPrompt(target, selectedContext);
}

function handleKeyDown(event: KeyboardEvent): void {
	if (!enabled) return;
	if (event.key === "Escape") {
		event.preventDefault();
		event.stopPropagation();
		event.stopImmediatePropagation();
		setEnabled(false, "escape");
		return;
	}
	if (event.key !== "Shift" || event.repeat || selectedContext || multiSelectContexts) return;
	event.preventDefault();
	event.stopPropagation();
	event.stopImmediatePropagation();
	if (multiSelectActive) {
		finishMultiSelect();
	} else {
		startMultiSelect();
	}
}

function startMultiSelect(): void {
	multiSelectActive = true;
	multiSelectElements = [];
	hideHoverHighlight();
	renderMultiSelections();
	renderHint();
}

function finishMultiSelect(): void {
	multiSelectActive = false;
	hideHoverHighlight();
	if (multiSelectElements.length === 0) {
		renderHint();
		return;
	}
	multiSelectContexts = multiSelectElements.map(createBrowserAnnotationContext);
	renderMultiPrompt(multiSelectElements, multiSelectContexts);
}

function toggleMultiSelectElement(target: Element): void {
	const index = multiSelectElements.indexOf(target);
	if (index === -1) {
		multiSelectElements.push(target);
	} else {
		multiSelectElements.splice(index, 1);
	}
	renderMultiSelections();
	renderHint();
}

function hideHoverHighlight(): void {
	selectedElement = null;
	const highlight = ensureOverlay().querySelector<HTMLDivElement>(".highlight");
	if (highlight) highlight.hidden = true;
}

function refreshHighlight(): void {
	if (!enabled) return;
	if (selectedElement) renderHighlight(selectedElement, Boolean(selectedContext));
	if (multiSelectElements.length > 0) renderMultiSelections();
}

function annotationTarget(target: EventTarget | null): Element | null {
	if (!(target instanceof Element)) return null;
	const element =
		target.closest("button, a, input, textarea, select, [role]") ??
		target.closest("[data-testid], [id], [class]") ??
		target;
	if (element === document.documentElement || element === document.body) return null;
	return element;
}

function ensureOverlay(): ShadowRoot {
	if (shadow && host?.isConnected) return shadow;
	host = document.createElement("div");
	host.setAttribute("data-ao-annotation-root", "");
	host.style.position = "fixed";
	host.style.inset = "0";
	host.style.zIndex = "2147483647";
	host.style.pointerEvents = "none";
	(document.documentElement ?? document.body).appendChild(host);
	shadow = host.attachShadow({ mode: "open" });
	shadow.innerHTML = `
		<style>
			:host { all: initial; }
			.highlight {
				position: fixed;
				box-sizing: border-box;
				border: 2px solid #4d8dff;
				border-radius: 8px;
				background: rgba(77, 141, 255, 0.11);
				box-shadow:
					0 0 0 9999px rgba(0, 0, 0, 0.10),
					0 0 0 1px rgba(255, 255, 255, 0.20),
					0 12px 36px rgba(0, 0, 0, 0.24);
				pointer-events: none;
				transition:
					left 120ms ease,
					top 120ms ease,
					width 120ms ease,
					height 120ms ease,
					border-color 120ms ease,
					background 120ms ease;
			}
			.highlight--selected {
				border-color: #74b98a;
				background: rgba(116, 185, 138, 0.14);
				box-shadow:
					0 0 0 1px rgba(255, 255, 255, 0.20),
					0 12px 36px rgba(0, 0, 0, 0.24);
			}
			.prompt {
				position: fixed;
				width: min(380px, calc(100vw - 24px));
				box-sizing: border-box;
				border: 1px solid rgba(255, 255, 255, 0.14);
				border-radius: 8px;
				background: rgba(18, 20, 24, 0.98);
				color: #f4f5f7;
				box-shadow:
					0 0 0 1px rgba(255, 255, 255, 0.06),
					0 18px 52px rgba(0, 0, 0, 0.48);
				padding: 12px;
				font: 13px/1.4 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
				pointer-events: auto;
				animation: prompt-in 140ms ease-out;
			}
			.prompt__header {
				display: flex;
				align-items: center;
				justify-content: space-between;
				gap: 10px;
				margin-bottom: 9px;
				color: rgba(244, 245, 247, 0.82);
				font-size: 12px;
				font-weight: 650;
			}
			.prompt__target {
				min-width: 0;
				max-width: 170px;
				overflow: hidden;
				border-radius: 999px;
				background: rgba(77, 141, 255, 0.14);
				color: #9fc0ff;
				padding: 3px 7px;
				font: 11px/1.2 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
				text-overflow: ellipsis;
				white-space: nowrap;
			}
			.prompt textarea {
				width: 100%;
				min-height: 102px;
				box-sizing: border-box;
				resize: vertical;
				border: 1px solid rgba(255, 255, 255, 0.12);
				border-radius: 6px;
				background: rgba(7, 8, 10, 0.92);
				color: #f4f5f7;
				padding: 9px 10px;
				font: inherit;
				outline: none;
				transition:
					border-color 120ms ease,
					box-shadow 120ms ease,
					background 120ms ease;
			}
			.prompt textarea:focus {
				border-color: #4d8dff;
				box-shadow: 0 0 0 3px rgba(77, 141, 255, 0.16);
			}
			.actions {
				display: flex;
				justify-content: flex-end;
				gap: 8px;
				margin-top: 8px;
			}
			.actions button {
				height: 30px;
				border-radius: 6px;
				border: 1px solid rgba(255, 255, 255, 0.12);
				background: #1b1d22;
				color: #f4f5f7;
				padding: 0 10px;
				font: inherit;
				transition:
					background 120ms ease,
					border-color 120ms ease,
					transform 120ms ease;
			}
			.actions button:hover {
				background: #242830;
			}
			.actions button:active {
				transform: translateY(1px);
			}
			.actions button[type="submit"] {
				border-color: #4d8dff;
				background: #4d8dff;
				color: #fff;
			}
			.hint {
				position: fixed;
				left: 12px;
				bottom: 12px;
				border-radius: 6px;
				background: #15171b;
				color: #f4f5f7;
				padding: 7px 9px;
				font: 12px/1.3 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
				box-shadow: 0 10px 30px rgba(0, 0, 0, 0.35);
				pointer-events: none;
				animation: prompt-in 140ms ease-out;
			}
			@keyframes prompt-in {
				from { opacity: 0; transform: translateY(4px) scale(0.985); }
				to { opacity: 1; transform: translateY(0) scale(1); }
			}
			@media (prefers-reduced-motion: reduce) {
				.highlight,
				.prompt textarea,
				.actions button {
					transition: none;
				}
				.prompt,
				.hint {
					animation: none;
				}
			}
		</style>
		<div class="highlight" hidden></div>
		<div class="selections"></div>
		<div class="mount"></div>
	`;
	return shadow;
}

function renderHint(): void {
	const root = ensureOverlay();
	const mount = root.querySelector<HTMLDivElement>(".mount");
	if (!mount) return;
	mount.innerHTML = `<div class="hint">${hintText()}</div>`;
}

function hintText(): string {
	if (!multiSelectActive) {
		return "Click an element to annotate, or press Shift to select multiple. Press Esc to cancel.";
	}
	if (multiSelectElements.length === 0) {
		return "Click elements to select them. Press Shift again to finish.";
	}
	const count = multiSelectElements.length;
	return `${count} element${count === 1 ? "" : "s"} selected. Click more, or press Shift to finish.`;
}

function renderHighlight(element: Element, locked: boolean): void {
	const root = ensureOverlay();
	const highlight = root.querySelector<HTMLDivElement>(".highlight");
	if (!highlight) return;
	const rect = element.getBoundingClientRect();
	highlight.hidden = false;
	highlight.style.left = `${Math.max(0, rect.left)}px`;
	highlight.style.top = `${Math.max(0, rect.top)}px`;
	highlight.style.width = `${Math.max(0, rect.width)}px`;
	highlight.style.height = `${Math.max(0, rect.height)}px`;
	highlight.style.borderColor = locked ? "#74b98a" : "#4d8dff";
}

function renderMultiSelections(): void {
	const root = ensureOverlay();
	const container = root.querySelector<HTMLDivElement>(".selections");
	if (!container) return;
	container.innerHTML = "";
	for (const element of multiSelectElements) {
		const rect = element.getBoundingClientRect();
		const box = document.createElement("div");
		box.className = "highlight highlight--selected";
		box.style.left = `${Math.max(0, rect.left)}px`;
		box.style.top = `${Math.max(0, rect.top)}px`;
		box.style.width = `${Math.max(0, rect.width)}px`;
		box.style.height = `${Math.max(0, rect.height)}px`;
		container.appendChild(box);
	}
}

function renderPrompt(element: Element, context: BrowserAnnotationContext): void {
	renderHighlight(element, true);
	openPrompt(element.getBoundingClientRect(), promptTargetLabel(context), (instruction) => ({
		instruction,
		selection: { kind: "element", context },
	}));
}

function renderMultiPrompt(elements: Element[], contexts: BrowserAnnotationContext[]): void {
	renderMultiSelections();
	openPrompt(unionRect(elements), multiPromptTargetLabel(contexts.length), (instruction) => ({
		instruction,
		selection: { kind: "elements", contexts },
	}));
}

function openPrompt(
	rect: AnnotationRectLike,
	targetLabel: string,
	buildPayload: (instruction: string) => BrowserAnnotationPageSubmitPayload,
): void {
	const root = ensureOverlay();
	const mount = root.querySelector<HTMLDivElement>(".mount");
	if (!mount) return;
	const { left, top } = promptPosition(rect);
	mount.innerHTML = `
		<form class="prompt" style="left: ${left}px; top: ${top}px;">
			<div class="prompt__header">
				<span>Annotate selection</span>
				<span class="prompt__target">${escapeHTML(targetLabel)}</span>
			</div>
			<textarea aria-label="Annotation request" placeholder="Describe what to change"></textarea>
			<div class="actions">
				<button type="button" data-action="cancel">Cancel</button>
				<button type="submit">Send</button>
			</div>
		</form>
	`;
	const form = mount.querySelector<HTMLFormElement>("form")!;
	const textarea = form.querySelector<HTMLTextAreaElement>("textarea")!;
	form.addEventListener("submit", (event) => {
		event.preventDefault();
		const instruction = textarea.value.trim();
		if (!instruction) {
			textarea.focus();
			return;
		}
		ipcRenderer.send("browser:annotation:submit", buildPayload(instruction));
		setEnabled(false, "disabled");
	});
	form.querySelector<HTMLButtonElement>('[data-action="cancel"]')?.addEventListener("click", () => {
		setEnabled(false, "cancel");
	});
	setTimeout(() => textarea.focus(), 0);
}

function promptPosition(rect: AnnotationRectLike): { left: number; top: number } {
	return promptPositionForRect(rect, {
		width: window.innerWidth,
		height: window.innerHeight,
		promptWidth: Math.min(380, window.innerWidth - 24),
		promptHeight: 180,
		gutter: 12,
		gap: 8,
	});
}

function unionRect(elements: Element[]): AnnotationRectLike {
	const rects = elements.map((element) => element.getBoundingClientRect());
	return {
		left: Math.min(...rects.map((rect) => rect.left)),
		top: Math.min(...rects.map((rect) => rect.top)),
		bottom: Math.max(...rects.map((rect) => rect.bottom)),
	};
}

function cleanupOverlay(): void {
	host?.remove();
	host = null;
	shadow = null;
}

function sendCancel(reason: BrowserAnnotationCancelReason): void {
	ipcRenderer.send("browser:annotation:cancel", { reason });
}

function isOverlayEvent(event: Event): boolean {
	return Boolean(host && event.composedPath().includes(host));
}

function promptTargetLabel(context: BrowserAnnotationContext): string {
	if (context.ariaLabel) return context.ariaLabel;
	if (context.visibleText) return context.visibleText;
	if (context.id) return `${context.tag}#${context.id}`;
	if (context.classes.length > 0) return `${context.tag}.${context.classes[0]}`;
	return context.tag;
}

function multiPromptTargetLabel(count: number): string {
	return `${count} element${count === 1 ? "" : "s"} selected`;
}

function escapeHTML(value: string): string {
	return value
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;")
		.replace(/'/g, "&#39;");
}
```

- [ ] **Step 5: Run the tests to verify they pass**

```bash
cd frontend
npx vitest run --config vite.renderer.config.ts src/annotate-preload.test.ts
```

Expected: PASS (9 tests — the original 4 plus the 5 new multi-select tests).

- [ ] **Step 6: Commit**

```bash
git add frontend/src/annotate-preload.ts frontend/src/annotate-preload.test.ts
git commit -m "feat(annotate-preload): add Shift-toggle multi-element selection"
```

---

### Task 5: Full regression pass, typecheck, and manual verification

**Files:** none (verification only).

- [ ] **Step 1: Run every touched test file together**

```bash
cd frontend
npx vitest run --config vite.renderer.config.ts src/shared/browser-annotations.test.ts src/main/browser-view-host.test.ts src/renderer/components/BrowserPanel.test.tsx src/annotate-preload.test.ts
```

Expected: PASS, 0 failures.

- [ ] **Step 2: Run the full frontend test suite**

```bash
cd frontend
npm test
```

Expected: PASS, 0 failures (confirms nothing outside the annotation surface
regressed).

- [ ] **Step 3: Typecheck**

```bash
cd frontend
npm run typecheck
```

Expected: no errors.

- [ ] **Step 4: Manual verification in a running dev build**

Per `AGENTS.md`/`CLAUDE.md`: run `ao preview [url]` from inside a session so
the change renders in the desktop browser panel's Browser tab, then by hand:

1. Click the cursor/"Annotate page" icon in the browser toolbar.
2. Plain-click one element — confirm the prompt still opens immediately
   (unchanged behavior).
3. Cancel, re-open annotate mode. Press Shift — confirm the in-page hint
   changes to the multi-select prompt text and no dialog opens.
4. Click two or three different elements — confirm each gets a green
   persistent highlight box and the hint updates its count; confirm no dialog
   opens yet.
5. Click one of the already-selected elements again — confirm its highlight
   box disappears (deselected).
6. Press Shift again — confirm the dialog opens, positioned near the
   selection, labeled with the element count.
7. Type an instruction and submit — confirm it is sent to the session and the
   message (visible in the session transcript) lists every selected element.
8. Repeat steps 3-4 but press Shift a second time with zero elements
   selected — confirm no dialog opens and the tool returns to its idle hint.
9. Press Escape mid-multi-select — confirm the whole annotation tool exits
   cleanly (overlay removed), same as it does today for a single selection.

- [ ] **Step 5: Report results**

No commit for this task — it is verification-only. If manual verification
surfaces a bug, fix it under a new commit on this branch and re-run the
affected step.

---

## Verification

- Every task above ends with its own test run; Task 5 is the full-suite gate
  before this branch is considered done.
- This plan does not add Playwright/e2e coverage: the existing
  `frontend/e2e/support/fake-bridge.ts` annotation stubs never assert on
  payload shape, so no e2e file needs updating, and the interaction being
  added (in-page keyboard + click state machine) is already covered at the
  preload unit-test level in Task 4.
