import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BrowserAnnotationPageSubmitPayload } from "./shared/browser-annotations";

const electronMocks = vi.hoisted(() => {
	const listeners = new Map<string, (...args: unknown[]) => void>();
	return {
		listeners,
		on: vi.fn((channel: string, listener: (...args: unknown[]) => void) => {
			listeners.set(channel, listener);
		}),
		send: vi.fn(),
	};
});

vi.mock("electron", () => ({
	ipcRenderer: {
		on: electronMocks.on,
		send: electronMocks.send,
	},
}));

await import("./annotate-preload");

type Bounds = {
	left: number;
	top: number;
	width: number;
	height: number;
};

function setAnnotationMode(enabled: boolean): void {
	const listener = electronMocks.listeners.get("browser:annotation:setMode");
	if (!listener) throw new Error("annotation mode listener was not registered");
	listener({}, { enabled });
}

function elementWithBounds(id: string, bounds: Bounds, tag = "button"): HTMLElement {
	const element = document.createElement(tag);
	element.id = id;
	Object.defineProperty(element, "getBoundingClientRect", {
		configurable: true,
		value: () =>
			({
				x: bounds.left,
				y: bounds.top,
				left: bounds.left,
				top: bounds.top,
				right: bounds.left + bounds.width,
				bottom: bounds.top + bounds.height,
				width: bounds.width,
				height: bounds.height,
				toJSON: () => ({}),
			}) as DOMRect,
	});
	document.body.appendChild(element);
	return element;
}

function dispatchPageEvent(element: Element, type: string): Event {
	const event = new MouseEvent(type, { bubbles: true, cancelable: true });
	element.dispatchEvent(event);
	return event;
}

function overlayRoot(): ShadowRoot {
	const host = document.querySelector<HTMLDivElement>("[data-ao-annotation-root]");
	if (!host?.shadowRoot) throw new Error("annotation overlay was not rendered");
	return host.shadowRoot;
}

function highlightStyle(): CSSStyleDeclaration {
	const highlight = overlayRoot().querySelector<HTMLDivElement>(".highlight");
	if (!highlight) throw new Error("annotation highlight was not rendered");
	return highlight.style;
}

function shiftKeyDown(repeat = false): void {
	document.dispatchEvent(new KeyboardEvent("keydown", { key: "Shift", bubbles: true, cancelable: true, repeat }));
}

function selectionBoxes(): HTMLDivElement[] {
	return Array.from(overlayRoot().querySelectorAll<HTMLDivElement>(".selections .highlight--selected"));
}

function promptForm(): HTMLFormElement | null {
	return overlayRoot().querySelector<HTMLFormElement>("form");
}

function submitPrompt(instruction: string): BrowserAnnotationPageSubmitPayload {
	const root = overlayRoot();
	const textarea = root.querySelector<HTMLTextAreaElement>("textarea");
	const form = root.querySelector<HTMLFormElement>("form");
	if (!textarea || !form) throw new Error("annotation prompt was not rendered");
	textarea.value = instruction;
	form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
	const submitCall = electronMocks.send.mock.calls.find(([channel]) => channel === "browser:annotation:submit");
	if (!submitCall) throw new Error("annotation submit was not sent");
	return submitCall[1] as BrowserAnnotationPageSubmitPayload;
}

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

