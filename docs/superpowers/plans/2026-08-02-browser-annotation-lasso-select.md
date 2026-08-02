# Freehand lasso element selection — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a human, while in the browser annotation tool's multi-select mode
(entered via Shift-toggle, shipped in `feat/browser-annotation-multiselect`),
drag a freehand lasso across the page to sweep up several elements at once,
added to the same selection set as individually shift-clicked elements.

**Architecture:** This branch is stacked on top of `feat/browser-annotation-multiselect`
and reuses its selection state machine (`multiSelectActive`/`multiSelectElements`/
`multiSelectContexts` in `frontend/src/annotate-preload.ts`) unchanged. The lasso
is a new way to populate `multiSelectElements` — not a new mode, not a new data
shape. A `pointerdown` while multi-select is active starts tracking; if the
pointer moves past a small threshold before `pointerup`, the gesture becomes a
lasso drag (otherwise it's treated as today's plain click-to-toggle). On
release, the traced path is closed into a polygon, a grid of sample points
across its bounding box is tested with point-in-polygon, and every element
found at a surviving point is added to the existing selection array. Finalize
(press Shift again) is completely unchanged — it already builds the prompt
from whatever is in `multiSelectElements`, regardless of whether elements got
there via click or lasso.

**Tech Stack:** TypeScript, Vitest (jsdom), Electron preload script (no
framework — direct DOM APIs and a Shadow DOM overlay, matching the existing
file's style).

## Global Constraints

- **No screenshot/image capture in this pass.** The roadmap's original B6 spec
  captures a cropped screenshot of the lasso's bounding box and attaches it to
  the chat message, but `/api/v1/sessions/{sessionId}/send`
  (`SendSessionMessageRequest`, `frontend/src/api/schema.ts:1290-1292`) only
  accepts `{message: string}` today — there is no image-attachment path for an
  already-running session (only at brand-new-session spawn time, a different
  code path). Explicit user decision this session: ship lasso *selection* only;
  screenshot capture is a separate, larger, cross-stack follow-up.
- **Reuse the existing multi-select state machine as-is.** Do not introduce a
  parallel/duplicate selection array, a new IPC channel, or a new payload
  shape. The lasso only changes which elements land in `multiSelectElements`
  before finalize.
- **No changes to `browser-view-host.ts`, `browser-annotations.ts`,
  `BrowserPanel.tsx`, or any IPC surface.** The submitted payload shape
  (`{kind: "elements", contexts}`) is unchanged, so nothing downstream needs to
  change — confirmed by reading the full submit/forward path.
- **Distance-threshold path simplification only** (no Douglas-Peucker) — a
  lasso point is appended only once the pointer has moved **≥4px** from the
  last recorded point. The same 4px value is also the click-vs-drag movement
  threshold.
- **Element intersection:** sample an **8×8 grid** of points across the lasso
  path's axis-aligned bounding box, test each with standard ray-casting
  point-in-polygon, then resolve surviving points via
  `document.elementFromPoint` + the existing `annotationTarget()` normalization
  (the same function hover/click already use) — not `elementsFromPoint`.
- **Cap newly-added lasso elements to 15**, preferring the largest by visible
  area, to bound very broad sweeps.
- A completed lasso drag (movement ≥4px) must suppress the native trailing
  `click` event so the element under the pointer isn't immediately toggled
  back off.
- A plain click, or a drag that never crosses the 4px threshold, must behave
  exactly like today's click-to-toggle — zero regression to the shipped
  shift-click flow.
- **Out of scope, not part of this pass:** an `Enter`-key finalize shortcut
  (roadmap step 9) — Shift-toggle is already the shipped, working finalize
  path and adding a second one is a separate small enhancement, not part of
  "the lasso feature" the user asked for. Do not add it.

---

### Task 1: Lasso geometry helpers

**Files:**
- Modify: `frontend/src/shared/browser-annotation-overlay.ts`
- Create: `frontend/src/shared/browser-annotation-overlay.test.ts`

**Interfaces:**
- Produces (consumed by Task 2):
  - `type LassoPoint = { x: number; y: number }`
  - `type LassoBounds = { left: number; top: number; right: number; bottom: number }`
  - `shouldAppendLassoPoint(lastPoint: LassoPoint | null, next: LassoPoint, minDistance: number): boolean`
  - `closeLassoPath(points: LassoPoint[]): LassoPoint[]`
  - `boundingRectOfPoints(points: LassoPoint[]): LassoBounds`
  - `sampleGridPoints(bounds: LassoBounds, columns: number, rows: number): LassoPoint[]`
  - `pointInPolygon(point: LassoPoint, polygon: LassoPoint[]): boolean`

- [ ] **Step 1: Write the failing tests**

Create `frontend/src/shared/browser-annotation-overlay.test.ts`:

```typescript
import { describe, expect, it } from "vitest";
import {
	boundingRectOfPoints,
	closeLassoPath,
	pointInPolygon,
	sampleGridPoints,
	shouldAppendLassoPoint,
} from "./browser-annotation-overlay";

describe("shouldAppendLassoPoint", () => {
	it("always appends the first point", () => {
		expect(shouldAppendLassoPoint(null, { x: 10, y: 10 }, 4)).toBe(true);
	});

	it("rejects a point closer than the minimum distance", () => {
		expect(shouldAppendLassoPoint({ x: 10, y: 10 }, { x: 12, y: 10 }, 4)).toBe(false);
	});

	it("accepts a point at least the minimum distance away", () => {
		expect(shouldAppendLassoPoint({ x: 10, y: 10 }, { x: 14, y: 10 }, 4)).toBe(true);
	});
});

describe("closeLassoPath", () => {
	it("returns an empty path unchanged", () => {
		expect(closeLassoPath([])).toEqual([]);
	});

	it("appends the first point to close an open path", () => {
		const path = [
			{ x: 0, y: 0 },
			{ x: 10, y: 0 },
			{ x: 10, y: 10 },
		];
		expect(closeLassoPath(path)).toEqual([...path, { x: 0, y: 0 }]);
	});

	it("does not duplicate the closing point when the path is already closed", () => {
		const path = [
			{ x: 0, y: 0 },
			{ x: 10, y: 0 },
			{ x: 0, y: 0 },
		];
		expect(closeLassoPath(path)).toEqual(path);
	});
});

describe("boundingRectOfPoints", () => {
	it("computes the axis-aligned bounds of a point set", () => {
		const points = [
			{ x: 10, y: 40 },
			{ x: 60, y: 5 },
			{ x: 25, y: 90 },
		];
		expect(boundingRectOfPoints(points)).toEqual({ left: 10, top: 5, right: 60, bottom: 90 });
	});
});

describe("sampleGridPoints", () => {
	it("samples the center of each grid cell", () => {
		const points = sampleGridPoints({ left: 0, top: 0, right: 100, bottom: 100 }, 2, 2);
		expect(points).toEqual([
			{ x: 25, y: 25 },
			{ x: 75, y: 25 },
			{ x: 25, y: 75 },
			{ x: 75, y: 75 },
		]);
	});
});

describe("pointInPolygon", () => {
	const square = [
		{ x: 0, y: 0 },
		{ x: 100, y: 0 },
		{ x: 100, y: 100 },
		{ x: 0, y: 100 },
	];

	it("treats a point inside the polygon as inside", () => {
		expect(pointInPolygon({ x: 50, y: 50 }, square)).toBe(true);
	});

	it("treats a point outside the polygon as outside", () => {
		expect(pointInPolygon({ x: 150, y: 50 }, square)).toBe(false);
	});

	it("treats a point beyond a triangle's hypotenuse as outside", () => {
		const triangle = [
			{ x: 0, y: 0 },
			{ x: 100, y: 0 },
			{ x: 0, y: 100 },
		];
		// (80, 80) is beyond the hypotenuse (x + y = 100).
		expect(pointInPolygon({ x: 80, y: 80 }, triangle)).toBe(false);
		// (20, 20) is well inside.
		expect(pointInPolygon({ x: 20, y: 20 }, triangle)).toBe(true);
	});
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm --prefix frontend exec -- vitest run src/shared/browser-annotation-overlay.test.ts`
Expected: FAIL — `shouldAppendLassoPoint`, `closeLassoPath`, `boundingRectOfPoints`,
`sampleGridPoints`, `pointInPolygon` are not exported from `./browser-annotation-overlay`.

- [ ] **Step 3: Implement the helpers**

Append to `frontend/src/shared/browser-annotation-overlay.ts` (the file currently
ends after the `clamp` function at the bottom — add everything below as new
code after it; leave `AnnotationRectLike`, `AnnotationPromptViewport`,
`promptPositionForRect`, and `clamp` exactly as they are):

```typescript
export type LassoPoint = { x: number; y: number };

export type LassoBounds = { left: number; top: number; right: number; bottom: number };

// Simplifies a freehand drag into a manageable point set: a point is kept
// only once the pointer has moved at least `minDistance` from the last kept
// point. Sufficient for v1 in place of full Douglas-Peucker simplification.
export function shouldAppendLassoPoint(lastPoint: LassoPoint | null, next: LassoPoint, minDistance: number): boolean {
	if (!lastPoint) return true;
	return Math.hypot(next.x - lastPoint.x, next.y - lastPoint.y) >= minDistance;
}

export function closeLassoPath(points: LassoPoint[]): LassoPoint[] {
	if (points.length === 0) return points;
	const first = points[0];
	const last = points[points.length - 1];
	if (first.x === last.x && first.y === last.y) return points;
	return [...points, first];
}

export function boundingRectOfPoints(points: LassoPoint[]): LassoBounds {
	const xs = points.map((point) => point.x);
	const ys = points.map((point) => point.y);
	return {
		left: Math.min(...xs),
		top: Math.min(...ys),
		right: Math.max(...xs),
		bottom: Math.max(...ys),
	};
}

export function sampleGridPoints(bounds: LassoBounds, columns: number, rows: number): LassoPoint[] {
	const width = bounds.right - bounds.left;
	const height = bounds.bottom - bounds.top;
	const points: LassoPoint[] = [];
	for (let row = 0; row < rows; row += 1) {
		for (let col = 0; col < columns; col += 1) {
			points.push({
				x: bounds.left + ((col + 0.5) / columns) * width,
				y: bounds.top + ((row + 0.5) / rows) * height,
			});
		}
	}
	return points;
}

// Standard ray-casting point-in-polygon test.
export function pointInPolygon(point: LassoPoint, polygon: LassoPoint[]): boolean {
	let inside = false;
	for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
		const a = polygon[i];
		const b = polygon[j];
		const crosses = a.y > point.y !== b.y > point.y;
		if (!crosses) continue;
		const intersectX = ((b.x - a.x) * (point.y - a.y)) / (b.y - a.y) + a.x;
		if (point.x < intersectX) inside = !inside;
	}
	return inside;
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm --prefix frontend exec -- vitest run src/shared/browser-annotation-overlay.test.ts`
Expected: PASS (16 tests).

- [ ] **Step 5: Typecheck**

Run: `npm --prefix frontend run typecheck`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add frontend/src/shared/browser-annotation-overlay.ts frontend/src/shared/browser-annotation-overlay.test.ts
git commit -m "feat(browser-annotation-overlay): add lasso geometry helpers"
```

---

### Task 2: Freehand lasso drag gesture in the annotation preload

**Files:**
- Modify: `frontend/src/annotate-preload.ts`
- Modify: `frontend/src/annotate-preload.test.ts`

**Interfaces:**
- Consumes (from Task 1): `LassoPoint`, `LassoBounds`, `shouldAppendLassoPoint`,
  `closeLassoPath`, `boundingRectOfPoints`, `sampleGridPoints`, `pointInPolygon`
  from `./shared/browser-annotation-overlay`.
- Consumes (already shipped, unchanged): `multiSelectActive`, `multiSelectElements`,
  `multiSelectContexts`, `toggleMultiSelectElement`, `renderMultiSelections`,
  `renderHint`, `hideHoverHighlight`, `finishMultiSelect`, `annotationTarget`,
  `isOverlayEvent`, `ensureOverlay` — all already defined in
  `frontend/src/annotate-preload.ts`.

- [ ] **Step 1: Write the failing tests**

Add these helpers to `frontend/src/annotate-preload.test.ts`, placed after the
existing `submitPrompt` helper (around line 99, before the `describe(...)` block):

```typescript
function dispatchPointerEvent(target: EventTarget, type: string, point: { x: number; y: number }): void {
	const event = new MouseEvent(type, { bubbles: true, cancelable: true, clientX: point.x, clientY: point.y, button: 0 });
	target.dispatchEvent(event);
}

function dragLasso(points: { x: number; y: number }[]): void {
	dispatchPointerEvent(document.body, "pointerdown", points[0]);
	for (const point of points.slice(1)) {
		dispatchPointerEvent(document.body, "pointermove", point);
	}
	dispatchPointerEvent(document.body, "pointerup", points[points.length - 1]);
}

function stubElementFromPoint(elements: Element[]): void {
	document.elementFromPoint = (x: number, y: number): Element | null => {
		for (const element of elements) {
			const rect = element.getBoundingClientRect();
			if (x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom) return element;
		}
		return null;
	};
}
```

Also extend the existing `afterEach` (around line 108-112) to reset the stub
between tests, so a later test that doesn't call `stubElementFromPoint` can't
see a previous test's now-detached elements:

```typescript
	afterEach(() => {
		setAnnotationMode(false);
		document.body.innerHTML = "";
		electronMocks.send.mockClear();
		document.elementFromPoint = () => null;
	});
```

Then add these `it` blocks inside the existing `describe("annotate preload", ...)`
block, after the last existing test ("cancels an in-progress multi-selection on
Escape", currently the final test before the closing `});`):

```typescript
	it("adds every element enclosed by a freehand lasso drag to the selection", () => {
		const first = elementWithBounds("first", { left: 10, top: 10, width: 40, height: 40 });
		const second = elementWithBounds("second", { left: 200, top: 200, width: 40, height: 40 });
		const outside = elementWithBounds("outside", { left: 500, top: 500, width: 40, height: 40 });
		stubElementFromPoint([first, second, outside]);

		shiftKeyDown();
		dragLasso([
			{ x: 0, y: 0 },
			{ x: 260, y: 0 },
			{ x: 260, y: 260 },
			{ x: 0, y: 260 },
		]);

		expect(selectionBoxes()).toHaveLength(2);
		expect(overlayRoot().querySelector(".hint")?.textContent).toContain("2 elements selected");
	});

	it("treats a pointer drag below the movement threshold as a plain click toggle, not a lasso", () => {
		const first = elementWithBounds("first", { left: 10, top: 10, width: 40, height: 40 });

		shiftKeyDown();
		dispatchPointerEvent(document.body, "pointerdown", { x: 30, y: 30 });
		dispatchPointerEvent(document.body, "pointermove", { x: 31, y: 30 });
		dispatchPointerEvent(document.body, "pointerup", { x: 31, y: 30 });
		dispatchPageEvent(first, "click");

		expect(selectionBoxes()).toHaveLength(1);
	});

	it("suppresses the click that follows a completed lasso drag so swept elements are not immediately toggled back off", () => {
		const first = elementWithBounds("first", { left: 10, top: 10, width: 40, height: 40 });
		const second = elementWithBounds("second", { left: 200, top: 200, width: 40, height: 40 });
		stubElementFromPoint([first, second]);

		shiftKeyDown();
		dragLasso([
			{ x: 0, y: 0 },
			{ x: 260, y: 0 },
			{ x: 260, y: 260 },
			{ x: 0, y: 260 },
		]);
		expect(selectionBoxes()).toHaveLength(2);

		dispatchPageEvent(first, "click");

		expect(selectionBoxes()).toHaveLength(2);
	});

	it("renders the lasso path while dragging and clears it after release", () => {
		shiftKeyDown();
		dispatchPointerEvent(document.body, "pointerdown", { x: 0, y: 0 });
		dispatchPointerEvent(document.body, "pointermove", { x: 100, y: 0 });

		const path = overlayRoot().querySelector<SVGPolygonElement>(".lasso__path");
		expect(path?.getAttribute("points")).toBe("0,0 100,0");

		dispatchPointerEvent(document.body, "pointerup", { x: 100, y: 0 });

		expect(path?.getAttribute("points")).toBe("");
	});

	it("clears an in-progress lasso drag when annotation mode is disabled mid-drag", () => {
		const first = elementWithBounds("first", { left: 10, top: 10, width: 40, height: 40 });

		shiftKeyDown();
		dispatchPointerEvent(document.body, "pointerdown", { x: 0, y: 0 });
		dispatchPointerEvent(document.body, "pointermove", { x: 100, y: 0 });

		setAnnotationMode(false);
		electronMocks.send.mockClear();
		setAnnotationMode(true);
		shiftKeyDown();
		dispatchPageEvent(first, "click");

		expect(selectionBoxes()).toHaveLength(1);
	});

	it("caps newly-added lasso elements to 15, preferring the largest by visible area", () => {
		const gridX = [25, 75, 125, 175, 225, 275, 325, 375];
		const points = [...gridX.map((x) => ({ x, y: 25 })), ...gridX.map((x) => ({ x, y: 75 }))];
		const big = points
			.slice(0, 15)
			.map((point, index) =>
				elementWithBounds(`big-${index}`, { left: point.x - 15, top: point.y - 15, width: 30, height: 30 }),
			);
		const tiny = elementWithBounds("tiny", { left: points[15].x - 2, top: points[15].y - 2, width: 4, height: 4 });
		stubElementFromPoint([...big, tiny]);

		shiftKeyDown();
		dragLasso([
			{ x: 0, y: 0 },
			{ x: 400, y: 0 },
			{ x: 400, y: 400 },
			{ x: 0, y: 400 },
		]);

		const boxes = selectionBoxes();
		expect(boxes).toHaveLength(15);
		expect(boxes.every((box) => box.style.width === "30px")).toBe(true);
	});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm --prefix frontend exec -- vitest run src/annotate-preload.test.ts`
Expected: FAIL — no `pointerdown`/`pointerup` handling exists yet, so no
lasso path renders and no elements get added by a drag (the 6 new tests fail;
the existing tests still pass).

- [ ] **Step 3: Implement the lasso gesture**

Replace the entire contents of `frontend/src/annotate-preload.ts` with:

```typescript
import { ipcRenderer } from "electron";
import {
	createBrowserAnnotationContext,
	type BrowserAnnotationCancelReason,
	type BrowserAnnotationContext,
	type BrowserAnnotationPageSubmitPayload,
} from "./shared/browser-annotations";
import {
	boundingRectOfPoints,
	closeLassoPath,
	pointInPolygon,
	promptPositionForRect,
	sampleGridPoints,
	shouldAppendLassoPoint,
	type AnnotationRectLike,
	type LassoBounds,
	type LassoPoint,
} from "./shared/browser-annotation-overlay";

