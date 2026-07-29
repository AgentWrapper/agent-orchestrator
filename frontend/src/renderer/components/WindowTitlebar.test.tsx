import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { useUiStore } from "../stores/ui-store";

const { navigateMock } = vi.hoisted(() => ({ navigateMock: vi.fn() }));

vi.mock("@tanstack/react-router", () => ({
	useNavigate: () => navigateMock,
}));

const originalPlatform = Object.getOwnPropertyDescriptor(window.navigator, "platform");
const originalUserAgentData = Object.getOwnPropertyDescriptor(window.navigator, "userAgentData");

function restoreProperty(name: "platform" | "userAgentData", descriptor: PropertyDescriptor | undefined) {
	if (descriptor) {
		Object.defineProperty(window.navigator, name, descriptor);
		return;
	}
	delete (window.navigator as unknown as Record<string, unknown>)[name];
}

let WindowTitlebar: typeof import("./WindowTitlebar").WindowTitlebar;

beforeAll(async () => {
	Object.defineProperty(window.navigator, "platform", {
		configurable: true,
		get: () => "Win32",
	});
	Object.defineProperty(window.navigator, "userAgentData", {
		configurable: true,
		get: () => ({ platform: "Windows" }),
	});
	WindowTitlebar = (await import("./WindowTitlebar")).WindowTitlebar;
});

afterAll(() => {
	restoreProperty("platform", originalPlatform);
	restoreProperty("userAgentData", originalUserAgentData);
});

beforeEach(() => {
	navigateMock.mockReset();
	window.ao!.window.setOverlay = vi.fn().mockResolvedValue(undefined);
	window.ao!.menu.action = vi.fn().mockResolvedValue(undefined);
	window.ao!.menu.notifyShellFocus = vi.fn();
	useUiStore.setState({
		isSidebarOpen: true,
		resolvedTheme: "dark",
		themePreference: "dark",
	});
});

describe("WindowTitlebar", () => {
	it("exposes application chrome without creating a second banner landmark", () => {
		render(<WindowTitlebar />);

		expect(screen.queryByRole("banner")).not.toBeInTheDocument();
		expect(screen.getByRole("navigation", { name: "Application menu" })).toBeInTheDocument();
	});

	it("toggles the shared sidebar state and forwards the preview gesture", async () => {
		const onSidebarPreviewEnter = vi.fn();
		render(<WindowTitlebar onSidebarPreviewEnter={onSidebarPreviewEnter} />);

		const toggle = screen.getByRole("button", { name: "Collapse sidebar" });
		fireEvent.pointerEnter(toggle);
		expect(onSidebarPreviewEnter).toHaveBeenCalledTimes(1);

		await userEvent.click(toggle);

		expect(useUiStore.getState().isSidebarOpen).toBe(false);
		expect(screen.getByRole("button", { name: "Expand sidebar" })).toBeInTheDocument();
	});

	it("keeps the native window-control overlay synchronized with theme changes", async () => {
		render(<WindowTitlebar />);

		await waitFor(() =>
			expect(window.ao!.window.setOverlay).toHaveBeenCalledWith({
				color: "#17181c",
				symbolColor: "#c7ccd4",
			}),
		);

		act(() => useUiStore.setState({ resolvedTheme: "light" }));

		await waitFor(() =>
			expect(window.ao!.window.setOverlay).toHaveBeenLastCalledWith({
				color: "#fcfcfc",
				symbolColor: "#3f444c",
			}),
		);
	});

	it("navigates to renderer-owned settings from the File menu", async () => {
		const user = userEvent.setup();
		render(<WindowTitlebar />);

		await user.click(screen.getByRole("button", { name: "File" }));
		await user.click(await screen.findByRole("menuitem", { name: "Settings" }));

		expect(navigateMock).toHaveBeenCalledWith({ to: "/settings" });
	});

	it("dispatches native menu actions to the main-process bridge", async () => {
		const user = userEvent.setup();
		render(<WindowTitlebar />);

		await user.click(screen.getByRole("button", { name: "View" }));
		await user.click(await screen.findByRole("menuitem", { name: /Toggle DevTools/ }));

		expect(window.ao!.menu.action).toHaveBeenCalledWith("view.devtools");
	});

	it("notifies the main process only when focus moves outside the custom titlebar", () => {
		render(
			<>
				<WindowTitlebar />
				<button type="button">Workspace control</button>
			</>,
		);

		fireEvent.focusIn(screen.getByRole("button", { name: "File" }));
		expect(window.ao!.menu.notifyShellFocus).not.toHaveBeenCalled();

		fireEvent.focusIn(screen.getByRole("button", { name: "Workspace control" }));
		expect(window.ao!.menu.notifyShellFocus).toHaveBeenCalledTimes(1);
	});
});
