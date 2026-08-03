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

	// DESIGN.md's documented timing lives in tokens.css as --duration-emphasized;
	// the hook must actually read it rather than keep a second copy that can
	// drift from the design system.
	describe("duration", () => {
		afterEach(() => {
			document.documentElement.style.removeProperty("--duration-emphasized");
			document.documentElement.style.removeProperty("--duration-normal");
		});

		function playAndReadDuration(): number {
			flipGetStateMock.mockReturnValue({ id: "captured-state" });
			const { result } = renderHook(() => useFlipTransition());
			act(() => result.current.captureRect(node));
			act(() => result.current.playFlip(node));
			return flipFromMock.mock.calls[0][1].duration;
		}

		it("reads --duration-emphasized from the document root", () => {
			document.documentElement.style.setProperty("--duration-emphasized", "500ms");
			expect(playAndReadDuration()).toBeCloseTo(0.5);
		});

		it("accepts a seconds-based token value", () => {
			document.documentElement.style.setProperty("--duration-emphasized", "0.4s");
			expect(playAndReadDuration()).toBeCloseTo(0.4);
		});

		it("falls back to the documented default when the token is unreadable", () => {
			document.documentElement.style.setProperty("--duration-emphasized", "not-a-duration");
			expect(playAndReadDuration()).toBeCloseTo(0.32);
		});

		it("lets an explicit option override the token", () => {
			document.documentElement.style.setProperty("--duration-emphasized", "500ms");
			flipGetStateMock.mockReturnValue({ id: "captured-state" });
			const { result } = renderHook(() => useFlipTransition());
			act(() => result.current.captureRect(node));
			act(() => result.current.playFlip(node, { duration: 200 }));
			expect(flipFromMock.mock.calls[0][1].duration).toBeCloseTo(0.2);
		});

		it("reads the normal motion token when requested", () => {
			document.documentElement.style.setProperty("--duration-emphasized", "500ms");
			document.documentElement.style.setProperty("--duration-normal", "150ms");
			flipGetStateMock.mockReturnValue({ id: "captured-state" });
			const { result } = renderHook(() => useFlipTransition());
			act(() => result.current.captureRect(node));
			act(() => result.current.playFlip(node, { timing: "normal" }));

			expect(flipFromMock.mock.calls[0][1].duration).toBeCloseTo(0.15);
		});
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
