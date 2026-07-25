import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const isFullScreenMock = vi.fn();
const onFullScreenMock = vi.fn();
const isMacPlatformMock = vi.fn(() => true);

vi.mock("../lib/bridge", () => ({
	aoBridge: {
		window: {
			isFullScreen: () => isFullScreenMock(),
			onFullScreen: (listener: (value: boolean) => void) => onFullScreenMock(listener),
		},
	},
}));

vi.mock("../lib/platform", () => ({
	isMacPlatform: () => isMacPlatformMock(),
}));

import { useWindowFullScreen } from "./useWindowFullScreen";

beforeEach(() => {
	isMacPlatformMock.mockReturnValue(true);
	isFullScreenMock.mockReset().mockResolvedValue(false);
	onFullScreenMock.mockReset().mockReturnValue(() => undefined);
});

describe("useWindowFullScreen", () => {
	it("no-ops off macOS", () => {
		isMacPlatformMock.mockReturnValue(false);
		const { result } = renderHook(() => useWindowFullScreen());
		expect(result.current).toBe(false);
		expect(isFullScreenMock).not.toHaveBeenCalled();
		expect(onFullScreenMock).not.toHaveBeenCalled();
	});

	it("seeds from isFullScreen and follows push events", async () => {
		isFullScreenMock.mockResolvedValue(true);
		let push: ((value: boolean) => void) | undefined;
		onFullScreenMock.mockImplementation((listener: (value: boolean) => void) => {
			push = listener;
			return () => undefined;
		});

		const { result } = renderHook(() => useWindowFullScreen());
		await waitFor(() => expect(result.current).toBe(true));

		act(() => push?.(false));
		expect(result.current).toBe(false);
	});

	it("ignores a stale seed that resolves after a push event", async () => {
		let resolveSeed!: (value: boolean) => void;
		isFullScreenMock.mockReturnValue(
			new Promise<boolean>((resolve) => {
				resolveSeed = resolve;
			}),
		);
		let push: ((value: boolean) => void) | undefined;
		onFullScreenMock.mockImplementation((listener: (value: boolean) => void) => {
			push = listener;
			return () => undefined;
		});

		const { result } = renderHook(() => useWindowFullScreen());
		expect(result.current).toBe(false);

		act(() => push?.(true));
		expect(result.current).toBe(true);

		await act(async () => {
			resolveSeed(false);
			await Promise.resolve();
		});
		expect(result.current).toBe(true);
	});
});