const LASSO_MOVEMENT_THRESHOLD_PX = 4;
const LASSO_GRID_SIZE = 8;
const LASSO_MAX_NEW_ELEMENTS = 15;

let enabled = false;
let selectedElement: Element | null = null;
let selectedContext: BrowserAnnotationContext | null = null;
let multiSelectActive = false;
let multiSelectElements: Element[] = [];
let multiSelectContexts: BrowserAnnotationContext[] | null = null;
let dragStart: LassoPoint | null = null;
let lassoActive = false;
let lassoPoints: LassoPoint[] = [];
let suppressNextClick = false;
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
	resetLassoState();
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
	document.addEventListener("pointerdown", handlePointerDown, true);
	document.addEventListener("pointerup", handlePointerUp, true);
	document.addEventListener("click", handleClick, true);
	document.addEventListener("keydown", handleKeyDown, true);
	window.addEventListener("scroll", refreshHighlight, true);
	window.addEventListener("resize", refreshHighlight, true);
}

function removeListeners(): void {
	document.removeEventListener("pointerover", handlePointerMove, true);
	document.removeEventListener("pointermove", handlePointerMove, true);
	document.removeEventListener("pointerdown", handlePointerDown, true);
	document.removeEventListener("pointerup", handlePointerUp, true);
	document.removeEventListener("click", handleClick, true);
	document.removeEventListener("keydown", handleKeyDown, true);
	window.removeEventListener("scroll", refreshHighlight, true);
	window.removeEventListener("resize", refreshHighlight, true);
}

