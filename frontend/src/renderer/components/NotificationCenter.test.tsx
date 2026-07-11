import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { NotificationCenter } from "./NotificationCenter";
import type { NotificationDTO } from "../lib/notifications";

const navigateMock = vi.fn();

let notifications: NotificationDTO[] = [
	{
		id: "ntf_1",
		sessionId: "sess-1",
		projectId: "proj-1",
		prUrl: "",
		type: "needs_input",
		title: "Needs input",
		body: "",
		sensitive: false,
		changedPaths: [],
		headSha: "",
		status: "unread",
		createdAt: "2026-06-16T10:00:00Z",
		target: { kind: "session", sessionId: "sess-1" },
	},
	{
		id: "ntf_2",
		sessionId: "sess-2",
		projectId: "proj-1",
		prUrl: "",
		type: "ready_to_merge",
		title: "Ready to merge",
		body: "",
		sensitive: false,
		changedPaths: [],
		headSha: "",
		status: "unread",
		createdAt: "2026-06-16T11:00:00Z",
		target: { kind: "session", sessionId: "sess-2" },
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

describe("NotificationCenter", () => {
	beforeEach(() => {
		navigateMock.mockReset();
		notifications = [
			{
				id: "ntf_1",
				sessionId: "sess-1",
				projectId: "proj-1",
				prUrl: "",
				type: "needs_input",
				title: "Needs input",
				body: "",
				sensitive: false,
				changedPaths: [],
				headSha: "",
				status: "unread",
				createdAt: "2026-06-16T10:00:00Z",
				target: { kind: "session", sessionId: "sess-1" },
			},
			{
				id: "ntf_2",
				sessionId: "sess-2",
				projectId: "proj-1",
				prUrl: "",
				type: "ready_to_merge",
				title: "Ready to merge",
				body: "",
				sensitive: false,
				changedPaths: [],
				headSha: "",
				status: "unread",
				createdAt: "2026-06-16T11:00:00Z",
				target: { kind: "session", sessionId: "sess-2" },
			},
		];
	});

	it("renders a filled bell with a text-only yellow unread count", () => {
		renderNotificationCenter();

		const trigger = screen.getByRole("button", { name: "2 unread notifications" });
		const bell = trigger.querySelector("svg");
		const count = screen.getByText("2");

		expect(bell).toHaveClass("fill-current");
		expect(count).toHaveClass("text-[11px]");
		expect(count).toHaveClass("text-warning");
		expect(count).not.toHaveClass("bg-warning");
		expect(count).not.toHaveClass("rounded-full");
		expect(count).not.toHaveClass("text-background");
	});

	it("does not navigate when a notification has no target", async () => {
		notifications = [
			{
				id: "ntf_model",
				sessionId: "model-ao-codex",
				projectId: "proj-1",
				prUrl: "",
				type: "model_unreachable",
				title: "Model unreachable",
				body: "",
				sensitive: false,
				changedPaths: [],
				headSha: "",
				status: "unread",
				createdAt: "2026-06-16T12:00:00Z",
				target: { kind: "none", sessionId: "" },
			},
		];
		renderNotificationCenter();

		await userEvent.click(screen.getByRole("button", { name: "1 unread notifications" }));
		await userEvent.click(await screen.findByText("Model unreachable"));

		expect(navigateMock).not.toHaveBeenCalled();
	});
});
