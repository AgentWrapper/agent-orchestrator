import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { MigrationState } from "../../main/app-state";
import { i18n, initializeRendererI18n } from "../i18n";
import { formatDateTime } from "../lib/format-time";
import { MigrationSection } from "./MigrationSection";

const { getMock, postMock, getMigration, setMigration } = vi.hoisted(() => ({
	getMock: vi.fn(),
	postMock: vi.fn(),
	getMigration: vi.fn(),
	setMigration: vi.fn(),
}));

vi.mock("../lib/api-client", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../lib/api-client")>();
	return { ...actual, apiClient: { GET: getMock, POST: postMock } };
});
vi.mock("../lib/bridge", () => ({ aoBridge: { appState: { getMigration, setMigration } } }));

function renderSection() {
	const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
	return render(
		<QueryClientProvider client={client}>
			<MigrationSection />
		</QueryClientProvider>,
	);
}

function migration(value: MigrationState) {
	getMigration.mockResolvedValue(value);
}

beforeEach(async () => {
	await initializeRendererI18n("en");
	for (const mock of [getMock, postMock, getMigration, setMigration]) mock.mockReset();
	migration({ status: "pending" });
	getMock.mockResolvedValue({ data: { available: true, legacyRoot: "/srv/legacy/.ao" }, error: undefined });
	postMock.mockResolvedValue({ data: { report: { projectsImported: 7, projectsSkipped: 3 } }, error: undefined });
	setMigration.mockResolvedValue(undefined);
});