function handlePointerMove(event: PointerEvent): void {
	if (!enabled || isOverlayEvent(event)) return;
	if (dragStart) {
		handleLassoPointerMove(event);
		return;
	}
	if (selectedContext || multiSelectContexts) return;
	const target = annotationTarget(event.target);
	if (!target || target === selectedElement) return;
	selectedElement = target;
	selectedContext = null;
	renderHighlight(target, false);
}

function handlePointerDown(event: PointerEvent): void {
	if (!enabled || !multiSelectActive || isOverlayEvent(event) || event.button !== 0) return;
	dragStart = { x: event.clientX, y: event.clientY };
}

function handleLassoPointerMove(event: PointerEvent): void {
	const point: LassoPoint = { x: event.clientX, y: event.clientY };
	if (!lassoActive) {
		if (!shouldAppendLassoPoint(dragStart, point, LASSO_MOVEMENT_THRESHOLD_PX)) return;
		lassoActive = true;
		hideHoverHighlight();
		lassoPoints = dragStart ? [dragStart, point] : [point];
		renderLassoPath(lassoPoints);
		return;
	}
	if (!shouldAppendLassoPoint(lassoPoints[lassoPoints.length - 1] ?? null, point, LASSO_MOVEMENT_THRESHOLD_PX)) return;
	lassoPoints.push(point);
	renderLassoPath(lassoPoints);
}

