import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { registerPluginMock, gsapSetMock, flipGetStateMock, flipFromMock } = vi.hoisted(() => ({
	registerPluginMock: vi.fn(),
	gsapSetMock: vi.fn(),
	flipGetStateMock: vi.fn(),
	flipFromMock: vi.fn(),
}));

vi.mock("gsap", () => ({
	gsap: { registerPlugin: registerPluginMock, set: gsapSetMock },
	default: { registerPlugin: registerPluginMock, set: gsapSetMock },
}));

vi.mock("gsap/Flip", () => ({
	Flip: {
		getState: (...args: unknown[]) => flipGetStateMock(...args),
		from: (...args: unknown[]) => flipFromMock(...args),
	},
}));

import { useFlipTransition } from "./useFlipTransition";

function fakeTimeline() {
	return { kill: vi.fn() };
}

describe("useFlipTransition", () => {
	let node: HTMLDivElement;

	beforeEach(() => {
		node = document.createElement("div");
		document.body.appendChild(node);
		gsapSetMock.mockReset();
		flipGetStateMock.mockReset();
		flipFromMock.mockReset().mockImplementation(() => fakeTimeline());
	});

	afterEach(() => {
		vi.restoreAllMocks();
		node.remove();
	});

	it("registers the Flip plugin with gsap", () => {
		expect(registerPluginMock).toHaveBeenCalled();
	});

	it("captureRect captures Flip state for the given node", () => {
		const fakeState = { id: "captured-state" };
		flipGetStateMock.mockReturnValue(fakeState);

		const { result } = renderHook(() => useFlipTransition());
		act(() => result.current.captureRect(node));

		expect(flipGetStateMock).toHaveBeenCalledWith(node);
	});

	it("plays a real-layout Flip (scale: false) from the captured state onto the target node", () => {
		const fakeState = { id: "captured-state" };
		flipGetStateMock.mockReturnValue(fakeState);
		const onSettle = vi.fn();

		const { result } = renderHook(() => useFlipTransition());
		act(() => result.current.captureRect(node));
		act(() => result.current.playFlip(node, { onSettle, duration: 400 }));

		expect(flipFromMock).toHaveBeenCalledTimes(1);
		const [state, vars] = flipFromMock.mock.calls[0];
		expect(state).toBe(fakeState);
		expect(vars).toMatchObject({ targets: node, scale: false, absolute: true, duration: 0.4 });

		expect(onSettle).not.toHaveBeenCalled();
		act(() => vars.onComplete());
		expect(onSettle).toHaveBeenCalledTimes(1);
		// Leftover inline width/height/position from the tween must not survive
		// past settle — otherwise a later window resize would fight stale
		// GSAP-applied styles instead of the panel's normal CSS-driven layout.
		expect(gsapSetMock).toHaveBeenCalledWith(node, { clearProps: "all" });
	});

	it("settles immediately without animating when no rect was captured first", () => {
		const onSettle = vi.fn();
		const { result } = renderHook(() => useFlipTransition());

		act(() => result.current.playFlip(node, { onSettle }));

		expect(flipFromMock).not.toHaveBeenCalled();
		expect(onSettle).toHaveBeenCalledTimes(1);
	});

	it("settles immediately when there is no target node", () => {
		flipGetStateMock.mockReturnValue({ id: "captured-state" });
		const onSettle = vi.fn();
		const { result } = renderHook(() => useFlipTransition());

		act(() => result.current.captureRect(node));
		act(() => result.current.playFlip(null, { onSettle }));

		expect(flipFromMock).not.toHaveBeenCalled();
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
		flipGetStateMock.mockReturnValue({ id: "captured-state" });
		const onSettle = vi.fn();

		const { result } = renderHook(() => useFlipTransition());
		act(() => result.current.captureRect(node));
		act(() => result.current.playFlip(node, { onSettle }));

		expect(flipFromMock).not.toHaveBeenCalled();
		expect(onSettle).toHaveBeenCalledTimes(1);
	});

	// The marker is the contract the Browser panel's CSS hangs off: while it is
	// present the toolbar is hidden and the viewport fills the panel, so the
	// real-layout tween only reveals/clips a static snapshot instead of
	// re-laying-out the toolbar every frame. Leaking it past the tween would
	// leave the panel permanently chrome-less.
	it("marks the target as flipping only for the duration of the tween", () => {
		flipGetStateMock.mockReturnValue({ id: "captured-state" });

		const { result } = renderHook(() => useFlipTransition());
		act(() => result.current.captureRect(node));
		act(() => result.current.playFlip(node));

		expect(node.dataset.flipping).toBe("");

		const [, vars] = flipFromMock.mock.calls[0];
		act(() => vars.onComplete());

		expect(node.dataset.flipping).toBeUndefined();
	});

	it("clears the flipping marker when a tween is interrupted, since kill() never fires onComplete", () => {
		flipGetStateMock.mockReturnValue({ id: "captured-state" });
		const firstNode = node;
		const secondNode = document.createElement("div");
		document.body.appendChild(secondNode);

		const { result } = renderHook(() => useFlipTransition());
		act(() => result.current.captureRect(firstNode));
		act(() => result.current.playFlip(firstNode));
		expect(firstNode.dataset.flipping).toBe("");

		// Toggling again mid-tween re-targets the flip at the node that just
		// mounted; the abandoned one must not stay marked.
		act(() => result.current.captureRect(secondNode));
		act(() => result.current.playFlip(secondNode));

		expect(firstNode.dataset.flipping).toBeUndefined();
		expect(secondNode.dataset.flipping).toBe("");
		secondNode.remove();
	});

	it("clears the flipping marker if the hook unmounts mid-tween", () => {
		flipGetStateMock.mockReturnValue({ id: "captured-state" });

		const { result, unmount } = renderHook(() => useFlipTransition());
		act(() => result.current.captureRect(node));
		act(() => result.current.playFlip(node));
		expect(node.dataset.flipping).toBe("");

		unmount();

		expect(node.dataset.flipping).toBeUndefined();
	});

	it("does not mark the target when the animation is skipped under prefers-reduced-motion", () => {
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
		flipGetStateMock.mockReturnValue({ id: "captured-state" });

		const { result } = renderHook(() => useFlipTransition());
		act(() => result.current.captureRect(node));
		act(() => result.current.playFlip(node));

		// No tween runs, so the panel must keep its toolbar rather than sit out
		// an animation that never happens.
		expect(node.dataset.flipping).toBeUndefined();
	});

	it("kills an in-flight Flip timeline when playFlip runs again, without firing the stale onSettle", () => {
		flipGetStateMock.mockReturnValue({ id: "captured-state" });
		const firstTimeline = fakeTimeline();
		const secondTimeline = fakeTimeline();
		flipFromMock.mockReturnValueOnce(firstTimeline).mockReturnValueOnce(secondTimeline);
		const firstSettle = vi.fn();
		const secondSettle = vi.fn();

		const { result } = renderHook(() => useFlipTransition());
		act(() => result.current.captureRect(node));
		act(() => result.current.playFlip(node, { onSettle: firstSettle }));

		act(() => result.current.captureRect(node));
		act(() => result.current.playFlip(node, { onSettle: secondSettle }));

		expect(firstTimeline.kill).toHaveBeenCalledTimes(1);
		expect(firstSettle).not.toHaveBeenCalled();
	});
});
