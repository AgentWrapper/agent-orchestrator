import { renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { WorkspaceSummary } from "../types/workspace";
import { useReverbTopbarModel, type ReverbTopbarSurfaceOverride } from "./useReverbTopbarModel";

const { navigateMock, paramsMock, workspaceQueryMock } = vi.hoisted(() => ({
	navigateMock: vi.fn(),
	paramsMock: { projectId: undefined as string | undefined, sessionId: undefined as string | undefined },
	workspaceQueryMock: vi.fn(),
}));

vi.mock("@tanstack/react-router", () => ({
	useNavigate: () => navigateMock,
	useParams: () => paramsMock,
}));

vi.mock("./useWorkspaceQuery", () => ({
	useWorkspaceQuery: () => workspaceQueryMock(),
}));

const workspaces: WorkspaceSummary[] = [
	{
		id: "project-1",
		name: "reverb-app",
		path: "/work/reverb-app",
		orchestratorAgent: "claude-code",
		sessions: [
			{
				id: "worker-1",
				workspaceId: "project-1",
				workspaceName: "reverb-app",
				title: "Refine the top bar",
				provider: "codex",
				kind: "worker",
				branch: "codex/reverb-topbar",
				status: "working",
				updatedAt: "2026-07-28T00:00:00Z",
				prs: [],
			},
			{
				id: "orchestrator-1",
				workspaceId: "project-1",
				workspaceName: "reverb-app",
				title: "Orchestrator",
				provider: "claude-code",
				kind: "orchestrator",
				branch: "main",
				status: "working",
				updatedAt: "2026-07-28T00:00:00Z",
				prs: [],
			},
		],
	},
];

function renderModel(surfaceOverride?: ReverbTopbarSurfaceOverride) {
	return renderHook(() => useReverbTopbarModel(surfaceOverride)).result;
}

beforeEach(() => {
	navigateMock.mockReset();
	paramsMock.projectId = undefined;
	paramsMock.sessionId = undefined;
	workspaceQueryMock.mockReset().mockReturnValue({ data: workspaces });
});

describe("useReverbTopbarModel", () => {
	it("describes the global and project boards without exposing route ids", () => {
		const root = renderModel();
		expect(root.current.model.surface).toBe("global-board");
		expect(root.current.model.breadcrumbs.map((crumb) => crumb.label)).toEqual(["Board"]);

		paramsMock.projectId = "project-1";
		const project = renderModel();
		expect(project.current.model.surface).toBe("project-board");
		expect(project.current.model.breadcrumbs.map((crumb) => crumb.label)).toEqual(["Board"]);

		paramsMock.projectId = "removed-project";
		const stale = renderModel();
		expect(stale.current.model.breadcrumbs.map((crumb) => crumb.label)).toEqual(["Board"]);
		expect(JSON.stringify(stale.current.model)).not.toContain("removed-project");
	});

	it("uses a session's real project instead of a stale project route", () => {
		paramsMock.projectId = "stale-project";
		paramsMock.sessionId = "worker-1";

		const result = renderModel();

		expect(result.current.projectId).toBe("project-1");
		expect(result.current.model.surface).toBe("worker-session");
		expect(result.current.model.breadcrumbs.map((crumb) => crumb.label)).toEqual(["Refine the top bar"]);
		expect(result.current.model.breadcrumbs[0]?.onClick).toBeUndefined();
	});

	it("distinguishes Orchestrator sessions from worker sessions", () => {
		paramsMock.sessionId = "orchestrator-1";

		const result = renderModel();

		expect(result.current.isOrchestrator).toBe(true);
		expect(result.current.model.surface).toBe("orchestrator-session");
		expect(result.current.model.breadcrumbs.map((crumb) => crumb.label)).toEqual(["Orchestrator"]);
	});

	it("describes a missing session without exposing the stale route id", () => {
		paramsMock.projectId = "project-1";
		paramsMock.sessionId = "removed-session";

		const scoped = renderModel();
		expect(scoped.current.model.surface).toBe("worker-session");
		expect(scoped.current.model.breadcrumbs.map((crumb) => crumb.label)).toEqual(["Session unavailable"]);
		expect(JSON.stringify(scoped.current.model)).not.toContain("removed-session");

		paramsMock.projectId = undefined;
		const unscoped = renderModel();
		expect(unscoped.current.model.breadcrumbs.map((crumb) => crumb.label)).toEqual(["Session unavailable"]);
	});

	it.each([
		["global-settings", ["Settings"]],
		["project-settings", ["reverb-app", "Settings"]],
		["standalone-terminals", ["Reverb", "Terminals"]],
	] as const)("builds the %s route variant", (surfaceOverride, labels) => {
		paramsMock.projectId = surfaceOverride === "project-settings" ? "project-1" : undefined;

		const result = renderModel(surfaceOverride);

		expect(result.current.model.surface).toBe(surfaceOverride);
		expect(result.current.model.breadcrumbs.map((crumb) => crumb.label)).toEqual(labels);
		expect(result.current.isProjectBoardRoute).toBe(false);
		expect(result.current.isRootBoardRoute).toBe(false);
	});
});
