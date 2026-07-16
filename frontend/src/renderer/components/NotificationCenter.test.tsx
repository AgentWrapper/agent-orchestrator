import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { i18n } from "../i18n";
import type { NotificationDTO } from "../lib/notifications";
import { NotificationCenter } from "./NotificationCenter";

const hookState = vi.hoisted(() => ({
	notifications: [] as NotificationDTO[],
	isError: false,
	markOne: vi.fn(),
	markAll: vi.fn(),
}));

vi.mock("@tanstack/react-router", () => ({ useNavigate: () => vi.fn() }));

vi.mock("../hooks/useNotificationsQuery", () => ({
	useMarkAllNotificationsReadMutation: () => ({ isPending: false, mutateAsync: hookState.markAll }),
	useMarkNotificationReadMutation: () => ({ isPending: false, mutateAsync: hookState.markOne }),
	useNotificationsQuery: () => ({ data: hookState.notifications, isError: hookState.isError }),
}));

vi.mock("../lib/notifications", async (importOriginal) => ({
	...((await importOriginal()) as object),
	createNotificationsTransport: () => ({ connect: () => undefined }),
}));

function notification(index: number, overrides: Partial<NotificationDTO> = {}): NotificationDTO {
	return {
		id: `ntf_${index}`,
		sessionId: `sess-${index}`,
		projectId: "proj-1",
		prUrl: "",
		type: "needs_input",
		title: "Needs input",
		body: "The agent is waiting for your response.",
		status: "unread",
		createdAt: "2026-07-17T10:00:00Z",
		target: { kind: "session", sessionId: `sess-${index}` },
		...overrides,
	};
}

function renderNotificationCenter() {
	const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
	return render(
		<QueryClientProvider client={queryClient}>
			<NotificationCenter />
		</QueryClientProvider>,
	);
}

beforeEach(() => {
	hookState.notifications = [
		notification(1),
		notification(2, {
			type: "ready_to_merge",
			prUrl: "https://github.com/acme/widgets/pull/42",
			target: { kind: "pr", sessionId: "sess-2", prUrl: "https://github.com/acme/widgets/pull/42" },
		}),
	];
	hookState.isError = false;
	hookState.markOne.mockReset().mockResolvedValue(undefined);
	hookState.markAll.mockReset().mockResolvedValue(undefined);
	vi.spyOn(Date, "now").mockReturnValue(Date.parse("2026-07-17T12:00:00Z"));
});

describe("NotificationCenter", () => {
	it("renders a filled bell with a localized text-only unread count", () => {
		renderNotificationCenter();

		const trigger = screen.getByRole("button", { name: "2 unread notifications" });
		const bell = trigger.querySelector("svg");
		const count = screen.getByText("2");

		expect(bell).toHaveClass("fill-current");
		expect(count).toHaveClass("text-caption");
		expect(count).toHaveClass("text-warning");
		expect(count).not.toHaveClass("bg-warning");
		expect(count).not.toHaveClass("rounded-full");
		expect(count).not.toHaveClass("text-background");
	});

	it.each([
		[1, "1 unread notification"],
		[2, "2 unread notifications"],
		[100, "100 unread notifications"],
	] as const)("formats an English unread count of %i", (count, label) => {
		hookState.notifications = Array.from({ length: count }, (_, index) => notification(index));
		renderNotificationCenter();

		expect(screen.getByRole("button", { name: label })).toBeInTheDocument();
	});

	it("localizes cached items, time, controls, and counts after a language switch", async () => {
		const user = userEvent.setup();
		renderNotificationCenter();

		await user.click(screen.getByRole("button", { name: "2 unread notifications" }));
		expect(await screen.findByText("sess-1 needs input")).toBeInTheDocument();
		expect(screen.getAllByText("2h ago").length).toBeGreaterThan(0);

		await act(async () => {
			await i18n.changeLanguage("zh-CN");
		});

		expect(screen.getByRole("menu", { name: "2 条未读通知" })).toBeInTheDocument();
		expect(screen.getByText("会话 sess-1 需要输入")).toBeInTheDocument();
		expect(screen.getByText("拉取请求 #42 已可合并")).toBeInTheDocument();
		expect(screen.getAllByText("2小时前").length).toBeGreaterThan(0);
		expect(screen.getByText("通知")).toBeInTheDocument();
		expect(screen.getByRole("button", { name: "全部标为已读" })).toBeInTheDocument();
		expect(screen.getAllByRole("button", { name: "打开通知目标" })).toHaveLength(2);
		expect(screen.getAllByRole("button", { name: "标记通知为已读" })).toHaveLength(2);
	});

	it("localizes query and action failures without exposing thrown messages", async () => {
		const user = userEvent.setup();
		await i18n.changeLanguage("zh-CN");
		hookState.notifications = [];
		hookState.isError = true;
		const view = renderNotificationCenter();

		await user.click(screen.getByRole("button", { name: "通知" }));
		expect(await screen.findByText("无法加载通知。")).toBeInTheDocument();

		hookState.notifications = [notification(1)];
		hookState.isError = false;
		hookState.markAll.mockRejectedValue(new Error("Bearer secret-token"));
		view.rerender(
			<QueryClientProvider client={new QueryClient()}>
				<NotificationCenter />
			</QueryClientProvider>,
		);
		await user.click(screen.getByRole("button", { name: "全部标为已读" }));

		await waitFor(() => expect(screen.getByText("无法将所有通知标记为已读")).toBeInTheDocument());
		expect(screen.queryByText(/secret-token/)).not.toBeInTheDocument();
	});

	it("localizes the empty state", async () => {
		const user = userEvent.setup();
		await i18n.changeLanguage("zh-CN");
		hookState.notifications = [];
		renderNotificationCenter();

		await user.click(screen.getByRole("button", { name: "通知" }));
		expect(await screen.findByText("没有未读通知。")).toBeInTheDocument();
	});
});
