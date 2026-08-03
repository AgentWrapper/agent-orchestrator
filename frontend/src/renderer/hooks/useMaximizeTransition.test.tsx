import { act, render, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { captureRectMock, playFlipMock } = vi.hoisted(() => ({
	captureRectMock: vi.fn(),
	playFlipMock: vi.fn(),
}));

vi.mock("./useFlipTransition", () => ({
	useFlipTransition: () => ({ captureRect: captureRectMock, playFlip: playFlipMock }),
}));

import { useMaximizeTransition } from "./useMaximizeTransition";

describe("useMaximizeTransition", () => {
	let node: HTMLDivElement;

	beforeEach(() => {
		node = document.createElement("div");
		document.body.appendChild(node);
		captureRectMock.mockReset();
		playFlipMock.mockReset();
	});

	afterEach(() => {
		node.remove();
	});

	it("captureOrigin captures the currently attached node's rect via the FLIP hook", () => {
		const { result } = renderHook(() => useMaximizeTransition(false));
		act(() => result.current.setNodeRef(node));

		act(() => result.current.captureOrigin());

		expect(captureRectMock).toHaveBeenCalledWith(node);
	});

	it("captureOrigin no-ops when no node is attached", () => {
		const { result } = renderHook(() => useMaximizeTransition(false));

		act(() => result.current.captureOrigin());

		expect(captureRectMock).not.toHaveBeenCalled();
	});

	it("plays a FLIP transition on the attached node when `maximized` changes, forwarding onSettle", () => {
		const onSettle = vi.fn();
		const { result, rerender } = renderHook(
			({ maximized }) => useMaximizeTransition(maximized, onSettle),
			{ initialProps: { maximized: false } },
		);
		act(() => result.current.setNodeRef(node));
		playFlipMock.mockClear(); // drop the harmless mount-time call

		act(() => rerender({ maximized: true }));

		expect(playFlipMock).toHaveBeenCalledWith(node, { onSettle });
	});

	it("uses the shorter normal motion timing when restoring to the inspector", () => {
		const onSettle = vi.fn();
		const { result, rerender } = renderHook(
			({ maximized }) => useMaximizeTransition(maximized, onSettle),
			{ initialProps: { maximized: true } },
		);
		act(() => result.current.setNodeRef(node));
		playFlipMock.mockClear();

		act(() => rerender({ maximized: false }));

		expect(playFlipMock).toHaveBeenCalledWith(node, { onSettle, timing: "normal" });
	});

	it("still calls playFlip (with a null node) when maximized changes but nothing is attached, so onSettle isn't stranded", () => {
		// Regression: a popout transition begun just before a session switch
		// (which unmounts the panel node) must still settle — playFlip itself
		// handles a null node by calling onSettle immediately.
		const onSettle = vi.fn();
		const { rerender } = renderHook(
			({ maximized }) => useMaximizeTransition(maximized, onSettle),
			{ initialProps: { maximized: false } },
		);
		playFlipMock.mockClear();

		act(() => rerender({ maximized: true }));

		expect(playFlipMock).toHaveBeenCalledWith(null, { onSettle });
	});

	it("does not play a transition (real DOM ref timing) beyond the harmless initial-mount call", () => {
		// Uses a real rendered component so the ref attaches during React's
		// normal commit order, same as real usage.
		const onSettle = vi.fn();
		function Host() {
			const { setNodeRef } = useMaximizeTransition(false, onSettle);
			return <div ref={setNodeRef} />;
		}
		playFlipMock.mockClear();
		const { container } = render(<Host />);

		expect(playFlipMock).toHaveBeenCalledTimes(1);
		expect(playFlipMock).toHaveBeenCalledWith(container.firstChild, { onSettle, timing: "normal" });
	});
});
