import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { initializeRendererI18n } from "../i18n";
import type { WorkspaceSummary } from "../types/workspace";
import { OrchestratorReplacementDialog } from "./OrchestratorReplacementDialog";

const navigate = vi.fn();

vi.mock("@tanstack/react-router", async (importOriginal) => {
	const actual = await importOriginal<typeof import("@tanstack/react-router")>();
	return { ...actual, useNavigate: () => navigate };
});

const workspaces: WorkspaceSummary[] = [
	{
		id: "project-raw-id",
		name: "Raw Project",
		path: "/repo/raw-project",
		sessions: [
			{
				id: "orchestrator-raw-id",
				workspaceId: "project-raw-id",
				workspaceName: "Raw Project",
				title: "Raw Orchestrator",
				provider: "codex",
				kind: "orchestrator",
				branch: "ao/raw-branch",
				status: "working",
				updatedAt: "2026-07-17T00:00:00Z",
				prs: [],
			},
		],
	},
];

afterEach(async () => {
	navigate.mockReset();
	await initializeRendererI18n("en");
});

describe("OrchestratorReplacementDialog", () => {
	it("relocalizes its application fallback without remounting", async () => {
		render(
			<OrchestratorReplacementDialog
				projectId="project-raw-id"
				error={{ kind: "fallback" }}
				workspaces={workspaces}
				onOpenChange={() => undefined}
				onRetry={() => undefined}
			/>,
		);

		expect(screen.getByText("The project orchestrator could not be replaced.")).toBeInTheDocument();
		await act(async () => initializeRendererI18n("zh-CN"));
		expect(screen.getByText("无法替换项目协调器。")).toBeInTheDocument();
	});

	it("renders English application copy and keeps raw server detail", () => {
		render(
			<OrchestratorReplacementDialog
				projectId="project-raw-id"
				error={{ kind: "detail", detail: "raw server replacement detail" }}
				workspaces={workspaces}
				onOpenChange={() => undefined}
				onRetry={() => undefined}
			/>,
		);

		expect(screen.getByRole("dialog", { name: "Orchestrator replacement failed" })).toBeInTheDocument();
		expect(screen.getByText("raw server replacement detail")).toBeInTheDocument();
		expect(screen.getByRole("button", { name: "Open current orchestrator" })).toBeInTheDocument();
		expect(screen.getByRole("button", { name: "Retry" })).toBeInTheDocument();
	});

	it("renders Chinese application copy, preserves detail, and retries the same project", async () => {
		await initializeRendererI18n("zh-CN");
		const onRetry = vi.fn();
		render(
			<OrchestratorReplacementDialog
				projectId="project-raw-id"
				error={{ kind: "detail", detail: "raw server replacement detail" }}
				workspaces={workspaces}
				onOpenChange={() => undefined}
				onRetry={onRetry}
			/>,
		);

		expect(screen.getByRole("dialog", { name: "替换协调器失败" })).toBeInTheDocument();
		expect(screen.getByText("raw server replacement detail")).toBeInTheDocument();
		expect(screen.getByRole("button", { name: "打开当前协调器" })).toBeInTheDocument();
		await userEvent.click(screen.getByRole("button", { name: "重试" }));
		expect(onRetry).toHaveBeenCalledWith("project-raw-id");
	});
});