function handlePointerUp(event: PointerEvent): void {
	if (!enabled || isOverlayEvent(event) || !dragStart) return;
	if (lassoActive) {
		finishLasso();
		suppressNextClick = true;
	}
	dragStart = null;
	lassoActive = false;
	lassoPoints = [];
	clearLassoPath();
}

function handleClick(event: MouseEvent): void {
	if (!enabled || isOverlayEvent(event)) return;
	if (suppressNextClick) {
		suppressNextClick = false;
		event.preventDefault();
		event.stopPropagation();
		event.stopImmediatePropagation();
		return;
	}
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
	resetLassoState();
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

function finishLasso(): void {
	const polygon = closeLassoPath(lassoPoints);
	const bounds = boundingRectOfPoints(polygon);
	for (const element of elementsInLasso(polygon, bounds)) {
		if (!multiSelectElements.includes(element)) multiSelectElements.push(element);
	}
	renderMultiSelections();
	renderHint();
}

function elementsInLasso(polygon: LassoPoint[], bounds: LassoBounds): Element[] {
	const found: Element[] = [];
	for (const point of sampleGridPoints(bounds, LASSO_GRID_SIZE, LASSO_GRID_SIZE)) {
		if (!pointInPolygon(point, polygon)) continue;
		const target = annotationTarget(document.elementFromPoint(point.x, point.y));
		if (!target || found.includes(target)) continue;
		found.push(target);
	}
	return capByVisibleArea(found, LASSO_MAX_NEW_ELEMENTS);
}

function capByVisibleArea(elements: Element[], max: number): Element[] {
	if (elements.length <= max) return elements;
	return [...elements].sort((a, b) => elementArea(b) - elementArea(a)).slice(0, max);
}

function elementArea(element: Element): number {
	const rect = element.getBoundingClientRect();
	return rect.width * rect.height;
}

function resetLassoState(): void {
	dragStart = null;
	lassoActive = false;
	lassoPoints = [];
	suppressNextClick = false;
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
			.lasso {
				position: fixed;
				inset: 0;
				width: 100%;
				height: 100%;
				pointer-events: none;
			}
			.lasso__path {
				fill: rgba(77, 141, 255, 0.10);
				stroke: #4d8dff;
				stroke-width: 1.5;
				stroke-dasharray: 4 3;
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
		<svg class="lasso"><polygon class="lasso__path" points=""></polygon></svg>
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
		return "Click elements to select them, or drag to lasso-select several. Press Shift again to finish.";
	}
	const count = multiSelectElements.length;
	return `${count} element${count === 1 ? "" : "s"} selected. Click or drag to add more, or press Shift to finish.`;
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

function renderLassoPath(points: LassoPoint[]): void {
	const root = ensureOverlay();
	const polygon = root.querySelector<SVGPolygonElement>(".lasso__path");
	if (!polygon) return;
	polygon.setAttribute("points", points.map((point) => `${point.x},${point.y}`).join(" "));
}

function clearLassoPath(): void {
	renderLassoPath([]);
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

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm --prefix frontend exec -- vitest run src/annotate-preload.test.ts`
Expected: PASS (15 tests — 9 existing + 6 new).

- [ ] **Step 5: Typecheck**

Run: `npm --prefix frontend run typecheck`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add frontend/src/annotate-preload.ts frontend/src/annotate-preload.test.ts
git commit -m "feat(annotate-preload): add freehand lasso drag selection"
```

---

## Verification

- Full frontend suite: `npm --prefix frontend exec -- vitest run` — must stay green
  (no regressions to the shipped shift-click multi-select flow or the original
  single-element flow).
- `npm --prefix frontend run typecheck` clean.
- Manually verify via `ao preview` per `AGENTS.md`: enable the annotation tool,
  press Shift, drag a lasso across a few elements, confirm they highlight and
  get included when the prompt opens; confirm a plain click still opens the
  single-element prompt immediately; confirm a small in-place click during
  multi-select still toggles one element without triggering a lasso.
