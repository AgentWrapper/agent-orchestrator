import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useUiStore } from "../stores/ui-store";
import { TitlebarNav } from "./TitlebarNav";

const { history } = vi.hoisted(() => ({
	history: {
		back: vi.fn(),
		forward: vi.fn(),
		location: { state: { __TSR_index: 0 } },
		subscribe: vi.fn(() => () => undefined),
	},
}));

vi.mock("@tanstack/react-router", () => ({
	useCanGoBack: () => false,
	useRouter: () => ({ history }),
}));

vi.mock("../lib/platform", () => ({
	isLinuxPlatform: () => false,
	isMacPlatform: () => true,
}));

describe("TitlebarNav", () => {
	beforeEach(() => {
		useUiStore.setState({ isSidebarOpen: true });
	});

	it("uses the compact sidebar-aligned chrome row in native fullscreen", () => {
		const { container } = render(<TitlebarNav isFullScreen />);

		const nav = container.querySelector('[data-slot="titlebar-nav"]');
		expect(nav).toHaveClass("left-titlebar-cluster-left-fullscreen", "h-traffic-light-clearance-fullscreen", "top-0");
		expect(nav).not.toHaveClass("h-traffic-light-clearance");
		expect(screen.getByRole("button", { name: "Go back" })).toHaveClass("disabled:opacity-55");
	});

	it("retains the traffic-light geometry in a windowed macOS shell", () => {
		const { container } = render(<TitlebarNav />);

		const nav = container.querySelector('[data-slot="titlebar-nav"]');
		expect(nav).toHaveClass("left-titlebar-cluster-left", "h-traffic-light-clearance", "-top-1.25");
	});

	it("lowers the windowed cluster into the panel header when the sidebar is collapsed", () => {
		useUiStore.setState({ isSidebarOpen: false });
		const { container } = render(<TitlebarNav />);

		const nav = container.querySelector('[data-slot="titlebar-nav"]');
		expect(nav).toHaveClass("left-titlebar-cluster-left", "h-traffic-light-clearance", "top-1");
		expect(nav).not.toHaveClass("-top-1.25");
	});

	it("does not apply the collapsed window offset in native fullscreen", () => {
		useUiStore.setState({ isSidebarOpen: false });
		const { container } = render(<TitlebarNav isFullScreen />);

		const nav = container.querySelector('[data-slot="titlebar-nav"]');
		expect(nav).toHaveClass("top-0", "h-traffic-light-clearance-fullscreen");
		expect(nav).not.toHaveClass("top-1");
	});
});
