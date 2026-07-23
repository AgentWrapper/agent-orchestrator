import { beforeEach, describe, expect, it, vi } from "vitest";
import { openOrEnsureOrchestrator } from "./open-orchestrator";
import { spawnOrchestrator } from "./spawn-orchestrator";
import type { WorkspaceSession, WorkspaceSummary } from "../types/workspace";

vi.mock("./spawn-orchestrator", () => ({
	spawnOrchestrator: vi.fn(),
}));

const spawnMock = vi.mocked(spawnOrchestrator);

function orch(overrides: Partial<WorkspaceSession> & { id: string }): WorkspaceSession {
	return {
		workspaceId: "proj",
		workspaceName: "Project",
		title: "orchestrator",
		provider: "claude-code",
		kind: "orchestrator",
		branch: "main",
		status: "working",
		updatedAt: "2026-01-02T00:00:00Z",
		createdAt: "2026-01-02T00:00:00Z",
		prs: [],
		...overrides,
	};
}

function workspace(sessions: WorkspaceSession[]): WorkspaceSummary {
	return { id: "proj", name: "Project", path: "/tmp/proj", sessions };
}

describe("openOrEnsureOrchestrator", () => {
	beforeEach(() => {
		spawnMock.mockReset();
	});

	it("returns the cached live orchestrator without spawning", async () => {
		const live = orch({ id: "proj-orch" });
		const refetchWorkspaces = vi.fn();

		const result = await openOrEnsureOrchestrator("proj", "topbar", {
			workspaces: [workspace([live])],
			refetchWorkspaces,
		});

		expect(result).toEqual({ sessionId: "proj-orch", didSpawn: false });
		expect(refetchWorkspaces).not.toHaveBeenCalled();
		expect(spawnMock).not.toHaveBeenCalled();
	});

	it("refetches once when cache is empty and reuses the live orchestrator", async () => {
		const live = orch({ id: "proj-orch-live" });
		const refetchWorkspaces = vi.fn().mockResolvedValue([workspace([live])]);

		const result = await openOrEnsureOrchestrator("proj", "sidebar", {
			workspaces: [workspace([])],
			refetchWorkspaces,
		});

		expect(result).toEqual({ sessionId: "proj-orch-live", didSpawn: false });
		expect(refetchWorkspaces).toHaveBeenCalledTimes(1);
		expect(spawnMock).not.toHaveBeenCalled();
	});

	it("spawns once with clean=false when cache and refetch both find none", async () => {
		spawnMock.mockResolvedValue("proj-orch-new");
		const refetchWorkspaces = vi.fn().mockResolvedValue([workspace([])]);

		const result = await openOrEnsureOrchestrator("proj", "command_palette", {
			workspaces: [],
			refetchWorkspaces,
		});

		expect(result).toEqual({ sessionId: "proj-orch-new", didSpawn: true });
		expect(refetchWorkspaces).toHaveBeenCalledTimes(1);
		expect(spawnMock).toHaveBeenCalledTimes(1);
		expect(spawnMock).toHaveBeenCalledWith("proj", "command_palette", false);
	});

	it("ignores terminated orchestrators in cache and after refetch", async () => {
		const dead = orch({ id: "proj-dead", status: "terminated" });
		spawnMock.mockResolvedValue("proj-orch-new");
		const refetchWorkspaces = vi.fn().mockResolvedValue([workspace([dead])]);

		const result = await openOrEnsureOrchestrator("proj", "topbar", {
			workspaces: [workspace([dead])],
			refetchWorkspaces,
		});

		expect(result).toEqual({ sessionId: "proj-orch-new", didSpawn: true });
		expect(spawnMock).toHaveBeenCalledWith("proj", "topbar", false);
	});
});
