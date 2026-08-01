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

// The preload script attaches a closed shadow root so page scripts can't reach
// into (or rewrite) the annotation/text-edit prompt. Tests still need to
// inspect the overlay's contents, so capture the ShadowRoot as it's created
// instead of relying on the (deliberately null for closed roots) `.shadowRoot`
// accessor.
let capturedShadowRoot: ShadowRoot | null = null;
const originalAttachShadow = Element.prototype.attachShadow;
vi.spyOn(Element.prototype, "attachShadow").mockImplementation(function (
	this: Element,
	init: ShadowRootInit,
): ShadowRoot {
	const root = originalAttachShadow.call(this, init);
	capturedShadowRoot = root;
	return root;
});

async function loadAnnotatePreload(bodyHtml = ""): Promise<void> {
	vi.resetModules();
	electronMocks.listeners.clear();
	electronMocks.on.mockClear();
	electronMocks.send.mockClear();
	capturedShadowRoot = null;
	document.body.innerHTML = bodyHtml;
	await import("./annotate-preload");
}

function setAnnotationMode(enabled: boolean): void {
	const listener = electronMocks.listeners.get("browser:annotation:setMode");
	if (!listener) throw new Error("annotation mode listener was not registered");
	listener({}, { enabled });
}

function setTextEditMode(enabled: boolean): void {
	electronMocks.listeners.get("browser:textEdit:setMode")?.({}, { enabled });
}

type Bounds = {
	left: number;
	top: number;
	width: number;
	height: number;
};

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

// The preload script only reacts to trusted events (so a page script can't
// synthesize clicks/keystrokes to drive the overlay) - see the "ignores
// synthetic page events" test below. jsdom marks `isTrusted` as an unforgeable
// own property (can't be redefined or reassigned), so tests exercising the
// real interaction flow wrap the event in a Proxy that reports `isTrusted` as
// true - the same way a genuine, OS-generated user click would be seen by the
// page - while still dispatching (and being read back) as the real event.
function markTrusted<T extends Event>(event: T): T {
	return new Proxy(event, {
		get(target, prop) {
			if (prop === "isTrusted") return true;
			const value = Reflect.get(target, prop, target);
			return typeof value === "function" ? value.bind(target) : value;
		},
	});
}

function dispatchPageEvent(element: Element, type: string): Event {
	const event = markTrusted(new MouseEvent(type, { bubbles: true, cancelable: true }));
	element.dispatchEvent(event);
	return event;
}

function overlayRoot(): ShadowRoot {
	const host = document.querySelector<HTMLDivElement>("[data-ao-annotation-root]");
	if (!host || !capturedShadowRoot) throw new Error("annotation overlay was not rendered");
	return capturedShadowRoot;
}

function highlightStyle(): CSSStyleDeclaration {
	const highlight = overlayRoot().querySelector<HTMLDivElement>(".highlight");
	if (!highlight) throw new Error("annotation highlight was not rendered");
	return highlight.style;
}

function submitPrompt(instruction: string): BrowserAnnotationPageSubmitPayload {
	const root = overlayRoot();
	const textarea = root.querySelector<HTMLTextAreaElement>("textarea");
	const form = root.querySelector<HTMLFormElement>("form");
	if (!textarea || !form) throw new Error("annotation prompt was not rendered");
	textarea.value = instruction;
	form.dispatchEvent(markTrusted(new Event("submit", { bubbles: true, cancelable: true })));
	const submitCall = electronMocks.send.mock.calls.find(([channel]) => channel === "browser:annotation:submit");
	if (!submitCall) throw new Error("annotation submit was not sent");
	return submitCall[1] as BrowserAnnotationPageSubmitPayload;
}

describe("annotate preload text edit overlay", () => {
	beforeEach(async () => {
		await loadAnnotatePreload(`<main><h1>Draft copy</h1></main>`);
	});

	it("uses a closed shadow root so page scripts cannot rewrite the prompt", () => {
		setTextEditMode(true);

		const host = document.querySelector<HTMLElement>("[data-ao-annotation-root]");
		expect(host).toBeTruthy();
		expect(host?.shadowRoot).toBeNull();
		setTextEditMode(false);
	});

	it("ignores synthetic page events for text edit selection and cancellation", () => {
		setTextEditMode(true);

		document.querySelector("h1")?.dispatchEvent(
			new MouseEvent("click", {
				bubbles: true,
				cancelable: true,
				composed: true,
			}),
		);
		document.dispatchEvent(
			new KeyboardEvent("keydown", {
				bubbles: true,
				cancelable: true,
				key: "Escape",
			}),
		);

		expect(electronMocks.send).not.toHaveBeenCalledWith("browser:textEdit:submit", expect.anything());
		expect(electronMocks.send).not.toHaveBeenCalledWith("browser:textEdit:cancel", expect.anything());
		setTextEditMode(false);
	});
});

describe("annotate preload", () => {
	beforeEach(async () => {
		await loadAnnotatePreload();
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
		expect(payload.context.selector).toBe("button#first");
	});

	it("keeps prompt controls active for cancel and escape", () => {
		const first = elementWithBounds("first", { left: 12, top: 24, width: 120, height: 40 });

		dispatchPageEvent(first, "click");
		const cancelButton = overlayRoot().querySelector<HTMLButtonElement>('[data-action="cancel"]');
		cancelButton?.dispatchEvent(markTrusted(new MouseEvent("click", { bubbles: true, cancelable: true })));

		expect(electronMocks.send).toHaveBeenCalledWith("browser:annotation:cancel", { reason: "cancel" });
		expect(document.querySelector("[data-ao-annotation-root]")).toBeNull();

		electronMocks.send.mockClear();
		setAnnotationMode(true);
		dispatchPageEvent(first, "click");
		document.dispatchEvent(markTrusted(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true })));

		expect(electronMocks.send).toHaveBeenCalledWith("browser:annotation:cancel", { reason: "escape" });
		expect(document.querySelector("[data-ao-annotation-root]")).toBeNull();
	});
});
