import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
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

vi.mock("../components/SessionsBoard", () => ({ SessionsBoard: () => <div data-testid="sessions-board" /> }));

import { Route } from "../routes/_shell.index";

const routesDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "../routes");

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

	it("does not redirect when another project exists", async () => {
		routeMocks.workspaces = [
			{ id: "scratch", name: "Scratch", kind: "scratch", path: "/scratch", sessions: [] },
			{ id: "proj-1", name: "Project One", kind: "single_repo", path: "/repo/project-one", sessions: [] },
		];

		await renderIndex();

		expect(routeMocks.navigate).not.toHaveBeenCalled();
	});

	it("keeps MigrationPopup on the shell layout so first-run redirect cannot unmount it", () => {
		// The index replace-navigates sole-scratch users to /projects/scratch.
		// MigrationPopup must live on the parent shell, not this child route.
		const indexSource = readFileSync(path.join(routesDir, "_shell.index.tsx"), "utf8");
		const shellSource = readFileSync(path.join(routesDir, "_shell.tsx"), "utf8");
		expect(indexSource).not.toMatch(/from ["'][^"']*MigrationPopup["']/);
		expect(indexSource).not.toMatch(/<MigrationPopup\b/);
		expect(shellSource).toMatch(/from ["'][^"']*MigrationPopup["']/);
		expect(shellSource).toMatch(/<MigrationPopup\s*\/>/);
	});
});
