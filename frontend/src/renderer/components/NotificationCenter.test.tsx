import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { NotificationDTO } from "../lib/notifications";
import { NotificationCenter } from "./NotificationCenter";

const { fetchNextPageMock, markAllMock, markReadMock, navigateMock, notificationQueryMock } = vi.hoisted(() => ({
	fetchNextPageMock: vi.fn(),
	markAllMock: vi.fn(),
	markReadMock: vi.fn(),
	navigateMock: vi.fn(),
	notificationQueryMock: vi.fn(),
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
		createdAt: "2026-07-21T12:00:00Z",
		target: { kind: "pr", sessionId: "sess-3", prUrl: "https://github.com/acme/app/pull/42" },
	},
];

vi.mock("@tanstack/react-router", () => ({ useNavigate: () => navigateMock }));

vi.mock("../hooks/useNotificationsQuery", () => ({
	useMarkAllNotificationsReadMutation: () => ({ isPending: false, mutateAsync: markAllMock }),
	useMarkNotificationReadMutation: () => ({ isPending: false, mutateAsync: markReadMock }),
	useNotificationsQuery: (status: "unread" | "all", enabled?: boolean) => notificationQueryMock(status, enabled),
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

async function clickOpen() {
	const trigger = screen.getByRole("button", { name: /unread notifications/ });
	await userEvent.click(trigger);
	await screen.findByText("Mark all read");
	return trigger;
}

function notificationQueryResult(
	status: "unread" | "all",
	overrides: Partial<{
		hasNextPage: boolean;
		isError: boolean;
		isFetchNextPageError: boolean;
		isFetchingNextPage: boolean;
		isLoading: boolean;
	}> = {},
) {
	const hasNextPage = overrides.hasNextPage ?? false;
	return {
		data: {
			pageParams: [""],
			pages: [
				{
					notifications: status === "unread" ? notifications.filter((item) => item.status === "unread") : notifications,
					nextCursor: hasNextPage ? "older" : undefined,
					unreadCount: 2,
				},
			],
		},
		fetchNextPage: fetchNextPageMock,
		hasNextPage,
		isError: false,
		isFetchNextPageError: false,
		isFetchingNextPage: false,
		isLoading: false,
		...overrides,
	};
}

beforeEach(() => {
	fetchNextPageMock.mockReset().mockResolvedValue(undefined);
	markAllMock.mockReset().mockResolvedValue(0);
	markReadMock.mockReset().mockResolvedValue(notifications[0]);
	navigateMock.mockReset();
	notificationQueryMock.mockReset().mockImplementation(notificationQueryResult);
	vi.spyOn(window, "open").mockImplementation(() => null);
});

describe("NotificationCenter", () => {
	it("opens once on click without a hover/focus remount and dismisses outside", async () => {
		renderNotificationCenter();
		const trigger = screen.getByRole("button", { name: /unread notifications/ });
		fireEvent.mouseEnter(trigger);
		fireEvent.focus(trigger);
		expect(screen.queryByText("Mark all read")).not.toBeInTheDocument();

		await clickOpen();

		expect(screen.getByRole("tab", { name: /Unread/ })).toHaveAttribute("aria-selected", "true");
		expect(screen.queryByText(/last 7 days/i)).not.toBeInTheDocument();
		fireEvent.pointerDown(document.body);
		await waitFor(() => expect(screen.queryByText("Mark all read")).not.toBeInTheDocument());
	});

	it("supports tab navigation inside the panel and restores focus to the bell", async () => {
		renderNotificationCenter();
		const trigger = screen.getByRole("button", { name: /unread notifications/ });
		trigger.focus();
		await userEvent.keyboard("{Enter}");

		const panel = await screen.findByRole("dialog", { name: "Notifications" });
		expect(panel).toContainElement(document.activeElement as HTMLElement | null);
		await userEvent.keyboard("{Escape}");
		await waitFor(() => expect(trigger).toHaveFocus());
	});

	it("keeps read notifications in chronological order in All while Unread stays focused", async () => {
		renderNotificationCenter();
		await clickOpen();

		expect(screen.getByText("PR #67 is ready to merge")).toBeInTheDocument();
		expect(screen.queryByText("PR #42 was closed without merging")).not.toBeInTheDocument();

		await userEvent.click(screen.getByRole("tab", { name: "All" }));
		expect(screen.getByText("PR #42 was closed without merging")).toBeInTheDocument();
		const rows = within(screen.getByRole("dialog", { name: "Notifications" })).getAllByRole("listitem");
		expect(rows[0]).toHaveTextContent("PR #42 was closed without merging");
		expect(rows[1]).toHaveTextContent("PR #67 is ready to merge");
	});

	it("opens a PR from its title and the related AO session from the row action", async () => {
		renderNotificationCenter();
		await clickOpen();

		const titleLink = screen.getByRole("link", { name: "PR #67 is ready to merge" });
		expect(titleLink).toHaveAttribute("href", "https://github.com/acme/app/pull/67");
		await userEvent.click(titleLink);
		expect(window.open).toHaveBeenCalledWith("https://github.com/acme/app/pull/67", "_blank", "noopener,noreferrer");

		await clickOpen();
		await userEvent.click(screen.getByRole("button", { name: "Open related session" }));
		expect(navigateMock).toHaveBeenCalledWith({
			to: "/projects/$projectId/sessions/$sessionId",
			params: { projectId: "proj-1", sessionId: "sess-2" },
		});
	});

	it("marks one or every unread notification without removing history itself", async () => {
		renderNotificationCenter();
		await clickOpen();

		await userEvent.click(screen.getAllByRole("button", { name: "Mark notification read" })[0]);
		expect(markReadMock).toHaveBeenCalledWith("ntf_2");

		await userEvent.click(screen.getByRole("button", { name: "Mark all notifications read" }));
		expect(markAllMock).toHaveBeenCalledTimes(1);
	});

	it("loads earlier history near the end of the scroll viewport", async () => {
		notificationQueryMock.mockImplementation((status: "unread" | "all") =>
			notificationQueryResult(status, { hasNextPage: true }),
		);
		renderNotificationCenter();
		await clickOpen();

		const list = screen.getByRole("list");
		Object.defineProperties(list, {
			clientHeight: { configurable: true, value: 420 },
			scrollHeight: { configurable: true, value: 600 },
			scrollTop: { configurable: true, value: 130 },
		});
		fireEvent.scroll(list);

		expect(fetchNextPageMock).toHaveBeenCalledTimes(1);
	});

	it("offers a retry when loading earlier notifications fails", async () => {
		notificationQueryMock.mockImplementation((status: "unread" | "all") =>
			notificationQueryResult(status, {
				hasNextPage: true,
				isError: true,
				isFetchNextPageError: true,
			}),
		);
		renderNotificationCenter();
		await clickOpen();

		expect(screen.getByText("Couldn’t load earlier notifications.")).toBeInTheDocument();
		await userEvent.click(screen.getByRole("button", { name: "Retry" }));
		expect(fetchNextPageMock).toHaveBeenCalledTimes(1);
	});

	it("shows the full notification body instead of clamping it", async () => {
		renderNotificationCenter();
		await clickOpen();

		expect(screen.getByText("The agent is waiting for your response.")).not.toHaveClass("line-clamp-2");
	});
});
