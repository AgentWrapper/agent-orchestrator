import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { NotificationDTO, NotificationListStatus } from "../lib/notifications";
import { useUiStore } from "../stores/ui-store";
import { NotificationCenter, NotificationRuntime } from "./NotificationCenter";

const { connectMock, fetchNextPageMock, markAllMock, navigateMock, notificationQueryMock, paramsMock } = vi.hoisted(
	() => ({
		connectMock: vi.fn(),
		fetchNextPageMock: vi.fn(),
		markAllMock: vi.fn(),
		navigateMock: vi.fn(),
		notificationQueryMock: vi.fn(),
		paramsMock: vi.fn(),
	}),
);

// Unseen (status unread) and unresolved (issue still open) are independent
// axes: ntf_4 is the interesting case — already looked at, still waiting.
const unseenNotifications: NotificationDTO[] = [
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
];

const unresolvedNotifications: NotificationDTO[] = [
	...unseenNotifications,
	{
		id: "ntf_4",
		sessionId: "sess-4",
		projectId: "proj-1",
		prUrl: "",
		type: "needs_input",
		title: "Docs sweep needs input",
		body: "The agent is still waiting for your response.",
		status: "read",
		createdAt: "2026-07-20T09:00:00Z",
		target: { kind: "session", sessionId: "sess-4" },
	},
];

vi.mock("@tanstack/react-router", () => ({ useNavigate: () => navigateMock, useParams: () => paramsMock() }));

vi.mock("../hooks/useNotificationsQuery", () => ({
	useMarkAllNotificationsReadMutation: () => ({ isPending: false, mutateAsync: markAllMock }),
	useNotificationsQuery: (status: NotificationListStatus, enabled?: boolean) => notificationQueryMock(status, enabled),
}));

