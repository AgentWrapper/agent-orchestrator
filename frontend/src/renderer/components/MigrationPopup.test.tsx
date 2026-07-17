import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { MigrationState } from "../../main/app-state";
import { i18n, initializeRendererI18n } from "../i18n";
import { MigrationPopup } from "./MigrationPopup";

const { getMock, postMock, getMigration, setMigration, isRemoteClient } = vi.hoisted(() => ({
	getMock: vi.fn(),
	postMock: vi.fn(),
	getMigration: vi.fn(),
	setMigration: vi.fn(),
	isRemoteClient: vi.fn(),
}));

vi.mock("../lib/api-client", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../lib/api-client")>();
	return { ...actual, apiClient: { GET: getMock, POST: postMock } };
});
vi.mock("../lib/bridge", () => ({
	aoBridge: { appState: { getMigration, setMigration }, remoteServer: { isRemoteClient } },
}));

function renderPopup() {
	const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
	const view = render(
		<QueryClientProvider client={qc}>
			<MigrationPopup />
		</QueryClientProvider>,
	);
	return { qc, ...view };
}

beforeEach(async () => {
	await initializeRendererI18n("en");
	getMock.mockReset();
	postMock.mockReset();
	getMigration.mockReset();
	setMigration.mockReset();
	isRemoteClient.mockReset().mockResolvedValue(false);
	getMigration.mockResolvedValue({ status: "pending" });
	getMock.mockResolvedValue({ data: { available: true, legacyRoot: "/home/u/.agent-orchestrator" }, error: undefined });
	postMock.mockResolvedValue({ data: { report: { projectsImported: 2, projectsSkipped: 1 } }, error: undefined });
	setMigration.mockResolvedValue(undefined);
});

