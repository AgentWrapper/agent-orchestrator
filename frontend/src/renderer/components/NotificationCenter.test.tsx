import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { NotificationCenter } from "./NotificationCenter";
import type { NotificationDTO } from "../lib/notifications";

const { navigateMock } = vi.hoisted(() => ({ navigateMock: vi.fn() }));

const notifications: NotificationDTO[] = [
	{
		id: "ntf_1",
		sessionId: "sess-1",
		projectId: "proj-1",
		prUrl: "",
		type: "needs_input",
		title: "Needs input",
		body: "",
		status: "unread",
		createdAt: "2026-06-16T10:00:00Z",
		target: { kind: "session", sessionId: "sess-1" },
	},
	{
		id: "ntf_2",
		sessionId: "sess-2",
		projectId: "proj-1",
		prUrl: "https://github.com/example/repo/pull/2",
		type: "ready_to_merge",
		title: "Project PR ready to merge",
		body: "",
		status: "unread",
		createdAt: "2026-06-16T11:00:00Z",
		target: { kind: "pr", sessionId: "sess-2", prUrl: "https://github.com/example/repo/pull/2" },
	},
	{
		id: "ntf_3",
		sessionId: "sess-3",
		projectId: "",
		prUrl: "https://github.com/example/repo/pull/3",
		type: "pr_merged",
		title: "Unscoped PR merged",
		body: "",
		status: "unread",
		createdAt: "2026-06-16T11:30:00Z",
		target: { kind: "pr", sessionId: "sess-3", prUrl: "https://github.com/example/repo/pull/3" },
	},
	{
		id: "ntf_4",
		sessionId: "",
		projectId: "",
		prUrl: "https://github.com/example/repo/pull/4",
		type: "pr_closed_unmerged",
		title: "PR without a session",
		body: "",
		status: "unread",
		createdAt: "2026-06-16T13:00:00Z",
		target: { kind: "pr", sessionId: "", prUrl: "https://github.com/example/repo/pull/4" },
	},
];

vi.mock("@tanstack/react-router", () => ({ useNavigate: () => navigateMock }));

vi.mock("../hooks/useNotificationsQuery", () => ({
	useMarkAllNotificationsReadMutation: () => ({ isPending: false, mutateAsync: vi.fn() }),
	useMarkNotificationReadMutation: () => ({ isPending: false, mutateAsync: vi.fn() }),
	useNotificationsQuery: () => ({ data: notifications, isError: false }),
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

async function openNotification(title: string) {
	const user = userEvent.setup();
	await user.click(screen.getByRole("button", { name: "4 unread notifications" }));
	const item = (await screen.findByText(title)).closest(".grid");
	expect(item).not.toBeNull();
	await user.click(within(item as HTMLElement).getByTitle("Open target"));
}

describe("NotificationCenter", () => {
	beforeEach(() => {
		vi.restoreAllMocks();
		navigateMock.mockReset();
	});

	it("renders a filled bell with a text-only yellow unread count", () => {
		renderNotificationCenter();

		const trigger = screen.getByRole("button", { name: "4 unread notifications" });
		const bell = trigger.querySelector("svg");
		const count = screen.getByText("4");

		expect(bell).toHaveClass("fill-current");
		expect(count).toHaveClass("text-caption");
		expect(count).toHaveClass("text-warning");
		expect(count).not.toHaveClass("bg-warning");
		expect(count).not.toHaveClass("rounded-full");
		expect(count).not.toHaveClass("text-background");
	});

	it("opens a PR and navigates to its project-scoped session", async () => {
		const openSpy = vi.spyOn(window, "open").mockImplementation(() => null);
		renderNotificationCenter();

		await openNotification("Project PR ready to merge");

		expect(openSpy).toHaveBeenCalledWith("https://github.com/example/repo/pull/2", "_blank", "noopener,noreferrer");
		expect(navigateMock).toHaveBeenCalledWith({
			to: "/projects/$projectId/sessions/$sessionId",
			params: { projectId: "proj-1", sessionId: "sess-2" },
		});
	});

	it("opens a PR and navigates to its unscoped session", async () => {
		const openSpy = vi.spyOn(window, "open").mockImplementation(() => null);
		renderNotificationCenter();

		await openNotification("Unscoped PR merged");

		expect(openSpy).toHaveBeenCalledWith("https://github.com/example/repo/pull/3", "_blank", "noopener,noreferrer");
		expect(navigateMock).toHaveBeenCalledWith({ to: "/sessions/$sessionId", params: { sessionId: "sess-3" } });
	});

	it("keeps session notification navigation unchanged", async () => {
		const openSpy = vi.spyOn(window, "open").mockImplementation(() => null);
		renderNotificationCenter();

		await openNotification("Needs input");

		expect(openSpy).not.toHaveBeenCalled();
		expect(navigateMock).toHaveBeenCalledWith({
			to: "/projects/$projectId/sessions/$sessionId",
			params: { projectId: "proj-1", sessionId: "sess-1" },
		});
	});

	it("opens a PR without navigating when its session ID is missing", async () => {
		const openSpy = vi.spyOn(window, "open").mockImplementation(() => null);
		renderNotificationCenter();

		await openNotification("PR without a session");

		expect(openSpy).toHaveBeenCalledWith("https://github.com/example/repo/pull/4", "_blank", "noopener,noreferrer");
		expect(navigateMock).not.toHaveBeenCalled();
	});
});
