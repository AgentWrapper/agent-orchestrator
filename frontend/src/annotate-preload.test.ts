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

// jsdom implements neither FontFace nor document.fonts; stub both so
// registerFonts() runs for real instead of short-circuiting on the
// "not supported" guard, so tests exercise the actual loading path.
const fontMocks = vi.hoisted(() => ({
	families: [] as string[],
	add: vi.fn(),
}));

class MockFontFace {
	family: string;
	constructor(family: string) {
		this.family = family;
		fontMocks.families.push(family);
	}
	load(): Promise<MockFontFace> {
		return Promise.resolve(this);
	}
}

vi.stubGlobal("FontFace", MockFontFace);
Object.defineProperty(document, "fonts", {
	configurable: true,
	value: { add: fontMocks.add },
});

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
		fontMocks.add.mockClear();
		fontMocks.families.length = 0;
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

	it("renders a compact auto-growing prompt and submits from the embedded action", () => {
		const first = elementWithBounds("first", { left: 12, top: 24, width: 120, height: 40 });

		dispatchPageEvent(first, "click");

		const root = overlayRoot();
		const form = root.querySelector<HTMLFormElement>("form");
		const textarea = root.querySelector<HTMLTextAreaElement>("textarea");
		const primaryAction = root.querySelector<HTMLButtonElement>('button[type="submit"]');

		expect(root.querySelector(".prompt__header")).toBeNull();
		expect(fontMocks.families).toContain("Geist Variable");
		expect(fontMocks.families).toContain("Geist Mono Variable");
		expect(fontMocks.add).toHaveBeenCalledTimes(2);
		expect(form).toHaveAttribute("aria-label", "Annotate selection");
		expect(root.querySelector(".prompt__meta")).toBeNull();
		expect(root.querySelector(".prompt__shortcuts")).toBeNull();
		expect(root.querySelector('[data-action="cancel"]')).toBeNull();
		expect(primaryAction).toBeTruthy();
		expect(primaryAction).toHaveAttribute("aria-label", "Send annotation");
		expect(primaryAction).toHaveAttribute("title", "Send (⌘/Ctrl + Enter)");
		expect(primaryAction?.disabled).toBe(true);
		expect(textarea).not.toBeNull();
		expect(textarea).toHaveAttribute("rows", "1");
		expect(textarea).toHaveAttribute("placeholder", "Describe the change…");
		expect(root.querySelector("style")?.textContent).toContain(
			"max-height: var(--ao-prompt-textarea-max-height, 350px)",
		);

		textarea!.value = "Make this button easier to notice.";
		textarea!.dispatchEvent(
			new KeyboardEvent("keydown", { key: "Enter", ctrlKey: true, bubbles: true, cancelable: true }),
		);

		expect(electronMocks.send).toHaveBeenCalledWith(
			"browser:annotation:submit",
			expect.objectContaining({ instruction: "Make this button easier to notice." }),
		);
	});

	it("grows long comments to a viewport-aware limit with invisible scrolling", () => {
		const first = elementWithBounds("first", { left: 12, top: 24, width: 120, height: 40 });
		dispatchPageEvent(first, "click");

		const root = overlayRoot();
		const form = root.querySelector<HTMLFormElement>("form")!;
		const textarea = root.querySelector<HTMLTextAreaElement>("textarea")!;
		Object.defineProperty(textarea, "scrollHeight", { configurable: true, value: 900 });
		textarea.value = "A very long annotation";
		textarea.dispatchEvent(new Event("input", { bubbles: true }));

		expect(form).toHaveClass("prompt--expanded");
		expect(textarea.style.height).toBe("312px");
		expect(textarea.style.overflowY).toBe("auto");
		expect(form.style.getPropertyValue("--ao-prompt-textarea-max-height")).toBe("312px");
		expect(root.querySelector("style")?.textContent).toContain("padding: 6px 9px");
		expect(root.querySelector("style")?.textContent).toContain("padding: 5px 5px 43px");
		expect(root.querySelector("style")?.textContent).toContain(".prompt::after");
		expect(root.querySelector("style")?.textContent).toContain("scrollbar-width: none");
		expect(root.querySelector("style")?.textContent).toContain("textarea::-webkit-scrollbar");
	});

	it("uses the room above for a selected element near the viewport bottom", () => {
		const originalHeight = window.innerHeight;
		Object.defineProperty(window, "innerHeight", { configurable: true, value: 500 });
		const first = elementWithBounds("first", { left: 12, top: 420, width: 120, height: 40 });
		dispatchPageEvent(first, "click");

		const root = overlayRoot();
		const form = root.querySelector<HTMLFormElement>("form")!;
		const textarea = root.querySelector<HTMLTextAreaElement>("textarea")!;
		Object.defineProperty(textarea, "scrollHeight", { configurable: true, value: 900 });
		textarea.value = "A very long annotation";
		textarea.dispatchEvent(new Event("input", { bubbles: true }));

		expect(form).toHaveClass("prompt--expanded");
		expect(textarea.style.height).toBe("312px");
		expect(Number.parseFloat(form.style.top)).toBeLessThan(420);

		Object.defineProperty(window, "innerHeight", { configurable: true, value: originalHeight });
	});

	it("keeps prompt controls active for escape", () => {
		const first = elementWithBounds("first", { left: 12, top: 24, width: 120, height: 40 });

		dispatchPageEvent(first, "click");
		document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));

		expect(electronMocks.send).toHaveBeenCalledWith("browser:annotation:cancel", { reason: "escape" });
		expect(document.querySelector("[data-ao-annotation-root]")).toBeNull();
	});

	it("reflows and repositions an open prompt when the browser viewport narrows", () => {
		const originalWidth = window.innerWidth;
		const originalVisualViewport = window.visualViewport;
		const first = elementWithBounds("first", { left: 700, top: 24, width: 120, height: 40 });

		dispatchPageEvent(first, "click");
		const root = overlayRoot();
		const textarea = root.querySelector<HTMLTextAreaElement>("textarea")!;
		const form = root.querySelector<HTMLFormElement>("form")!;
		textarea.value = "Keep this feedback while resizing.";

		Object.defineProperty(window, "innerWidth", { configurable: true, value: 520 });
		Object.defineProperty(window, "visualViewport", {
			configurable: true,
			value: { width: 320, height: window.innerHeight },
		});
		window.dispatchEvent(new Event("resize"));

		expect(form.style.width).toBe("292px");
		expect(form.style.left).toBe("14px");
		expect(textarea.value).toBe("Keep this feedback while resizing.");

		Object.defineProperty(window, "innerWidth", { configurable: true, value: originalWidth });
		Object.defineProperty(window, "visualViewport", { configurable: true, value: originalVisualViewport });
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