describe("MigrationPopup", () => {
	it("switches the offer language without changing the discovered legacy root", async () => {
		renderPopup();

		expect(await screen.findByText(/Import projects from your earlier AO/i)).toBeInTheDocument();
		expect(screen.getByText("/home/u/.agent-orchestrator")).toBeInTheDocument();

		await act(async () => i18n.changeLanguage("zh-CN"));

		expect(screen.getByText("从早期 AO 导入项目？")).toBeInTheDocument();
		expect(screen.getByText("/home/u/.agent-orchestrator")).toBeInTheDocument();
		expect(screen.getByRole("button", { name: "继续" })).toBeInTheDocument();
		expect(screen.getByRole("button", { name: "跳过" })).toBeInTheDocument();
		expect(screen.getByRole("button", { name: "不迁移" })).toBeInTheDocument();
	});

	it("shows when a legacy install is available and the marker is pending", async () => {
		renderPopup();
		expect(await screen.findByText(/Import projects from your earlier AO/i)).toBeInTheDocument();
		expect(screen.getByText("/home/u/.agent-orchestrator")).toBeInTheDocument();
	});

	it("renders nothing when the marker is declined", async () => {
		getMigration.mockResolvedValue({ status: "declined" });
		renderPopup();
		await waitFor(() => expect(getMigration).toHaveBeenCalled());
		expect(screen.queryByText(/Import projects from your earlier AO/i)).not.toBeInTheDocument();
		expect(getMock).not.toHaveBeenCalled();
	});

	it("never queries or runs migration in the Remote client", async () => {
		isRemoteClient.mockResolvedValue(true);
		renderPopup();
		await waitFor(() => expect(isRemoteClient).toHaveBeenCalled());
		expect(getMigration).not.toHaveBeenCalled();
		expect(getMock).not.toHaveBeenCalled();
		expect(postMock).not.toHaveBeenCalled();
		expect(screen.queryByText(/Import projects from your earlier AO/i)).not.toBeInTheDocument();
	});

	it("Proceed imports, marks completed, and retires", async () => {
		renderPopup();
		await screen.findByText(/Import projects from your earlier AO/i);
		await userEvent.click(screen.getByRole("button", { name: "Proceed" }));
		await waitFor(() => expect(postMock).toHaveBeenCalledWith("/api/v1/import"));
		expect(setMigration).toHaveBeenCalledWith(expect.objectContaining({ status: "completed" }));
		await waitFor(() => expect(screen.queryByText(/Import projects from your earlier AO/i)).not.toBeInTheDocument());
	});

	it("Don't Migrate records declined", async () => {
		renderPopup();
		await screen.findByText(/Import projects from your earlier AO/i);
		await userEvent.click(screen.getByRole("button", { name: "Don't Migrate" }));
		expect(setMigration).toHaveBeenCalledWith(expect.objectContaining({ status: "declined" }));
	});

	it("Skip dismisses without writing the marker", async () => {
		renderPopup();
		await screen.findByText(/Import projects from your earlier AO/i);
		await userEvent.click(screen.getByRole("button", { name: "Skip" }));
		expect(setMigration).not.toHaveBeenCalled();
		expect(screen.queryByText(/Import projects from your earlier AO/i)).not.toBeInTheDocument();
	});

	it("a failed import shows the lossless reassurance and marks failed", async () => {
		postMock.mockResolvedValue({
			data: undefined,
			error: { error: "Conflict", code: "FUTURE_CODE", message: "disk full" },
		});
		renderPopup();
		await screen.findByText(/Import projects from your earlier AO/i);
		await userEvent.click(screen.getByRole("button", { name: "Proceed" }));
		expect(await screen.findByText(/nothing is ever deleted/i)).toBeInTheDocument();
		expect(setMigration).toHaveBeenCalledWith(expect.objectContaining({ status: "failed", errorDetail: "disk full" }));
		expect(setMigration).not.toHaveBeenCalledWith(expect.objectContaining({ error: expect.anything() }));
	});

	it("relocalizes a visible application fallback while preserving an external error", async () => {
		postMock.mockResolvedValueOnce({ data: undefined, error: {} });
		renderPopup();
		await screen.findByText(/Import projects from your earlier AO/i);
		await userEvent.click(screen.getByRole("button", { name: "Proceed" }));
		expect(await screen.findByText(/Migration failed: Migration failed\./i)).toBeInTheDocument();

		await act(async () => i18n.changeLanguage("zh-CN"));
		expect(screen.getByText(/迁移失败：迁移失败。/)).toBeInTheDocument();

		postMock.mockResolvedValueOnce({
			data: undefined,
			error: { error: "Conflict", code: "FUTURE_CODE", message: "EACCES /srv/legacy" },
		});
		await userEvent.click(screen.getByRole("button", { name: "重试" }));
		expect(await screen.findByText(/EACCES \/srv\/legacy/)).toBeInTheDocument();
	});

	it("replays a failed marker and translates its semantic code in the current locale", async () => {
		let persisted: MigrationState = { status: "pending" };
		getMigration.mockImplementation(async () => persisted);
		setMigration.mockImplementation(async (next) => {
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

		const view = renderPopup();
		await userEvent.click(await screen.findByRole("button", { name: "Proceed" }));
		await waitFor(() =>
			expect(setMigration).toHaveBeenCalledWith(
				expect.objectContaining({ status: "failed", errorCode: "DIRECTORY_PERMISSION_DENIED" }),
			),
		);
		view.unmount();

		await act(async () => i18n.changeLanguage("zh-CN"));
		renderPopup();
		expect(await screen.findByText(/没有权限访问该目录/)).toBeInTheDocument();
		expect(screen.queryByText(/do-not-show/)).not.toBeInTheDocument();
	});

	it.each([
		["POST rejects", () => postMock.mockRejectedValueOnce(new Error("connection reset by peer"))],
		["completed state write rejects", () => setMigration.mockRejectedValueOnce(new Error("app state is read-only"))],
	] as const)("catches %s and always releases busy", async (_name, arrange) => {
		arrange();
		renderPopup();
		await userEvent.click(await screen.findByRole("button", { name: "Proceed" }));

		const detail = _name === "POST rejects" ? "connection reset by peer" : "app state is read-only";
		expect(await screen.findByText(new RegExp(detail))).toBeInTheDocument();
		expect(screen.getByRole("button", { name: "Retry" })).toBeEnabled();
	});

	it("catches a failed-marker write rejection and replaces the API error with the write failure", async () => {
		postMock.mockResolvedValue({
			data: undefined,
			error: { error: "Conflict", code: "FUTURE_CODE", message: "disk full" },
		});
		setMigration.mockRejectedValueOnce(new Error("cannot persist migration state"));
		renderPopup();
		await userEvent.click(await screen.findByRole("button", { name: "Proceed" }));

		expect(await screen.findByText(/cannot persist migration state/)).toBeInTheDocument();
		expect(screen.queryByText(/disk full/)).not.toBeInTheDocument();
		expect(screen.getByRole("button", { name: "Retry" })).toBeEnabled();
	});

	it("catches a decline-marker write rejection and restores both actions", async () => {
		setMigration.mockRejectedValueOnce(new Error("cannot persist decline"));
		renderPopup();
		await userEvent.click(await screen.findByRole("button", { name: "Don't Migrate" }));

		expect(await screen.findByText(/cannot persist decline/)).toBeInTheDocument();
		expect(screen.getByRole("button", { name: "Don't Migrate" })).toBeEnabled();
		expect(screen.getByRole("button", { name: "Retry" })).toBeEnabled();
	});
});
