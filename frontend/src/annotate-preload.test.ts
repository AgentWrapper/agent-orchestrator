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

function elementWithBounds(id: string, bounds: Bounds): HTMLButtonElement {
	const element = document.createElement("button");
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
});
