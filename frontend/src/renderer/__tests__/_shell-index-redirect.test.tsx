import { act, render, waitFor } from "@testing-library/react";
import { type ComponentType } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { WorkspaceSummary } from "../types/workspace";

const routeMocks = vi.hoisted(() => ({
	navigate: vi.fn(),
	workspaces: [] as WorkspaceSummary[],
	queryState: "success" as "success" | "pending",
}));

vi.mock("@tanstack/react-router", async (importOriginal) => ({
	...(await importOriginal<typeof import("@tanstack/react-router")>()),
	createFileRoute: () => (options: unknown) => ({ options }),
	useNavigate: () => routeMocks.navigate,
}));

vi.mock("../hooks/useWorkspaceQuery", () => ({
	useWorkspaceQuery: () => ({
		data: routeMocks.workspaces,
		isSuccess: routeMocks.queryState === "success",
	}),
}));

vi.mock("../components/MigrationPopup", () => ({ MigrationPopup: () => null }));
vi.mock("../components/SessionsBoard", () => ({ SessionsBoard: () => <div data-testid="sessions-board" /> }));

import { Route } from "../routes/_shell.index";

async function renderIndex() {
	const Component = Route.options.component as ComponentType;
	await act(async () => {
		render(<Component />);
	});
}

beforeEach(() => {
	routeMocks.navigate.mockReset();
	routeMocks.workspaces = [];
	routeMocks.queryState = "success";
});

describe("shell index route", () => {
	it("redirects a first-run scratch-only workspace list to the scratch board", async () => {
		routeMocks.workspaces = [
			{
				id: "scratch",
				name: "Scratch",
				kind: "scratch",
				path: "/home/me/.ao/scratch/default",
				sessions: [],
			},
		];

		await renderIndex();

		await waitFor(() =>
			expect(routeMocks.navigate).toHaveBeenCalledWith({
				to: "/projects/$projectId",
				params: { projectId: "scratch" },
				replace: true,
			}),
		);
	});

	it("redirects to the only real project when Scratch also exists", async () => {
		routeMocks.workspaces = [
			{ id: "scratch", name: "Scratch", kind: "scratch", path: "/scratch", sessions: [] },
			{ id: "proj-1", name: "Project One", kind: "single_repo", path: "/repo/project-one", sessions: [] },
		];

		await renderIndex();

		await waitFor(() =>
			expect(routeMocks.navigate).toHaveBeenCalledWith({
				to: "/projects/$projectId",
				params: { projectId: "proj-1" },
				replace: true,
			}),
		);
	});

	it("keeps the global board when multiple real projects exist", async () => {
		routeMocks.workspaces = [
			{ id: "scratch", name: "Scratch", kind: "scratch", path: "/scratch", sessions: [] },
			{ id: "proj-1", name: "Project One", kind: "single_repo", path: "/repo/project-one", sessions: [] },
			{ id: "proj-2", name: "Project Two", kind: "single_repo", path: "/repo/project-two", sessions: [] },
		];

		await renderIndex();

		expect(routeMocks.navigate).not.toHaveBeenCalled();
	});
});
