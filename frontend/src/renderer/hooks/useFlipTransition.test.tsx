import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { computeInvertTransform, useFlipTransition } from "./useFlipTransition";

function rect(partial: Partial<DOMRect>): DOMRect {
	return {
		x: partial.left ?? 0,
		y: partial.top ?? 0,
		left: 0,
		top: 0,
		right: 0,
		bottom: 0,
		width: 0,
		height: 0,
		toJSON: () => "",
		...partial,
	} as DOMRect;
}

function mockRects(node: HTMLElement, ...rects: DOMRect[]) {
	let call = 0;
	vi.spyOn(node, "getBoundingClientRect").mockImplementation(() => rects[Math.min(call++, rects.length - 1)]);
}

describe("computeInvertTransform", () => {
	it("computes translate + scale so the element visually stays at the first rect", () => {
		const first = rect({ left: 100, top: 50, width: 200, height: 100 });
		const last = rect({ left: 0, top: 0, width: 800, height: 400 });

		const result = computeInvertTransform(first, last);

		expect(result.transformOrigin).toBe("0 0");
		expect(result.transform).toBe("translate(100px, 50px) scale(0.25, 0.25)");
	});

	it("returns an identity transform when the rects are equal", () => {
		const same = rect({ left: 10, top: 20, width: 300, height: 150 });

		const result = computeInvertTransform(same, same);

		expect(result.transform).toBe("translate(0px, 0px) scale(1, 1)");
	});
});

describe("useFlipTransition", () => {
	let node: HTMLDivElement;

	beforeEach(() => {
		node = document.createElement("div");
		document.body.appendChild(node);
		vi.useFakeTimers();
	});

	afterEach(() => {
		vi.useRealTimers();
		vi.restoreAllMocks();
		node.remove();
	});

	it("applies the inverted transform synchronously so the element appears not to have moved", () => {
		const first = rect({ left: 100, top: 50, width: 200, height: 100 });
		const last = rect({ left: 0, top: 0, width: 800, height: 400 });
		mockRects(node, first, last);

		const { result } = renderHook(() => useFlipTransition());
		act(() => result.current.captureRect(node));
		act(() => result.current.playFlip(node));

		expect(node.style.transform).toBe("translate(100px, 50px) scale(0.25, 0.25)");
		expect(node.style.transition).toBe("none");
	});

	it("clears the transform and starts the CSS transition on the next frame", () => {
		const first = rect({ left: 100, top: 50, width: 200, height: 100 });
		const last = rect({ left: 0, top: 0, width: 800, height: 400 });
		mockRects(node, first, last, last);

		const { result } = renderHook(() => useFlipTransition());
		act(() => result.current.captureRect(node));
		act(() => result.current.playFlip(node, { duration: 320, easing: "ease-out" }));
		act(() => {
			vi.advanceTimersByTime(16);
		});

		expect(node.style.transform).toBe("");
		expect(node.style.transition).toBe("transform 320ms ease-out");
	});

	it("calls onSettle when transitionend fires for the transform property", () => {
		const first = rect({ left: 100, top: 50, width: 200, height: 100 });
		const last = rect({ left: 0, top: 0, width: 800, height: 400 });
		mockRects(node, first, last, last);
		const onSettle = vi.fn();

		const { result } = renderHook(() => useFlipTransition());
		act(() => result.current.captureRect(node));
		act(() => result.current.playFlip(node, { onSettle }));
		act(() => {
			vi.advanceTimersByTime(16);
		});

		expect(onSettle).not.toHaveBeenCalled();
		act(() => {
			const event = new Event("transitionend", { bubbles: false });
			Object.defineProperty(event, "propertyName", { value: "transform" });
			node.dispatchEvent(event);
		});

		expect(onSettle).toHaveBeenCalledTimes(1);
	});

	it("falls back to onSettle via timeout when transitionend never fires", () => {
		const first = rect({ left: 100, top: 50, width: 200, height: 100 });
		const last = rect({ left: 0, top: 0, width: 800, height: 400 });
		mockRects(node, first, last, last);
		const onSettle = vi.fn();

		const { result } = renderHook(() => useFlipTransition());
		act(() => result.current.captureRect(node));
		act(() => result.current.playFlip(node, { duration: 320, onSettle }));
		act(() => {
			vi.advanceTimersByTime(16);
		});
		expect(onSettle).not.toHaveBeenCalled();

		act(() => {
			vi.advanceTimersByTime(320 + 200);
		});
		expect(onSettle).toHaveBeenCalledTimes(1);
	});

	it("skips the animation and settles immediately under prefers-reduced-motion", () => {
		vi.spyOn(window, "matchMedia").mockReturnValue({
			matches: true,
			media: "(prefers-reduced-motion: reduce)",
			onchange: null,
			addEventListener: () => undefined,
			removeEventListener: () => undefined,
			addListener: () => undefined,
			removeListener: () => undefined,
			dispatchEvent: () => false,
		} as unknown as MediaQueryList);
		const first = rect({ left: 100, top: 50, width: 200, height: 100 });
		const last = rect({ left: 0, top: 0, width: 800, height: 400 });
		mockRects(node, first, last);
		const onSettle = vi.fn();

		const { result } = renderHook(() => useFlipTransition());
		act(() => result.current.captureRect(node));
		act(() => result.current.playFlip(node, { onSettle }));

		expect(onSettle).toHaveBeenCalledTimes(1);
		expect(node.style.transform).toBe("");
	});

	it("settles immediately when no rect was captured first", () => {
		const onSettle = vi.fn();
		const { result } = renderHook(() => useFlipTransition());
		act(() => result.current.playFlip(node, { onSettle }));

		expect(onSettle).toHaveBeenCalledTimes(1);
		expect(node.style.transform).toBe("");
	});

	it("cancels an in-flight animation when playFlip runs again, without firing the stale onSettle", () => {
		const first = rect({ left: 100, top: 50, width: 200, height: 100 });
		const mid = rect({ left: 20, top: 20, width: 400, height: 200 });
		const last = rect({ left: 0, top: 0, width: 800, height: 400 });
		mockRects(node, first, mid, mid, mid, last, last);
		const firstSettle = vi.fn();
		const secondSettle = vi.fn();

		const { result } = renderHook(() => useFlipTransition());
		act(() => result.current.captureRect(node));
		act(() => result.current.playFlip(node, { onSettle: firstSettle }));

		act(() => result.current.captureRect(node));
		act(() => result.current.playFlip(node, { onSettle: secondSettle }));
		act(() => {
			vi.advanceTimersByTime(2000);
		});

		expect(firstSettle).not.toHaveBeenCalled();
		expect(secondSettle).toHaveBeenCalledTimes(1);
	});
});
