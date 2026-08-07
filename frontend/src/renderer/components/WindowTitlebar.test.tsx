import { render, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

type Overlay = { color: string; symbolColor: string };

const { navigateMock } = vi.hoisted(() => ({
	navigateMock: vi.fn(),
}));

vi.mock("@tanstack/react-router", () => ({
	useNavigate: () => navigateMock,
}));

describe("WindowTitlebar", () => {
	let setOverlayMock: (overlay: Overlay) => Promise<void>;

	async function loadWindowTitlebar() {
		vi.resetModules();
		Object.defineProperty(navigator, "platform", {
			configurable: true,
			value: "Win32",
		});
		return import("./WindowTitlebar");
	}

	beforeEach(() => {
		navigateMock.mockReset();
		setOverlayMock = vi.fn(async (_overlay: Overlay) => undefined);
		window.ao!.window.setOverlay = setOverlayMock;
		document.documentElement.removeAttribute("style");
	});

	it("tints the native Windows controls from the active CSS theme tokens", async () => {
		document.documentElement.style.setProperty("--color-bg-sidebar", "rgb(12, 34, 56)");
		document.documentElement.style.setProperty("--fg-muted", "rgb(201, 202, 203)");
		const { WindowTitlebar } = await loadWindowTitlebar();

		render(<WindowTitlebar />);

		await waitFor(() => {
			expect(setOverlayMock).toHaveBeenCalledWith({
				color: "rgb(12, 34, 56)",
				symbolColor: "rgb(201, 202, 203)",
			});
		});
	});
});
