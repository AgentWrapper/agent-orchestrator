import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { BrowserPanel } from "./BrowserPanel";
import type { BrowserNavState } from "../hooks/useBrowserView";
import type { WorkspaceSession } from "../types/workspace";

const hookState = vi.hoisted(() => ({
	navigate: vi.fn(),
	goBack: vi.fn(),
	goForward: vi.fn(),
	reload: vi.fn(),
	stop: vi.fn(),
	previewUrl: undefined as string | undefined,
	navState: {
		viewId: "42:sess-1",
		url: "",
		title: "",
		canGoBack: false,
		canGoForward: false,
		isLoading: false,
	} as BrowserNavState,
}));

vi.mock("../hooks/useBrowserView", () => ({
	useBrowserView: (options: { previewUrl?: string }) => {
		hookState.previewUrl = options.previewUrl;
		return {
			viewId: "42:sess-1",
			navState: hookState.navState,
			slotRef: vi.fn(),
			navigate: hookState.navigate,
			goBack: hookState.goBack,
			goForward: hookState.goForward,
			reload: hookState.reload,
			stop: hookState.stop,
		};
	},
}));

const session: WorkspaceSession = {
	id: "sess-1",
	workspaceId: "ws-1",
	workspaceName: "my-app",
	title: "do the thing",
	provider: "claude-code",
	kind: "worker",
	branch: "feat/ns",
	status: "working",
	updatedAt: "2026-06-15T00:00:00Z",
	prs: [],
};

describe("BrowserPanel", () => {
	beforeEach(() => {
		hookState.navigate.mockReset();
		hookState.goBack.mockReset();
		hookState.goForward.mockReset();
		hookState.reload.mockReset();
		hookState.stop.mockReset();
		hookState.previewUrl = undefined;
		hookState.navState = {
			viewId: "42:sess-1",
			url: "",
			title: "",
			canGoBack: false,
			canGoForward: false,
			isLoading: false,
		};
	});

	it("navigates to the entered URL on submit", async () => {
		render(<BrowserPanel active onTogglePopOut={() => undefined} poppedOut={false} session={session} />);
		const input = screen.getByRole("textbox", { name: /browser url/i });

		await userEvent.clear(input);
		await userEvent.type(input, "localhost:5173{Enter}");

		expect(hookState.navigate).toHaveBeenCalledWith("localhost:5173");
	});

	it("threads the session preview URL into the browser view (which drives navigation)", () => {
		render(
			<BrowserPanel
				active
				onTogglePopOut={() => undefined}
				poppedOut={false}
				session={{
					...session,
					previewUrl: "http://127.0.0.1:3001/api/v1/sessions/sess-1/preview/files/index.html",
				}}
			/>,
		);

		expect(hookState.previewUrl).toBe(
			"http://127.0.0.1:3001/api/v1/sessions/sess-1/preview/files/index.html",
		);
	});

	it("binds navigation controls to nav state", async () => {
		hookState.navState = {
			viewId: "42:sess-1",
			url: "http://localhost:5173/",
			title: "Local app",
			canGoBack: true,
			canGoForward: false,
			isLoading: true,
		};
		render(<BrowserPanel active onTogglePopOut={() => undefined} poppedOut={false} session={session} />);

		await userEvent.click(screen.getByRole("button", { name: /back/i }));
		await userEvent.click(screen.getByRole("button", { name: /stop/i }));

		expect(hookState.goBack).toHaveBeenCalled();
		expect(screen.getByRole("button", { name: /forward/i })).toBeDisabled();
		expect(hookState.stop).toHaveBeenCalled();
	});

	it("shows empty and error states", () => {
		hookState.navState = { ...hookState.navState, error: "Connection refused" };
		render(<BrowserPanel active onTogglePopOut={() => undefined} poppedOut={false} session={session} />);

		expect(screen.getByText("Enter a dev-server URL to preview it here.")).toBeInTheDocument();
		expect(screen.getByText("Connection refused")).toBeInTheDocument();
	});

	it("toggles pop-out mode", async () => {
		const onTogglePopOut = vi.fn();
		render(<BrowserPanel active onTogglePopOut={onTogglePopOut} poppedOut={false} session={session} />);

		await userEvent.click(screen.getByRole("button", { name: /pop out/i }));

		expect(onTogglePopOut).toHaveBeenCalledWith(true);
	});
});