vi.mock("../lib/notifications", async (importOriginal) => ({
	...((await importOriginal()) as object),
	createNotificationsTransport: (...args: unknown[]) => {
		connectMock(...args);
		return { connect: () => undefined };
	},
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
	await screen.findByText("Unseen");
	return trigger;
}

function notificationQueryResult(
	status: NotificationListStatus,
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
					notifications: status === "unresolved" ? unresolvedNotifications : unseenNotifications,
					nextCursor: hasNextPage ? "older" : undefined,
					unreadCount: 2,
					unresolvedCount: 3,
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
	connectMock.mockReset();
	paramsMock.mockReset().mockReturnValue({});
	useUiStore.setState({ visibleTerminalKindBySession: {} });
	fetchNextPageMock.mockReset().mockResolvedValue(undefined);
	markAllMock.mockReset().mockResolvedValue(0);
	navigateMock.mockReset();
	notificationQueryMock.mockReset().mockImplementation(notificationQueryResult);
	vi.spyOn(window, "open").mockImplementation(() => null);
});

// The runtime tells the transport which session the user is actually watching.
// Being on the session route is not enough: the pane shows one terminal at a
// time, so a shell or reviewer tab hides the agent while the URL is unchanged.
describe("NotificationRuntime", () => {
	function renderRuntime() {
		const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
		render(
			<QueryClientProvider client={queryClient}>
				<NotificationRuntime />
			</QueryClientProvider>,
		);
		return connectMock.mock.calls[0][1] as () => string | undefined;
	}

	it("reports the session while its agent terminal is the one on screen", () => {
		paramsMock.mockReturnValue({ sessionId: "sess-1" });
		useUiStore.setState({ visibleTerminalKindBySession: { "sess-1": "worker" } });

		expect(renderRuntime()()).toBe("sess-1");
	});

	it.each(["shell", "reviewer"] as const)("reports nothing while a %s terminal covers the agent", (kind) => {
		paramsMock.mockReturnValue({ sessionId: "sess-1" });
		useUiStore.setState({ visibleTerminalKindBySession: { "sess-1": kind } });

		expect(renderRuntime()()).toBeUndefined();
	});

	it("reports nothing off a session route", () => {
		paramsMock.mockReturnValue({});
		useUiStore.setState({ visibleTerminalKindBySession: { "sess-1": "worker" } });

		expect(renderRuntime()()).toBeUndefined();
	});

	// The transport connects once and outlives navigation, so the getter has to
	// read live state rather than close over the value it was created with.
	it("tracks tab switches without reconnecting the stream", () => {
		paramsMock.mockReturnValue({ sessionId: "sess-1" });
		useUiStore.setState({ visibleTerminalKindBySession: { "sess-1": "worker" } });
		const getVisibleAgentSessionId = renderRuntime();

		useUiStore.setState({ visibleTerminalKindBySession: { "sess-1": "shell" } });
		expect(getVisibleAgentSessionId()).toBeUndefined();

		useUiStore.setState({ visibleTerminalKindBySession: { "sess-1": "worker" } });
		expect(getVisibleAgentSessionId()).toBe("sess-1");
		expect(connectMock).toHaveBeenCalledTimes(1);
	});
});

describe("NotificationCenter", () => {
	it("opens once on click without a hover/focus remount and dismisses outside", async () => {
		renderNotificationCenter();
		const trigger = screen.getByRole("button", { name: /unread notifications/ });
		fireEvent.mouseEnter(trigger);
		fireEvent.focus(trigger);
		expect(screen.queryByText("Unseen")).not.toBeInTheDocument();

		await clickOpen();

		expect(screen.queryByText(/last 7 days/i)).not.toBeInTheDocument();
		fireEvent.pointerDown(document.body);
		await waitFor(() => expect(screen.queryByText("Unseen")).not.toBeInTheDocument());
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

	// Two sections, one list. A notification that is both unseen and unresolved
	// belongs under Unseen only — never rendered twice.
	it("splits notifications into Unseen and Unresolved without repeating a row", async () => {
		renderNotificationCenter();
		await clickOpen();

		const panel = within(screen.getByRole("dialog", { name: "Notifications" }));
		expect(panel.getByText("Unseen")).toBeInTheDocument();
		expect(panel.getByText("Unresolved")).toBeInTheDocument();

		const rows = panel.getAllByRole("listitem");
		expect(rows.map((row) => row.textContent)).toEqual([
			expect.stringContaining("PR #67 is ready to merge"),
			expect.stringContaining("Checkout flow needs input"),
			expect.stringContaining("Docs sweep needs input"),
		]);
		expect(panel.getAllByText("Checkout flow needs input")).toHaveLength(1);
	});

	// Opening the panel is the acknowledgement; there is no manual control.
	it("acknowledges everything on open and keeps showing what was unseen", async () => {
		renderNotificationCenter();
		await clickOpen();

		expect(markAllMock).toHaveBeenCalledTimes(1);
		expect(screen.queryByRole("button", { name: "Mark all notifications read" })).not.toBeInTheDocument();
		expect(screen.queryByRole("button", { name: "Mark notification read" })).not.toBeInTheDocument();
		expect(screen.getByText("Checkout flow needs input")).toBeInTheDocument();
	});

	// Acknowledging every server row would strand anything past the loaded page,
	// so the panel names exactly the ids it rendered.
	it("acknowledges only the ids it rendered", async () => {
		renderNotificationCenter();
		await clickOpen();

		expect(markAllMock).toHaveBeenCalledWith(["ntf_2", "ntf_1"]);
	});

	// A failed section must not hide behind the other one's success.
	it.each([
		{ failing: "unread" as const, label: "Could not load unseen notifications." },
		{ failing: "unresolved" as const, label: "Could not load unresolved notifications." },
	])("surfaces a failed $failing section instead of claiming success", async ({ failing, label }) => {
		notificationQueryMock.mockImplementation((status: NotificationListStatus) =>
			status === failing
				? { ...notificationQueryResult(status, { isError: true }), data: undefined }
				: notificationQueryResult(status),
		);
		renderNotificationCenter();
		const trigger = screen.getByRole("button", { name: /notifications/i });
		await userEvent.click(trigger);

		expect(await screen.findByText(label)).toBeInTheDocument();
		expect(screen.queryByText("You're all caught up.")).not.toBeInTheDocument();
	});

	// Both sections empty and healthy is the only case that is genuinely clear.
	it("claims all caught up only when both sections loaded", async () => {
		notificationQueryMock.mockImplementation((status: NotificationListStatus) => ({
			...notificationQueryResult(status),
			data: { pageParams: [""], pages: [{ notifications: [], unreadCount: 0, unresolvedCount: 0 }] },
		}));
		renderNotificationCenter();
		await userEvent.click(screen.getByRole("button", { name: /notifications/i }));

		expect(await screen.findByText("You're all caught up.")).toBeInTheDocument();
	});

	it("navigates to the session from anywhere on the row, including the body text", async () => {
		renderNotificationCenter();
		await clickOpen();

		await userEvent.click(screen.getByText("The agent is waiting for your response."));
		expect(navigateMock).toHaveBeenCalledWith({
			to: "/projects/$projectId/sessions/$sessionId",
			params: { projectId: "proj-1", sessionId: "sess-1" },
		});
	});

	// A PR row navigates to the session like any other, but its title stays a
	// real link so the PR itself is still one click away.
	it("opens the PR from its title and the session from the surrounding row", async () => {
		renderNotificationCenter();
		await clickOpen();

		const titleLink = screen.getByRole("link", { name: "PR #67 is ready to merge" });
		expect(titleLink).toHaveAttribute("href", "https://github.com/acme/app/pull/67");
		await userEvent.click(titleLink);
		expect(window.open).toHaveBeenCalledWith("https://github.com/acme/app/pull/67", "_blank", "noopener,noreferrer");
		expect(navigateMock).not.toHaveBeenCalled();

		await clickOpen();
		await userEvent.click(screen.getByText("Checkout flow has no known blocking CI or review feedback."));
		expect(navigateMock).toHaveBeenCalledWith({
			to: "/projects/$projectId/sessions/$sessionId",
			params: { projectId: "proj-1", sessionId: "sess-2" },
		});
	});

	it("opens the session with the keyboard from a focused row", async () => {
		renderNotificationCenter();
		await clickOpen();

		const row = within(screen.getByRole("dialog", { name: "Notifications" })).getAllByRole("button", {
			name: /Checkout flow needs input/,
		})[0];
		row.focus();
		await userEvent.keyboard("{Enter}");

		expect(navigateMock).toHaveBeenCalledWith({
			to: "/projects/$projectId/sessions/$sessionId",
			params: { projectId: "proj-1", sessionId: "sess-1" },
		});
	});

	it("loads earlier history near the end of the scroll viewport", async () => {
		notificationQueryMock.mockImplementation((status: NotificationListStatus) =>
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
		notificationQueryMock.mockImplementation((status: NotificationListStatus) =>
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