describe("annotate preload", () => {
	beforeEach(() => {
		document.body.innerHTML = "";
		electronMocks.send.mockClear();
		setAnnotationMode(true);
	});

	afterEach(() => {
		setAnnotationMode(false);
		document.body.innerHTML = "";
		electronMocks.send.mockClear();
		document.elementFromPoint = () => null;
	});

	it("keeps the selected highlight locked while the prompt is open", () => {
		const first = elementWithBounds("first", { left: 12, top: 24, width: 120, height: 40 });
		const second = elementWithBounds("second", { left: 240, top: 160, width: 80, height: 30 });

		dispatchPageEvent(first, "pointermove");
		dispatchPageEvent(first, "click");
		dispatchPageEvent(second, "pointermove");

		expect(highlightStyle().left).toBe("12px");
		expect(highlightStyle().top).toBe("24px");
		expect(highlightStyle().width).toBe("120px");
		expect(highlightStyle().height).toBe("40px");
	});

	it("ignores underlying page clicks while the prompt is open", () => {
		const first = elementWithBounds("first", { left: 12, top: 24, width: 120, height: 40 });
		const second = elementWithBounds("second", { left: 240, top: 160, width: 80, height: 30 });
		const secondClick = vi.fn();
		second.addEventListener("click", secondClick);

		dispatchPageEvent(first, "click");
		const ignoredClick = dispatchPageEvent(second, "click");

		expect(ignoredClick.defaultPrevented).toBe(true);
		expect(secondClick).not.toHaveBeenCalled();
		expect(highlightStyle().left).toBe("12px");
		expect(highlightStyle().top).toBe("24px");
	});

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

	it("keeps prompt controls active for cancel and escape", () => {
		const first = elementWithBounds("first", { left: 12, top: 24, width: 120, height: 40 });

		dispatchPageEvent(first, "click");
		overlayRoot().querySelector<HTMLButtonElement>('[data-action="cancel"]')?.click();

		expect(electronMocks.send).toHaveBeenCalledWith("browser:annotation:cancel", { reason: "cancel" });
		expect(document.querySelector("[data-ao-annotation-root]")).toBeNull();

		electronMocks.send.mockClear();
		setAnnotationMode(true);
		dispatchPageEvent(first, "click");
		document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));

		expect(electronMocks.send).toHaveBeenCalledWith("browser:annotation:cancel", { reason: "escape" });
		expect(document.querySelector("[data-ao-annotation-root]")).toBeNull();
	});

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

	it("does not let an already-selected element consume a cap slot from newly-swept elements", () => {
		const gridX = [25, 75, 125, 175, 225, 275, 325, 375];
		const points = [...gridX.map((x) => ({ x, y: 25 })), ...gridX.map((x) => ({ x, y: 75 }))];
		// Sized largest so it would always survive the area-based cap if it were
		// still competing for a slot pre-fix (i.e. this is a hard test of the fix).
		const alreadySelected = elementWithBounds("already-selected", {
			left: points[0].x - 20,
			top: points[0].y - 20,
			width: 40,
			height: 40,
		});
		const fresh = points
			.slice(1, 16)
			.map((point, index) =>
				elementWithBounds(`fresh-${index}`, { left: point.x - 15, top: point.y - 15, width: 30, height: 30 }),
			);
		stubElementFromPoint([alreadySelected, ...fresh]);

		shiftKeyDown();
		dispatchPageEvent(alreadySelected, "click");
		expect(selectionBoxes()).toHaveLength(1);

		dragLasso([
			{ x: 0, y: 0 },
			{ x: 400, y: 0 },
			{ x: 400, y: 400 },
			{ x: 0, y: 400 },
		]);

		// All 15 fresh elements should be added on top of the 1 already selected —
		// none of the cap's 15 slots should be spent re-confirming the element
		// that was already selected before this lasso pass.
		expect(selectionBoxes()).toHaveLength(16);
	});

	it("does not select a container element when a more specific descendant inside the lasso is also found", () => {
		const container = elementWithBounds("card", { left: 0, top: 0, width: 400, height: 400 }, "div");
		const childA = elementWithBounds("name-field", { left: 10, top: 10, width: 30, height: 30 });
		const childB = elementWithBounds("role-field", { left: 360, top: 360, width: 30, height: 30 });
		container.appendChild(childA);
		container.appendChild(childB);
		// Children checked before the container: a grid point inside a child's
		// rect must resolve to the child, matching real elementFromPoint stacking
		// order; a point that only lands on the container's own whitespace falls
		// through to the container.
		stubElementFromPoint([childA, childB, container]);

		shiftKeyDown();
		dragLasso([
			{ x: 0, y: 0 },
			{ x: 400, y: 0 },
			{ x: 400, y: 400 },
			{ x: 0, y: 400 },
		]);

		const boxes = selectionBoxes();
		expect(boxes).toHaveLength(2);
		expect(boxes.every((box) => box.style.width === "30px")).toBe(true);
	});
});