describe("MigrationSection", () => {
	it.each([
		["pending", "Not migrated yet", "尚未迁移"],
		["completed", "Completed", "已完成"],
		["declined", "Declined", "已拒绝"],
		["failed", "Last attempt failed", "上次尝试失败"],
	] as const)("localizes the %s status without changing the legacy root", async (status, english, chinese) => {
		migration({ status });
		renderSection();

		expect(await screen.findByText(english)).toBeInTheDocument();
		expect(await screen.findByText("/srv/legacy/.ao")).toBeInTheDocument();
		await act(async () => i18n.changeLanguage("zh-CN"));
		expect(screen.getByText(chinese)).toBeInTheDocument();
		expect(screen.getByText("/srv/legacy/.ao")).toBeInTheDocument();
	});

	it("formats the same completion date in the current locale and preserves report counts", async () => {
		const completedAt = "2026-07-17T10:15:00Z";
		migration({
			status: "completed",
			completedAt,
			report: { projectsImported: 7, projectsSkipped: 3 },
		});
		renderSection();

		expect(await screen.findByText(formatDateTime(completedAt, "en"))).toBeInTheDocument();
		expect(screen.getByText("7 imported, 3 already present")).toBeInTheDocument();
		await act(async () => i18n.changeLanguage("zh-CN"));
		expect(screen.getByText(formatDateTime(completedAt, "zh-CN"))).toBeInTheDocument();
		expect(screen.getByText("已导入 7 个，已有 3 个")).toBeInTheDocument();
	});

	it("keeps missing and invalid migration dates empty", async () => {
		migration({ status: "declined", lastAttemptAt: "not-a-date" });
		renderSection();

		expect(await screen.findByText("Declined")).toBeInTheDocument();
		expect(screen.queryByText("Last attempt")).not.toBeInTheDocument();
		expect(screen.queryByText("Invalid Date")).not.toBeInTheDocument();
	});

	it("relocalizes reassurance around a persisted external error", async () => {
		migration({ status: "failed", error: "EACCES /srv/legacy/.ao" });
		renderSection();

		expect(await screen.findByText(/EACCES \/srv\/legacy\/\.ao/)).toBeInTheDocument();
		expect(screen.getByText(/Your legacy projects are untouched/)).toBeInTheDocument();
		await act(async () => i18n.changeLanguage("zh-CN"));
		expect(screen.getByText(/EACCES \/srv\/legacy\/\.ao/)).toBeInTheDocument();
		expect(screen.getByText(/你的旧项目保持不变/)).toBeInTheDocument();
	});

	it("relocalizes an active migration fallback instead of freezing English", async () => {
		postMock.mockResolvedValue({ data: undefined, error: {} });
		renderSection();
		await userEvent.click(await screen.findByRole("button", { name: "Run migration" }));
		expect(await screen.findByText("Migration failed.")).toBeInTheDocument();

		await act(async () => i18n.changeLanguage("zh-CN"));
		expect(screen.getByText("迁移失败。")).toBeInTheDocument();
	});

	it("persists a stable API code and relocalizes it after a restart-style render", async () => {
		let persisted: MigrationState = { status: "pending" };
		getMigration.mockImplementation(async () => persisted);
		setMigration.mockImplementation(async (next: MigrationState) => {
			persisted = next;
		});
		postMock.mockResolvedValue({
			data: undefined,
			error: {
				error: "Forbidden",
				code: "DIRECTORY_PERMISSION_DENIED",
				message: "Directory permission denied; token=do-not-show",
			},
		});

		const view = renderSection();
		await userEvent.click(await screen.findByRole("button", { name: "Run migration" }));
		await waitFor(() =>
			expect(setMigration).toHaveBeenCalledWith(
				expect.objectContaining({ status: "failed", errorCode: "DIRECTORY_PERMISSION_DENIED" }),
			),
		);
		expect(persisted).not.toHaveProperty("error");
		expect(await screen.findByText(/You do not have permission to access this directory/)).toBeInTheDocument();

		view.unmount();
		await act(async () => i18n.changeLanguage("zh-CN"));
		renderSection();
		expect(await screen.findByText(/没有权限访问该目录/)).toBeInTheDocument();
		expect(screen.queryByText(/do-not-show/)).not.toBeInTheDocument();
	});

	it("persists only a filtered unknown API detail and replays it unchanged", async () => {
		let persisted: MigrationState = { status: "pending" };
		getMigration.mockImplementation(async () => persisted);
		setMigration.mockImplementation(async (next: MigrationState) => {
			persisted = next;
		});
		postMock.mockResolvedValue({
			data: undefined,
			error: { error: "Conflict", code: "FUTURE_CODE", message: "disk full on /srv/legacy" },
		});

		const view = renderSection();
		await userEvent.click(await screen.findByRole("button", { name: "Run migration" }));
		await waitFor(() =>
			expect(setMigration).toHaveBeenCalledWith(
				expect.objectContaining({ status: "failed", errorDetail: "disk full on /srv/legacy" }),
			),
		);
		expect(persisted).not.toHaveProperty("error");

		view.unmount();
		await act(async () => i18n.changeLanguage("zh-CN"));
		renderSection();
		expect(await screen.findByText(/disk full on \/srv\/legacy/)).toBeInTheDocument();
		expect(screen.getByText(/你的旧项目保持不变/)).toBeInTheDocument();
	});

	it("uses the current-language fallback after replaying an error with no safe detail", async () => {
		let persisted: MigrationState = { status: "pending" };
		getMigration.mockImplementation(async () => persisted);
		setMigration.mockImplementation(async (next: MigrationState) => {
			persisted = next;
		});
		postMock.mockResolvedValue({ data: undefined, error: {} });

		const view = renderSection();
		await userEvent.click(await screen.findByRole("button", { name: "Run migration" }));
		await waitFor(() => expect(setMigration).toHaveBeenCalledWith(expect.objectContaining({ status: "failed" })));
		expect(persisted).not.toHaveProperty("error");

		view.unmount();
		await act(async () => i18n.changeLanguage("zh-CN"));
		renderSection();
		expect(await screen.findByText(/迁移失败。/)).toBeInTheDocument();
	});

	it.each([
		["POST rejects", () => postMock.mockRejectedValueOnce(new Error("connection reset by peer"))],
		["state write rejects", () => setMigration.mockRejectedValueOnce(new Error("app state is read-only"))],
	] as const)("catches %s, shows its safe message, and restores the action", async (_name, arrange) => {
		arrange();
		renderSection();
		await userEvent.click(await screen.findByRole("button", { name: "Run migration" }));

		const detail = _name === "POST rejects" ? "connection reset by peer" : "app state is read-only";
		expect(await screen.findByText(detail)).toBeInTheDocument();
		expect(screen.getByRole("button", { name: "Run migration" })).toBeEnabled();
	});
});
