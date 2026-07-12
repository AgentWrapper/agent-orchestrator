import { describe, expect, it } from "vitest";
import { applyWorkspaceUpdate } from "./_shell";
import type { WorkspaceQueryData, WorkspaceSession, WorkspaceSummary } from "../types/workspace";

const host: WorkspaceSummary = {
	id: "agent-orchestrator",
	name: "agent-orchestrator",
	path: "/repo/ao",
	type: "main",
	sessions: [],
};

const other: WorkspaceSummary = {
	id: "other",
	name: "other",
	path: "/repo/other",
	type: "main",
	sessions: [],
};

const primeSession: WorkspaceSession = {
	id: "prime-1",
	workspaceId: host.id,
	workspaceName: host.name,
	title: "AO Prime",
	provider: "codex",
	kind: "prime",
	branch: "ao/agent-orchestrator-prime",
	status: "working",
	updatedAt: "2026-07-12T00:00:00Z",
	prs: [],
};

describe("applyWorkspaceUpdate", () => {
	it("drops a prime session when its host workspace is removed", () => {
		const current: WorkspaceQueryData = { workspaces: [host, other], primeSession };

		const next = applyWorkspaceUpdate(current, (workspaces) =>
			workspaces.filter((workspace) => workspace.id !== host.id),
		);

		expect(next).toEqual({ workspaces: [other], primeSession: undefined });
	});

	it("preserves a prime session while its host workspace remains", () => {
		const current: WorkspaceQueryData = { workspaces: [host], primeSession };

		const next = applyWorkspaceUpdate(current, (workspaces) => workspaces);

		expect(next).toEqual(current);
	});
});
