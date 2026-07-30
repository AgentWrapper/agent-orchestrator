import { act, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useUiStore } from "../stores/ui-store";
import { TitlebarNav } from "./TitlebarNav";

const { canGoBack, historyMock, historySubscriber } = vi.hoisted(() => ({
	canGoBack: { current: true },
	historyMock: {
		back: vi.fn(),
		forward: vi.fn(),
		location: { state: { __TSR_index: 2 } },
		subscribe: vi.fn(),
	},
	historySubscriber: {
		current: undefined as
			| ((event: { location: { state: { __TSR_index: number } }; action: { type: string } }) => void)
			| undefined,
	},
}));

vi.mock("@tanstack/react-router", () => ({
	useCanGoBack: () => canGoBack.current,
	useRouter: () => ({ history: historyMock }),
}));

vi.mock("../lib/platform", () => ({
	isLinuxPlatform: () => false,
	isMacPlatform: () => true,
}));

beforeEach(() => {
	canGoBack.current = true;
	historyMock.back.mockReset();
	historyMock.forward.mockReset();
	historyMock.location.state.__TSR_index = 2;
	historySubscriber.current = undefined;
	historyMock.subscribe.mockReset().mockImplementation((subscriber) => {
		historySubscriber.current = subscriber;
		return () => undefined;
	});
	useUiStore.setState({ isSidebarOpen: true });
});

describe("TitlebarNav", () => {
	it("toggles the shared sidebar state and forwards the preview gesture", async () => {
		const onSidebarPreviewEnter = vi.fn();
		render(<TitlebarNav onSidebarPreviewEnter={onSidebarPreviewEnter} />);

		const toggle = screen.getByRole("button", { name: "Collapse sidebar" });
		fireEvent.pointerEnter(toggle);
		expect(onSidebarPreviewEnter).toHaveBeenCalledTimes(1);

		await userEvent.click(toggle);

		expect(useUiStore.getState().isSidebarOpen).toBe(false);
		expect(screen.getByRole("button", { name: "Expand sidebar" })).toBeInTheDocument();
	});

	it("routes back and forward through the router history stack", async () => {
		render(<TitlebarNav />);

		const back = screen.getByRole("button", { name: "Go back" });
		const forward = screen.getByRole("button", { name: "Go forward" });
		expect(back).toBeEnabled();
		expect(forward).toBeDisabled();

		await userEvent.click(back);
		expect(historyMock.back).toHaveBeenCalledTimes(1);

		act(() => {
			historySubscriber.current?.({
				location: { state: { __TSR_index: 1 } },
				action: { type: "BACK" },
			});
		});

		expect(forward).toBeEnabled();
		await userEvent.click(forward);
		expect(historyMock.forward).toHaveBeenCalledTimes(1);
	});

	it("locks both history buttons while a route transition owns navigation", () => {
		render(<TitlebarNav historyLocked />);

		expect(screen.getByRole("button", { name: "Go back" })).toBeDisabled();
		expect(screen.getByRole("button", { name: "Go forward" })).toBeDisabled();
	});

	it("uses the fullscreen macOS cluster position without changing its controls", () => {
		const { container } = render(<TitlebarNav isFullScreen />);

		expect(container.firstElementChild).toHaveClass("left-titlebar-cluster-left-fullscreen", "top-0");
		expect(screen.getByRole("button", { name: "Collapse sidebar" })).toBeInTheDocument();
	});

	it("aligns windowed macOS controls on the traffic-light centerline", () => {
		const { container } = render(<TitlebarNav />);

		expect(container.firstElementChild).toHaveClass("left-titlebar-cluster-left", "top-0", "h-traffic-light-clearance");
	});
});
