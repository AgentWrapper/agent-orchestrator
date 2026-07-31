import { act, render, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useMaximizeTransition } from "./useMaximizeTransition";

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

describe("useMaximizeTransition", () => {
	let node: HTMLDivElement;

	beforeEach(() => {
		node = document.createElement("div");
		document.body.appendChild(node);
		vi.spyOn(node, "getBoundingClientRect").mockReturnValue(
			rect({ left: 0, top: 0, width: 800, height: 400 }),
		);
		vi.useFakeTimers();
	});

	afterEach(() => {
		vi.useRealTimers();
		vi.restoreAllMocks();
		node.remove();
	});

	it("plays a FLIP transition and calls onSettle when `maximized` changes, using the origin captured beforehand", () => {
		const onSettle = vi.fn();
		const { result, rerender } = renderHook(
			({ maximized }) => useMaximizeTransition(maximized, onSettle),
			{ initialProps: { maximized: false } },
		);
		act(() => result.current.setNodeRef(node));
		onSettle.mockClear(); // drop the harmless mount-time settle (no node was attached yet then)

		act(() => result.current.captureOrigin());
		vi.spyOn(node, "getBoundingClientRect").mockReturnValue(
			rect({ left: 100, top: 50, width: 200, height: 100 }),
		);
		act(() => rerender({ maximized: true }));

		expect(node.style.transform).toBe("translate(-100px, -50px) scale(4, 4)");

		act(() => {
			vi.advanceTimersByTime(16);
			const event = new Event("transitionend");
			Object.defineProperty(event, "propertyName", { value: "transform" });
			node.dispatchEvent(event);
		});
		expect(onSettle).toHaveBeenCalledTimes(1);
	});

	it("settles immediately without a visible jump when captureOrigin was never called", () => {
		const onSettle = vi.fn();
		const { result, rerender } = renderHook(
			({ maximized }) => useMaximizeTransition(maximized, onSettle),
			{ initialProps: { maximized: false } },
		);
		act(() => result.current.setNodeRef(node));
		onSettle.mockClear(); // drop the harmless mount-time settle (no node was attached yet then)

		act(() => rerender({ maximized: true }));

		expect(node.style.transform).toBe("");
		expect(onSettle).toHaveBeenCalledTimes(1);
	});

	it("still calls onSettle when maximized changes but no node is currently attached (e.g. mid session-switch unmount)", () => {
		// Regression: without this, a popout transition begun just before a
		// session switch (which unmounts the panel node) would never call its
		// onSettle — permanently stuck hiding the native browser view.
		const onSettle = vi.fn();
		const { rerender } = renderHook(
			({ maximized }) => useMaximizeTransition(maximized, onSettle),
			{ initialProps: { maximized: false } },
		);
		onSettle.mockClear(); // drop the harmless mount-time settle
		// Deliberately never call setNodeRef — simulates the target having
		// unmounted (or never mounted) by the time the toggle settles.

		act(() => rerender({ maximized: true }));

		expect(onSettle).toHaveBeenCalledTimes(1);
	});

	it("settles harmlessly without a visible transform on initial mount", () => {
		// Uses a real rendered component (not renderHook + a manual setNodeRef
		// call) so the ref attaches during React's normal commit order — same as
		// real usage, where <div ref={setNodeRef}> attaches before effects run.
		const onSettle = vi.fn();
		function Host() {
			const { setNodeRef } = useMaximizeTransition(false, onSettle);
			return <div ref={setNodeRef} />;
		}
		const { container } = render(<Host />);

		expect(onSettle).toHaveBeenCalledTimes(1);
		expect((container.firstChild as HTMLElement).style.transform).toBe("");
	});
});
