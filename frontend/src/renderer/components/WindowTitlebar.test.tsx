import { readFileSync } from "node:fs";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { navigateMock } = vi.hoisted(() => ({
	navigateMock: vi.fn(),
}));

vi.mock("@tanstack/react-router", () => ({
	useNavigate: () => navigateMock,
}));

describe("WindowTitlebar", () => {
	let actionMock: (action: string) => Promise<void>;

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
		actionMock = vi.fn(async (_action: string) => undefined);
		window.ao!.menu.action = actionMock;
		document.documentElement.removeAttribute("style");
	});

	it("renders custom Windows controls and dispatches window actions", async () => {
		const { WindowTitlebar } = await loadWindowTitlebar();

		render(<WindowTitlebar />);

		await userEvent.click(screen.getByRole("button", { name: "Minimize" }));
		await userEvent.click(screen.getByRole("button", { name: "Maximize / Restore" }));
		await userEvent.click(screen.getByRole("button", { name: "Close" }));

		expect(actionMock).toHaveBeenNthCalledWith(1, "window.minimize");
		expect(actionMock).toHaveBeenNthCalledWith(2, "window.maximize");
		expect(actionMock).toHaveBeenNthCalledWith(3, "window.close");
	});

	it("keeps maximized overlays below the custom Windows titlebar", () => {
		const css = readFileSync("src/renderer/styles.css", "utf8");

		expect(css).toMatch(
			/\.platform-windows \.browser-popout-overlay,\s*\.platform-windows \.files-popout-overlay\s*{\s*top: var\(--size-window-titlebar\);/s,
		);
	});
});
