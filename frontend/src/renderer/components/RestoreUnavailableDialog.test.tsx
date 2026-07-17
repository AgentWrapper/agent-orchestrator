import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { i18n, initializeRendererI18n } from "../i18n";
import type { WorkspaceSession } from "../types/workspace";
import { OrchestratorSpawnError } from "../lib/spawn-orchestrator";
import { RestoreUnavailableDialog } from "./RestoreUnavailableDialog";

const { spawnOrchestrator } = vi.hoisted(() => ({ spawnOrchestrator: vi.fn() }));

vi.mock("../lib/spawn-orchestrator", async (importOriginal) => ({
	...(await importOriginal<typeof import("../lib/spawn-orchestrator")>()),
	spawnOrchestrator,
}));

const orchestrator: WorkspaceSession = {
	id: "orchestrator-raw-id",
	workspaceId: "project-raw-id",
	workspaceName: "Raw Project",
	title: "Raw Orchestrator",
	provider: "codex",
	kind: "orchestrator",
	branch: "ao/raw-branch",
	status: "idle",
	updatedAt: "2026-07-17T00:00:00Z",
	prs: [],
};

const worker: WorkspaceSession = {
	...orchestrator,
	id: "worker-raw-id",
	title: "Raw Worker",
	kind: "worker",
};

beforeEach(() => {
	spawnOrchestrator.mockReset();
});

afterEach(async () => {
	await initializeRendererI18n("en");
});

describe("RestoreUnavailableDialog", () => {
	it("renders the English worker-session explanation and close action", async () => {
		const onOpenChange = vi.fn();
		render(
			<RestoreUnavailableDialog open session={worker} onOpenChange={onOpenChange} onRecreated={() => undefined} />,
		);

		expect(screen.getByRole("dialog", { name: "Session can no longer be restored" })).toBeInTheDocument();
		expect(screen.getByText("This session has no saved agent session or prompt to resume from.")).toBeInTheDocument();
		expect(screen.queryByRole("button", { name: "Create new orchestrator" })).not.toBeInTheDocument();
		await userEvent.click(screen.getByRole("button", { name: "Close" }));
		expect(onOpenChange).toHaveBeenCalledWith(false);
	});

	it("renders Chinese orchestrator actions and keeps a raw failure detail unchanged", async () => {
		await act(async () => initializeRendererI18n("zh-CN"));
		spawnOrchestrator.mockRejectedValue(new Error("raw restore server detail"));
		render(
			<RestoreUnavailableDialog
				open
				session={orchestrator}
				onOpenChange={() => undefined}
				onRecreated={() => undefined}
			/>,
		);

		expect(screen.getByRole("dialog", { name: "会话已无法恢复" })).toBeInTheDocument();
		expect(screen.getByText(/此协调器没有可恢复的已保存智能体会话/)).toBeInTheDocument();
		await userEvent.click(screen.getByRole("button", { name: "创建新协调器" }));
		expect(await screen.findByText("raw restore server detail")).toBeInTheDocument();
		expect(spawnOrchestrator).toHaveBeenCalledWith("project-raw-id", "restore_dialog", true);
	});

	it("relocalizes the no-detail spawn fallback after failure without remounting", async () => {
		spawnOrchestrator.mockRejectedValue(new OrchestratorSpawnError(undefined, 503));
		render(
			<RestoreUnavailableDialog
				open
				session={orchestrator}
				onOpenChange={() => undefined}
				onRecreated={() => undefined}
			/>,
		);

		await userEvent.click(screen.getByRole("button", { name: "Create new orchestrator" }));
		expect(await screen.findByText("Failed to spawn orchestrator (503)")).toBeInTheDocument();

		await initializeRendererI18n("zh-CN");
		expect(screen.getByText("无法启动协调器（503）")).toBeInTheDocument();
		expect(screen.queryByText("Failed to spawn orchestrator (503)")).not.toBeInTheDocument();
	});

	it("filters credential-bearing restore failures and retranslates the fallback", async () => {
		spawnOrchestrator.mockRejectedValue(new Error("Authorization: Bearer restore-secret"));
		render(
			<RestoreUnavailableDialog
				open
				session={orchestrator}
				onOpenChange={() => undefined}
				onRecreated={() => undefined}
			/>,
		);

		await userEvent.click(screen.getByRole("button", { name: "Create new orchestrator" }));
		expect(await screen.findByText("Failed to create orchestrator")).toBeInTheDocument();
		expect(screen.queryByText(/restore-secret/)).not.toBeInTheDocument();

		await act(async () => i18n.changeLanguage("zh-CN"));
		expect(screen.getByText("无法创建协调器")).toBeInTheDocument();
		expect(screen.queryByText(/restore-secret/)).not.toBeInTheDocument();
	});
});
