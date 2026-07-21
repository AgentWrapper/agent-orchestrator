import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { NotificationDTO } from "../lib/notifications";
import { NotificationCenter } from "./NotificationCenter";

const { markAllMock, markReadMock, navigateMock } = vi.hoisted(() => ({
	markAllMock: vi.fn(),
	markReadMock: vi.fn(),
	navigateMock: vi.fn(),
}));

const notifications: NotificationDTO[] = [
	{
		id: "ntf_1",
		sessionId: "sess-1",
		projectId: "proj-1",
		prUrl: "",
		type: "needs_input",
		title: "Checkout flow needs input",
		body: "The agent is waiting for your response.",
		status: "unread",
		createdAt: "2026-07-21T10:00:00Z",
		target: { kind: "session", sessionId: "sess-1" },
	},
	{
		id: "ntf_2",
		sessionId: "sess-2",
		projectId: "proj-1",
		prUrl: "https://github.com/acme/app/pull/67",
		type: "ready_to_merge",
		title: "PR #67 is ready to merge",
		body: "Checkout flow has no known blocking CI or review feedback.",
		status: "unread",
		createdAt: "2026-07-21T11:00:00Z",
		target: { kind: "pr", sessionId: "sess-2", prUrl: "https://github.com/acme/app/pull/67" },
	},
	{
		id: "ntf_3",
		sessionId: "sess-3",
		projectId: "proj-1",
		prUrl: "https://github.com/acme/app/pull/42",
		type: "pr_closed_unmerged",
		title: "PR #42 was closed without merging",
		body: "Visual smoke target was closed without merging.",
		status: "read",
		createdAt: "2026-07-20T11:00:00Z",
		target: { kind: "pr", sessionId: "sess-3", prUrl: "https://github.com/acme/app/pull/42" },
	},
];

vi.mock("@tanstack/react-router", () => ({ useNavigate: () => navigateMock }));

vi.mock("../hooks/useNotificationsQuery", () => ({
	useMarkAllNotificationsReadMutation: () => ({ isPending: false, mutateAsync: markAllMock }),
	useMarkNotificationReadMutation: () => ({ isPending: false, mutateAsync: markReadMock }),
	useNotificationsQuery: () => ({ data: notifications, isError: false, isLoading: false }),
}));

vi.mock("../lib/notifications", async (importOriginal) => ({
	...((await importOriginal()) as object),
	createNotificationsTransport: () => ({ connect: () => undefined }),
}));

function renderNotificationCenter() {
	const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
	return render(
		<QueryClientProvider client={queryClient}>
			<NotificationCenter />
		</QueryClientProvider>,
	);
}

async function hoverOpen() {
	const trigger = screen.getByRole("button", { name: "2 unread notifications" });
	fireEvent.mouseEnter(trigger);
	await screen.findByText("Activity from the last 7 days");
	return trigger;
}

beforeEach(() => {
	markAllMock.mockReset().mockResolvedValue([]);
	markReadMock.mockReset().mockResolvedValue(notifications[0]);
	navigateMock.mockReset();
	vi.spyOn(window, "open").mockImplementation(() => null);
});

describe("NotificationCenter", () => {
	it("opens on hover and dismisses after an outside click", async () => {
		renderNotificationCenter();
		await hoverOpen();

		expect(screen.getByRole("tab", { name: /Unread/ })).toHaveAttribute("aria-selected", "true");
		fireEvent.pointerDown(document.body);
		await waitFor(() => expect(screen.queryByText("Activity from the last 7 days")).not.toBeInTheDocument());
	});

	it("keeps read notifications in All while Unread stays focused", async () => {
		renderNotificationCenter();
		await hoverOpen();

		expect(screen.getByText("PR #67 is ready to merge")).toBeInTheDocument();
		expect(screen.queryByText("PR #42 was closed without merging")).not.toBeInTheDocument();

		await userEvent.click(screen.getByRole("tab", { name: "All" }));
		expect(screen.getByText("PR #42 was closed without merging")).toBeInTheDocument();
		expect(screen.getByText("Read")).toBeInTheDocument();
	});

	it("opens a PR from its title and the related AO session from the row action", async () => {
		renderNotificationCenter();
		await hoverOpen();

		await userEvent.click(screen.getByRole("button", { name: "PR #67 is ready to merge" }));
		expect(window.open).toHaveBeenCalledWith("https://github.com/acme/app/pull/67", "_blank", "noopener,noreferrer");

		await hoverOpen();
		await userEvent.click(screen.getByRole("button", { name: "Open related session" }));
		expect(navigateMock).toHaveBeenCalledWith({
			to: "/projects/$projectId/sessions/$sessionId",
			params: { projectId: "proj-1", sessionId: "sess-2" },
		});
	});

	it("marks one or every unread notification without removing history itself", async () => {
		renderNotificationCenter();
		await hoverOpen();

		await userEvent.click(screen.getAllByRole("button", { name: "Mark notification read" })[0]);
		expect(markReadMock).toHaveBeenCalledWith("ntf_1");

		await userEvent.click(screen.getByRole("button", { name: "Mark all notifications read" }));
		expect(markAllMock).toHaveBeenCalledTimes(1);
	});
});
